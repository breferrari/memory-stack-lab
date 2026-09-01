#!/usr/bin/env node
/**
 * Why is found@5 twice as high here as on the other stack's per-project arm?
 *
 *   node harness/bench-query-path.mjs <pool> <q-REGISTER.tsv> <label> [out.json]
 *
 * Both use qmd, both index per project, both ask for five results, and both
 * embed with the same model — so the reach model cannot be the explanation on
 * that arm, and the record must not imply it is. The remaining difference is how
 * the query reaches the engine:
 *
 *   typed-session   the resident MCP server, given explicit sub-queries:
 *                   searches [{lex}, {vec}] plus a separate intent.
 *   structured-cli  a fresh CLI process per query, given ONE string:
 *                   "intent: q\nlex: q\nvec: q", which the SDK auto-expands.
 *
 * This project's own CLI fallback uses the second shape, so the two paths sit
 * side by side in one codebase and have never been compared on one index.
 *
 * ONE index, built once, queried both ways. Same documents, same model, same
 * limit, reranking off in both. If the gap reproduces here it is the query path;
 * if it does not, the explanation is in the view or the index and the record
 * should say so rather than guess.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { proseOf } from "./lib/measure.mjs";

const [POOL, QUERIES, LABEL, OUT] = process.argv.slice(2);
if (!POOL || !QUERIES) { console.error("usage: bench-query-path.mjs <pool> <q.tsv> <label> [out.json]"); process.exit(1); }
const PLUGIN = process.env.VESTIGE_PLUGIN ?? resolve("..", "vestige");
process.env.VESTIGE_NO_UPDATE = "1";
process.env.VESTIGE_HOME = mkdtempSync(join(tmpdir(), "vh-path-"));
delete process.env.CLAUDE_PROJECT_DIR;

const { remember } = await import(pathToFileURL(join(PLUGIN, "core/lib/vestige.ts")).href);
const { ensureIndex } = await import(pathToFileURL(join(PLUGIN, "core/lib/index-view.ts")).href);
const { sessionQuery } = await import(pathToFileURL(join(PLUGIN, "core/lib/qmd-session.ts")).href);
const { runQmd } = await import(pathToFileURL(join(PLUGIN, "core/setup/qmd.ts")).href);

const map = JSON.parse(readFileSync(join(POOL, "_map.json"), "utf8"));
const sourceOf = new Map(Object.entries(map).filter(([, m]) => m.source).map(([id, m]) => [m.source, id]));
const projects = [...new Set(Object.values(map).map((m) => m.project))].sort();

const root = mkdtempSync(join(tmpdir(), "path-repos-"));
const repoOf = {};
for (const p of projects) {
	const d = join(root, p);
	mkdirSync(d, { recursive: true });
	execFileSync("git", ["init", "-q", d]);
	repoOf[p] = d;
}
for (const [id, meta] of Object.entries(map)) {
	const md = readFileSync(join(POOL, `${id}.md`), "utf8");
	const title = (md.match(/^# (.+)$/m) ?? [])[1] ?? id;
	remember({ title, body: proseOf(md), confidence: "inferred", scope: "project", projects: [meta.project] }, { cwd: repoOf[meta.project] });
}

const rows = readFileSync(QUERIES, "utf8").split("\n").filter(Boolean).map((l) => {
	const [project, key, doc] = l.split("\t");
	return { project, key, q: doc.replace(/%%/g, " ").replace(/\b(lex|vec):\s*/g, "") };
});

const score = (hits, gold) => ({ r1: hits[0] === gold ? 1 : 0, f5: hits.includes(gold) ? 1 : 0 });
const acc = { "typed-session": { n: 0, r1: 0, f5: 0, ms: 0 }, "structured-cli": { n: 0, r1: 0, f5: 0, ms: 0 } };
let skipped = 0;

for (const r of rows) {
	const gold = sourceOf.get(r.key);
	if (!gold) { skipped++; continue; }
	// One index per caller, built once and shared by BOTH arms — the single
	// variable is how the query is delivered to it.
	const idx = ensureIndex({ cwd: repoOf[r.project] });
	if (!idx.ok || !idx.index || !idx.dir) { skipped++; continue; }

	let t = Date.now();
	const ids = await sessionQuery({ index: idx.index, signature: idx.signature ?? "", cwd: idx.dir, query: r.q, limit: 5, rerank: false });
	const a = (ids ?? []).map((x) => String(x).replace(/\.md$/, ""));
	const aMs = Date.now() - t;

	t = Date.now();
	const structured = `intent: ${r.q}\nlex: ${r.q}\nvec: ${r.q}`;
	const out = runQmd(["--index", idx.index, "query", structured, "-n", "5", "--no-rerank", "--format", "files"], { cwd: idx.dir });
	// The plugin's own parser, copied rather than rewritten. A regex invented
	// here that failed to match would score this arm zero and look like a
	// finding — which is how two false results were produced earlier tonight.
	const b = out.ok
		? [...String(out.stdout).matchAll(/qmd:\/\/[^/]+\/([^\s:,?]+\.md)/g)].map((m) => m[1].replace(/\.md$/, "")).slice(0, 5)
		: [];
	const bMs = Date.now() - t;

	for (const [name, hits, ms] of [["typed-session", a, aMs], ["structured-cli", b, bMs]]) {
		const s = score(hits, gold);
		acc[name].n++; acc[name].r1 += s.r1; acc[name].f5 += s.f5; acc[name].ms += ms;
	}
}

const fmt = (k) => ({ queries: acc[k].n, rank1: acc[k].n ? +(acc[k].r1 / acc[k].n).toFixed(3) : null, found_at_5: acc[k].n ? +(acc[k].f5 / acc[k].n).toFixed(3) : null, mean_ms: acc[k].n ? Math.round(acc[k].ms / acc[k].n) : null });
const result = {
	register: LABEL, skipped,
	arms: { "typed-session": fmt("typed-session"), "structured-cli": fmt("structured-cli") },
	reading: "One index, one corpus, one model, reranking off in both. If the two arms differ, the query path explains part of the gap against the other stack's per-project configuration — which uses the structured-cli shape. If they agree, the gap is in the view or the index and this record must say so instead of implying the reach model earns it.",
};
// A silent zero is the failure mode this whole run keeps producing. If an arm
// never returned a single hit, it is broken, and saying so is more useful than
// a number.
for (const [name, a] of Object.entries(result.arms)) {
	if (a.queries && a.found_at_5 === 0) result.reading = `ARM "${name}" returned no correct document on ANY query — treat this as a broken arm, not a result, until its parsing is checked. ${result.reading}`;
}
const json = JSON.stringify(result, null, 1);
if (OUT) writeFileSync(OUT, json);
console.log(json);
