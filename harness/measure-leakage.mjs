#!/usr/bin/env node
/**
 * Are the queries independent of the documents they are meant to find?
 *
 *   node harness/measure-leakage.mjs <pool> <q-REGISTER.tsv> [label]
 *
 * The claim this suite rests on is that queries are written from the incident
 * record and never from the memory, so a high score means retrieval works rather
 * than that the fixture told the query what to say. That claim has been ASSERTED
 * in every document here and never measured.
 *
 * It cannot be settled by "did we copy text", because both artefacts are rendered
 * from the same structured record — symptom, artefact, signal, magnitude. Blocking
 * two field names in the prompt does not block the rest of the schema. So this
 * measures the thing that would show it:
 *
 *   1. Query-to-gold overlap against query-to-sibling (same project, different
 *      incident) and query-to-other-project. Some gap is the task working. A very
 *      large gap on a register where the distinctive names were FORBIDDEN is the
 *      schema doing the work instead of the language.
 *   2. Which tokens carry it. A query matching its gold on "timeout", "stale" and
 *      "retry" is a retrieval result. One matching on `PGPOOL_MAX` and
 *      `dlq_depth` in a register that was told not to use them is leakage, and
 *      naming the tokens is the only way to tell those apart.
 *
 * Reports; never gates. What counts as too much overlap is a judgement, and a
 * threshold invented here would be the arbitrary constant this project has
 * already been caught inventing once.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const POOL = process.argv[2], QUERIES = process.argv[3], LABEL = process.argv[4] ?? basename(QUERIES ?? "");
if (!POOL || !QUERIES) { console.error("usage: measure-leakage.mjs <pool> <q-REGISTER.tsv> [label]"); process.exit(1); }

const STOP = new Set("the a an and or of to in on for with is are was were be it this that as by at from not no than then when if you your we our they their can could should would must may might do does did done have has had over under into out up down off about after before while each any all some more most other another such only same so nor own too very just also its been being had has".split(/\s+/));
const tok = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9_\s.-]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));
const jac = (a, b) => { let h = 0; for (const t of a) if (b.has(t)) h++; return h / (a.size + b.size - h || 1); };
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);

const map = JSON.parse(readFileSync(join(POOL, "_map.json"), "utf8"));
const sourceOf = new Map(Object.entries(map).filter(([, m]) => m.source).map(([id, m]) => [m.source, id]));
const text = new Map();
const rawText = new Map();
for (const f of readdirSync(POOL).filter((f) => f.endsWith(".md"))) {
	const prose = readFileSync(join(POOL, f), "utf8").replace(/^---[\s\S]*?---\n/, "").replace(/^\s*#[^\n]*\n/, "").replace(/^\s*\*\*Applies to:\*\*[^\n]*\n/, "").trim();
	text.set(f.replace(/\.md$/, ""), tok(prose));
	rawText.set(f.replace(/\.md$/, ""), prose);
}
const byProject = {};
for (const [id, m] of Object.entries(map)) (byProject[m.project] ??= []).push(id);
const allIds = Object.keys(map);

let seed = 99991;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const sample = (arr, k, not) => {
	const pool = arr.filter((x) => x !== not);
	const out = [];
	for (let i = 0; i < k && pool.length; i++) out.push(pool[Math.floor(rnd() * pool.length)]);
	return out;
};

const golds = [], sibs = [], others = [];
// The title came from the incident symptom and the opening line of the body
// often restates it, so stripping the heading may only move the leak rather
// than remove it. If the first sentence carries the symptom register, the
// overlap concentrates there.
const firstSent = [], restSent = [];
const carrying = new Map();
let scored = 0, unresolved = 0;

for (const line of readFileSync(QUERIES, "utf8").split("\n").filter(Boolean)) {
	const [proj, key, doc] = line.split("\t");
	const gold = sourceOf.get(key);
	if (!gold || !text.has(gold)) { unresolved++; continue; }
	const q = tok(doc.replace(/%%/g, " ").replace(/\b(lex|vec):\s*/g, ""));
	if (!q.size) continue;
	scored++;

	const gt = text.get(gold);
	golds.push(jac(q, gt));
	const raw = rawText.get(gold) ?? "";
	const cut = raw.search(/(?<=[.!?])\s/);
	if (cut > 0) {
		firstSent.push(jac(q, tok(raw.slice(0, cut))));
		restSent.push(jac(q, tok(raw.slice(cut))));
	}
	const sibIds = sample(byProject[proj] ?? [], 5, gold);
	sibs.push(mean(sibIds.map((id) => jac(q, text.get(id) ?? new Set()))));
	others.push(mean(sample(allIds.filter((id) => map[id].project !== proj), 5, gold).map((id) => jac(q, text.get(id) ?? new Set()))));

	// Tokens shared with the gold and absent from most same-project siblings:
	// whatever is actually separating the right document from its neighbours.
	const sibSets = sibIds.map((id) => text.get(id) ?? new Set());
	for (const t of q) {
		if (!gt.has(t)) continue;
		const inSibs = sibSets.filter((s) => s.has(t)).length;
		if (inSibs <= sibSets.length * 0.2) carrying.set(t, (carrying.get(t) ?? 0) + 1);
	}
}

console.log(JSON.stringify({
	register: LABEL,
	queries_scored: scored,
	unresolved_gold: unresolved,
	overlap: {
		query_to_gold: +mean(golds).toFixed(4),
		query_to_same_project_sibling: +mean(sibs).toFixed(4),
		query_to_other_project: +mean(others).toFixed(4),
		gold_over_sibling: +(mean(golds) / (mean(sibs) || 1)).toFixed(2),
	},
	overlap_by_position: {
		query_to_first_sentence: +mean(firstSent).toFixed(4),
		query_to_the_rest: +mean(restSent).toFixed(4),
		note: "The title derives from the incident symptom and the opening line often restates it. If the first sentence carries most of the overlap, stripping the heading moved the leak rather than removing it.",
	},
	tokens_separating_gold_from_its_siblings: [...carrying].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([t, n]) => `${t} (${n})`),
	reading: "A large gold-over-sibling ratio is what retrieval is supposed to exploit. Read the token list to see WHY: ordinary language means the query described the problem; world-schema names — config keys, metric names, service names — in a register that was forbidden to use them means the fixture told the query its answer.",
}, null, 1));
