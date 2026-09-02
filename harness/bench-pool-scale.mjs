#!/usr/bin/env node
/**
 * Does the cost of a shared pool grow with the number of projects in it?
 *
 *   node harness/bench-pool-scale.mjs <corpus> <world.json> <q.tsv> <out.json>
 *
 * The claim is "declared reach beats a shared pool once you have more than one
 * project". It has been demonstrated at exactly one point — eight services, 183
 * documents — which shows the effect exists and says nothing about whether it
 * matters at two projects or at eighty. A claim with "once you have more than
 * one" in it needs a curve, not a point.
 *
 * The curve is measurable from the corpus that already exists. Hold the caller
 * and the query fixed, and vary only how many OTHER projects' memories share the
 * index: k = 0 is the reach model's per-caller view, k = 7 is the full shared
 * pool. Same documents, same engine, same embedder, same queries throughout —
 * the only thing moving is how much company the right answer has.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initialize, query, startQmd, stop } from "./lib/qmd-mcp.mjs";

const [CORPUS, WORLD, QUERIES, OUT] = process.argv.slice(2);
if (!CORPUS || !WORLD || !QUERIES || !OUT) { console.error("usage: bench-pool-scale.mjs <corpus> <world.json> <q.tsv> <out.json>"); process.exit(1); }
const PLUGIN = process.env.VESTIGE_PLUGIN ?? resolve("..", "vestige");
process.env.VESTIGE_NO_UPDATE = "1";
const { runQmd, qmdCommand } = await import(pathToFileURL(join(PLUGIN, "core/setup/qmd.ts")).href);
const EMBED = "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";
const RRM = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
const GEN = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";

const world = JSON.parse(readFileSync(WORLD, "utf8"));
const byProject = {};
for (const m of world.memories) (byProject[m.project] ??= []).push(m.id);
const services = Object.keys(byProject).sort();
const rows = readFileSync(QUERIES, "utf8").split("\n").filter(Boolean).map((l) => {
	const [project, key, doc] = l.split("\t");
	return { project, key, q: doc.replace(/%%/g, " ").replace(/\b(lex|vec):\s*/g, "") };
});
const cfgDir = join(homedir(), ".config", "qmd");
const cmd = qmdCommand([]);
const results = {};

for (const k of [0, 1, 2, 4, 7]) {
	const root = mkdtempSync(join(tmpdir(), `poolscale-${k}-`));
	const created = [];
	const sizes = [];
	for (const [i, s] of services.entries()) {
		const d = join(root, s);
		mkdirSync(d, { recursive: true });
		// The caller's own memories, plus k other projects' — chosen by rotation
		// so every service gets a different set and no single pairing decides it.
		const others = Array.from({ length: k }, (_, j) => services[(i + 1 + j) % services.length]);
		for (const src of [s, ...others]) for (const id of byProject[src]) cpSync(join(CORPUS, `${id}.md`), join(d, `${id}.md`));
		sizes.push(byProject[s].length + others.reduce((a, o) => a + byProject[o].length, 0));
		const name = `poolscale-${k}-${s}`;
		const f = join(cfgDir, `${name}.yml`);
		writeFileSync(f, `collections:\n  memories:\n    path: '${d}'\n    pattern: "**/*.md"\nmodels:\n  embed: ${EMBED}\n  generate: ${GEN}\n  rerank: ${RRM}\n`);
		created.push(f);
		runQmd(["--index", name, "update"], { cwd: root });
		runQmd(["--index", name, "embed"], { cwd: root });
	}
	const acc = { n: 0, r1: 0, f5: 0 };
	for (const s of services) {
		const sess = startQmd(`poolscale-${k}-${s}`, root, cmd.cmd, cmd.argv);
		try { await initialize(sess); } catch { stop(sess); continue; }
		for (const r of rows.filter((x) => x.project === s)) {
			const hits = (await query(sess, { searches: [{ type: "lex", query: r.q }, { type: "vec", query: r.q }], intent: r.q, limit: 5, rerank: false })).map((x) => x.replace(/\.md$/, ""));
			acc.n++;
			if (hits[0] === r.key) acc.r1++;
			if (hits.includes(r.key)) acc.f5++;
		}
		stop(sess);
	}
	for (const c of created) { try { rmSync(c); } catch { /* nothing left */ } }
	rmSync(root, { recursive: true, force: true });
	const label = k === 0 ? "0 (the reach model's view)" : `${k}`;
	results[label] = {
		other_projects_sharing_the_index: k,
		mean_documents_searched: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
		queries: acc.n, rank1: +(acc.r1 / acc.n).toFixed(4), found_at_5: +(acc.f5 / acc.n).toFixed(4),
	};
	process.stderr.write(`  k=${k}: ${results[label].mean_documents_searched} docs -> rank1 ${results[label].rank1} found@5 ${results[label].found_at_5}\n`);
	writeFileSync(OUT, JSON.stringify({ arms: results }, null, 1));
}
writeFileSync(OUT, JSON.stringify({
	arms: results,
	reading: "Only the number of other projects sharing the index changes. k=0 is what a per-caller view searches; k=7 is the full shared pool. If the curve is flat, scoping is worth little and the claim should be dropped; if it falls, the claim has a slope rather than a single point.",
}, null, 1));
console.log(readFileSync(OUT, "utf8"));
