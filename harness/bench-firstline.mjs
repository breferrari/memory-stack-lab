#!/usr/bin/env node
/**
 * How much of the symptom register's score is the opening sentence?
 *
 *   node harness/bench-firstline.mjs <pool> <q.tsv> <label> <out.json>
 *
 * The queries and the memories are both rendered from one canonical symptom
 * sentence. Overlap concentrates 3.3x in each memory's first line, and swapping
 * every incident IDENTIFIER out of the gold moved the symptom register by
 * nothing — so the match is not running on the identifiers. This measures what
 * it IS running on, by deleting it.
 *
 * Four indexes over the same memories, differing only in what text is fed to the
 * engine:
 *
 *   as shipped         the raw file, exactly what the product indexes: hardlinked
 *                      markdown including frontmatter and the title
 *   prose only         no frontmatter, no title, no Applies-to line
 *   minus first line   prose with its opening sentence removed
 *   minus first para   prose with its opening paragraph removed
 *
 * The shipped arm matters on its own: the frontmatter carries a `description`
 * derived from the body's first sentence in 181 of 183 files, and the title is
 * the incident symptom. So the product indexes that sentence up to three times,
 * and the corpus gate never measured any of it — it profiled prose.
 *
 * A large fall from "as shipped" to "minus first line" means the register is
 * paraphrase-matching an opening, not retrieving engineering content.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initialize, query, startQmd, stop } from "./lib/qmd-mcp.mjs";

const [POOL, QUERIES, LABEL, OUT] = process.argv.slice(2);
if (!POOL || !QUERIES || !OUT) { console.error("usage: bench-firstline.mjs <pool> <q.tsv> <label> <out.json>"); process.exit(1); }
const PLUGIN = process.env.VESTIGE_PLUGIN ?? resolve("..", "vestige");
process.env.VESTIGE_NO_UPDATE = "1";
const { runQmd, qmdCommand } = await import(pathToFileURL(join(PLUGIN, "core/setup/qmd.ts")).href);
const EMBED = "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";
const RRM = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
const GEN = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";

const proseOf = (t) => t.replace(/^---[\s\S]*?---\n/, "").replace(/^\s*#[^\n]*\n/, "").replace(/^\s*\*\*Applies to:\*\*[^\n]*\n/, "").trim();
const VARIANTS = {
	"as shipped (raw file, frontmatter + title)": (t) => t,
	"prose only": (t) => proseOf(t),
	"prose minus the first sentence": (t) => { const p = proseOf(t); const c = p.search(/(?<=[.!?])\s/); return c > 0 ? p.slice(c).trim() : p; },
	"prose minus the first paragraph": (t) => { const p = proseOf(t); const c = p.indexOf("\n\n"); return c > 0 ? p.slice(c).trim() : p; },
};

const map = JSON.parse(readFileSync(join(POOL, "_map.json"), "utf8"));
const sourceOf = new Map(Object.entries(map).filter(([, m]) => m.source).map(([id, m]) => [m.source, id]));
const byProject = {};
for (const [id, m] of Object.entries(map)) (byProject[m.project] ??= []).push(id);
const rows = readFileSync(QUERIES, "utf8").split("\n").filter(Boolean).map((l) => {
	const [project, key, doc] = l.split("\t");
	return { project, key, q: doc.replace(/%%/g, " ").replace(/\b(lex|vec):\s*/g, "") };
});
const cfgDir = join(homedir(), ".config", "qmd");
const cmd = qmdCommand([]);
const results = {};

for (const [vname, transform] of Object.entries(VARIANTS)) {
	const tag = `fl${Object.keys(VARIANTS).indexOf(vname)}`;
	const root = mkdtempSync(join(tmpdir(), `firstline-${tag}-`));
	const created = [];
	for (const [proj, ids] of Object.entries(byProject)) {
		const d = join(root, proj);
		mkdirSync(d, { recursive: true });
		for (const id of ids) writeFileSync(join(d, `${id}.md`), transform(readFileSync(join(POOL, `${id}.md`), "utf8")));
		const name = `firstline-${tag}-${proj}`;
		const f = join(cfgDir, `${name}.yml`);
		writeFileSync(f, `collections:\n  memories:\n    path: '${d}'\n    pattern: "**/*.md"\nmodels:\n  embed: ${EMBED}\n  generate: ${GEN}\n  rerank: ${RRM}\n`);
		created.push(f);
		runQmd(["--index", name, "update"], { cwd: root });
		runQmd(["--index", name, "embed"], { cwd: root });
	}
	const out = [];
	for (const proj of Object.keys(byProject)) {
		const s = startQmd(`firstline-${tag}-${proj}`, root, cmd.cmd, cmd.argv);
		try { await initialize(s); } catch { stop(s); continue; }
		for (const r of rows.filter((x) => x.project === proj)) {
			const gold = sourceOf.get(r.key);
			if (!gold) continue;
			let hits = [];
			try { hits = (await query(s, { searches: [{ type: "lex", query: r.q }, { type: "vec", query: r.q }], intent: r.q, limit: 5, rerank: false })).map((x) => x.replace(/\.md$/, "")); } catch { /* miss */ }
			out.push({ r1: hits[0] === gold ? 1 : 0, f5: hits.includes(gold) ? 1 : 0 });
		}
		stop(s);
	}
	for (const c of created) { try { rmSync(c); } catch { /* nothing left */ } }
	rmSync(root, { recursive: true, force: true });
	const n = out.length;
	results[vname] = { queries: n, rank1: +(out.reduce((a, b) => a + b.r1, 0) / n).toFixed(4), found_at_5: +(out.reduce((a, b) => a + b.f5, 0) / n).toFixed(4), outcomes: out.map((x) => x.r1) };
	process.stderr.write(`  ${vname}: rank1 ${results[vname].rank1} found@5 ${results[vname].found_at_5}\n`);
	writeFileSync(OUT, JSON.stringify({ register: LABEL, variants: results }, null, 1));
}

// McNemar against the shipped arm: how many queries does deleting the opening cost?
const logC = (n, k) => { let s = 0; for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i); return s; };
const mc = (a, b) => { let n01 = 0, n10 = 0; for (let i = 0; i < a.length; i++) { if (a[i] === 0 && b[i] === 1) n01++; else if (a[i] === 1 && b[i] === 0) n10++; } const n = n01 + n10; if (!n) return { p: 1, lost: 0, gained: 0 }; const k = Math.min(n01, n10); let p = 0; for (let i = 0; i <= k; i++) p += Math.exp(logC(n, i) - n * Math.LN2); return { lost: n10, gained: n01, p: +Math.min(1, 2 * p).toFixed(5) }; };
const base = results["as shipped (raw file, frontmatter + title)"].outcomes;
const paired = {};
for (const [k, v] of Object.entries(results)) if (v.outcomes !== base) paired[`as shipped vs ${k}`] = mc(base, v.outcomes);
for (const v of Object.values(results)) delete v.outcomes;
writeFileSync(OUT, JSON.stringify({ register: LABEL, variants: results, paired_vs_shipped: paired }, null, 1));
console.log(readFileSync(OUT, "utf8"));
