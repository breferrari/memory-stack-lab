#!/usr/bin/env node
/**
 * Does each layer earn its place? Reach filter alone against filter plus ranking.
 *
 *   node harness/bench-layers.mjs <pool> <q-REGISTER.tsv> <label> [out.json]
 *
 * ARCHITECTURE.md claims 0.09 rank-1 with the filter and no semantic ranking,
 * against 0.98 with both. That was measured on the retired corpus, and it is the
 * argument for the whole shape of the system — so it does not get to survive on
 * an old fixture while every number around it is re-run.
 *
 * The filter-only arm is `recall`, which is what the plugin falls back to when
 * the engine is unavailable: everything the caller may see, ordered by
 * specificity and recency. The both-layers arm is `search`. Same pool, same
 * queries, same caller identity — the only difference is whether the candidate
 * set gets ranked against the question.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { proseOf } from "./lib/measure.mjs";

const [POOL, QUERIES, LABEL, OUT] = process.argv.slice(2);
if (!POOL || !QUERIES) { console.error("usage: bench-layers.mjs <pool> <q.tsv> <label> [out.json]"); process.exit(1); }
const PLUGIN = process.env.VESTIGE_PLUGIN ?? resolve("..", "vestige");
process.env.VESTIGE_NO_UPDATE = "1";
process.env.VESTIGE_HOME = mkdtempSync(join(tmpdir(), "vh-layers-"));
delete process.env.CLAUDE_PROJECT_DIR;
const { remember, recall, search } = await import(pathToFileURL(join(PLUGIN, "core/lib/vestige.ts")).href);

const map = JSON.parse(readFileSync(join(POOL, "_map.json"), "utf8"));
const sourceOf = new Map(Object.entries(map).filter(([, m]) => m.source).map(([id, m]) => [m.source, id]));
const projects = [...new Set(Object.values(map).map((m) => m.project))].sort();
const root = mkdtempSync(join(tmpdir(), "layers-"));
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

const acc = { "filter only (recall)": { n: 0, r1: 0, f5: 0, view: 0 }, "filter + ranking (search)": { n: 0, r1: 0, f5: 0, view: 0 } };
for (const line of readFileSync(QUERIES, "utf8").split("\n").filter(Boolean)) {
	const [proj, key, doc] = line.split("\t");
	const gold = sourceOf.get(key);
	if (!gold || !repoOf[proj]) continue;
	const q = doc.replace(/%%/g, " ").replace(/\b(lex|vec):\s*/g, "");

	// What the caller may see at all, in the plugin's own fallback order.
	const visible = recall({ cwd: repoOf[proj], limit: 500, noteUse: false }).map((h) => h.name.replace(/\.md$/, ""));
	const a = visible.slice(0, 5);
	const r = await search(q, { cwd: repoOf[proj], limit: 5 });
	const b = r.hits.map((h) => h.name.replace(/\.md$/, ""));

	for (const [k, hits] of [["filter only (recall)", a], ["filter + ranking (search)", b]]) {
		acc[k].n++; acc[k].view += visible.length;
		if (hits[0] === gold) acc[k].r1++;
		if (hits.includes(gold)) acc[k].f5++;
	}
}
const fmt = (k) => ({ queries: acc[k].n, rank1: acc[k].n ? +(acc[k].r1 / acc[k].n).toFixed(3) : null, found_at_5: acc[k].n ? +(acc[k].f5 / acc[k].n).toFixed(3) : null, mean_documents_visible: acc[k].n ? Math.round(acc[k].view / acc[k].n) : null });
const result = {
	register: LABEL, arms: { "filter only (recall)": fmt("filter only (recall)"), "filter + ranking (search)": fmt("filter + ranking (search)") },
	reading: "The filter decides what MAY be seen; the ranker decides which of it answers the question. mean_documents_visible is the candidate set the ranker works inside — a filter-only arm is picking five from that many by specificity and recency alone.",
};
const json = JSON.stringify(result, null, 1);
if (OUT) writeFileSync(OUT, json);
console.log(json);
