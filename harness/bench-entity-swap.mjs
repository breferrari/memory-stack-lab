#!/usr/bin/env node
/**
 * The counterfactual that can falsify "the queries are independent".
 *
 *   node harness/bench-entity-swap.mjs <world.json> <corpus> <q-REGISTER.tsv> <label> [out.json]
 *
 * Every other check here can only fail to find leakage. Overlap ratios and token
 * lists say which channel carries a match; neither can say the match would have
 * happened anyway. This breaks the shared record WITHOUT breaking the incident,
 * and asks whether the query still finds its document.
 *
 * Each memory keeps its prose. The entities it inherited from the incident
 * record — artefact, metric name, magnitude, config key, library — are replaced
 * with those of a DIFFERENT incident in the same project. The queries are
 * unchanged, so the gold no longer contains the facts the query was written from
 * while remaining the same narrative about the same event.
 *
 * How to read it:
 *
 *   rank-1 collapses      the query was finding its document THROUGH those
 *                         facts. That is retrieval doing its job.
 *   rank-1 barely moves   the query finds its document by something that
 *                         survived the swap — shared phrasing, structure, one
 *                         generator's idiolect. That is fixture residue, and the
 *                         score is partly measuring the generator.
 *
 * The registers are expected to differ and are run separately. `identifier`
 * pastes the artefact by design and SHOULD collapse; a collapse there is a
 * control confirming the swap landed. `symptom` was forbidden those words, so it
 * is the register where a non-collapse is informative rather than obvious.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { proseOf } from "./lib/measure.mjs";

const [WORLD, CORPUS, QUERIES, LABEL, OUT] = process.argv.slice(2);
if (!WORLD || !CORPUS || !QUERIES) { console.error("usage: bench-entity-swap.mjs <world.json> <corpus> <q.tsv> <label> [out.json]"); process.exit(1); }
const PLUGIN = process.env.VESTIGE_PLUGIN ?? join(process.cwd(), "..", "vestige");
process.env.VESTIGE_NO_UPDATE = "1";
process.env.VESTIGE_HOME = mkdtempSync(join(tmpdir(), "vh-swap-"));
delete process.env.CLAUDE_PROJECT_DIR;
const { remember, search } = await import(pathToFileURL(join(PLUGIN, "core/lib/vestige.ts")).href);

const world = JSON.parse(readFileSync(WORLD, "utf8"));
const byProject = {};
for (const m of world.memories) (byProject[m.project] ??= []).push(m);

/** Whole-word, case-insensitive, longest-first so a substring cannot pre-empt a longer name. */
const swapIn = (text, pairs) => {
	let out = text;
	for (const [from, to] of [...pairs].filter(([f]) => f && f.length > 2).sort((a, b) => b[0].length - a[0].length)) {
		out = out.replaceAll(from, to);
		const lower = from.toLowerCase();
		if (lower !== from) out = out.replaceAll(lower, to.toLowerCase());
	}
	return out;
};

const buildPool = (swap) => {
	const root = mkdtempSync(join(tmpdir(), swap ? "swapped-" : "control-"));
	const repoOf = {};
	for (const p of Object.keys(byProject)) {
		const d = join(root, p);
		mkdirSync(d, { recursive: true });
		execFileSync("git", ["init", "-q", d]);
		repoOf[p] = d;
	}
	const docOf = new Map();
	let landed = 0, swapped = 0;
	for (const m of world.memories) {
		let md;
		try { md = readFileSync(join(CORPUS, `${m.id}.md`), "utf8"); } catch { continue; }
		const title = (md.match(/^# (.+?)(?: — [a-z0-9-]+)?$/m) ?? [])[1] ?? m.id;
		let body = proseOf(md);
		if (swap) {
			// A donor from the same project and a different incident, so the swap
			// changes the facts without changing who the memory is for.
			const donor = (byProject[m.project] ?? []).find((o) => o.incident !== m.incident);
			if (donor) {
				const before = body;
				body = swapIn(body, [[m.artefact, donor.artefact], [m.signal, donor.signal], [m.magnitude, donor.magnitude], [m.configKey, donor.configKey], [m.lib, donor.lib]]);
				if (body !== before) swapped++;
			}
		}
		const r = remember({ title, body, confidence: "inferred", scope: "project", projects: [m.project] }, { cwd: repoOf[m.project] });
		if (r.ok) { landed++; docOf.set(m.id, r.rel.replace(/\.md$/, "")); }
	}
	return { repoOf, docOf, landed, swapped };
};

const run = async (pool) => {
	let n = 0, rank1 = 0, found5 = 0;
	for (const line of readFileSync(QUERIES, "utf8").split("\n").filter(Boolean)) {
		const [proj, key, doc] = line.split("\t");
		const gold = pool.docOf.get(key);
		if (!gold || !pool.repoOf[proj]) continue;
		const q = doc.replace(/%%/g, " ").replace(/\b(lex|vec):\s*/g, "");
		const r = await search(q, { cwd: pool.repoOf[proj], limit: 5 });
		const ids = r.hits.map((h) => h.name.replace(/\.md$/, ""));
		n++;
		if (ids[0] === gold) rank1++;
		if (ids.includes(gold)) found5++;
	}
	return { queries: n, rank1: n ? +(rank1 / n).toFixed(3) : null, found_at_5: n ? +(found5 / n).toFixed(3) : null };
};

// The control is rebuilt rather than reused, so both arms pay the same write and
// index path and differ only in the swap.
const control = await run(buildPool(false));
const swappedPool = buildPool(true);
const swapped = await run(swappedPool);

const drop = control.rank1 && swapped.rank1 !== null ? +(control.rank1 - swapped.rank1).toFixed(3) : null;
const result = {
	register: LABEL,
	memories_whose_entities_changed: swappedPool.swapped,
	control, swapped,
	rank1_drop: drop,
	reading: "A large drop means the query was finding its document through the facts it was written from, which is retrieval working. A small drop means something that survived the swap is carrying the match — shared phrasing or one generator's idiolect — and the score is partly measuring the fixture. The identifier register is the control: it pastes the artefact by design and should collapse.",
};
const json = JSON.stringify(result, null, 1);
if (OUT) writeFileSync(OUT, json);
console.log(json);
