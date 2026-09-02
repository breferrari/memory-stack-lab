#!/usr/bin/env node
/**
 * Does a stronger embedding model move the number that is actually weak?
 *
 *   node harness/bench-embedder.mjs <pool> <q-REGISTER.tsv> <label> [out.json]
 *
 * Of qmd's three model slots, two have been measured and one never has. The
 * generate slot drives query expansion, which loses. The rerank slot drives the
 * cross-encoder, which changes half the shortlists and the answer in none. The
 * EMBED slot runs on every query and every chunk, is the only one that is always
 * on, and has never been varied — it has simply been qmd's default.
 *
 * qmd ships a second embedder, Qwen3-Embedding-0.6B, twice the parameters of the
 * default embeddinggemma-300M. This runs both over the same corpus, the same
 * per-project views, and the same production query path — typed sub-queries
 * through the resident session — so the embedder is the only variable.
 *
 * The prediction, recorded before the run because a prediction adjusted
 * afterwards is worthless: it will NOT help much. found@5 is already 0.93 on the
 * symptom register, so the right memory nearly always reaches the shortlist and
 * the failure is ordering inside it — and a cross-encoder reranker, which is
 * strictly stronger at ordering than any bi-encoder, moves rank-1 by exactly
 * zero across three registers. That points at the remaining errors being
 * near-duplicate siblings where one is labelled correct, not at the embedder
 * being too weak. If rank-1 moves materially here, that reasoning is wrong.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [POOL, QUERIES, LABEL, OUT] = process.argv.slice(2);
if (!POOL || !QUERIES) { console.error("usage: bench-embedder.mjs <pool> <q.tsv> <label> [out.json]"); process.exit(1); }
const PLUGIN = process.env.VESTIGE_PLUGIN ?? resolve("..", "vestige");
process.env.VESTIGE_NO_UPDATE = "1";
const { sessionQuery, shutdownQmdSession } = await import(pathToFileURL(join(PLUGIN, "core/lib/qmd-session.ts")).href);
const { runQmd } = await import(pathToFileURL(join(PLUGIN, "core/setup/qmd.ts")).href);

const MODELS = {
	"embeddinggemma-300M (default)": "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
	"Qwen3-Embedding-0.6B": "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
};
const RERANK = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
const GENERATE = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";

const map = JSON.parse(readFileSync(join(POOL, "_map.json"), "utf8"));
const sourceOf = new Map(Object.entries(map).filter(([, m]) => m.source).map(([id, m]) => [m.source, id]));
const byProject = {};
for (const [id, m] of Object.entries(map)) (byProject[m.project] ??= []).push(id);

// One directory per project: the same shape the plugin's per-caller view has.
const root = mkdtempSync(join(tmpdir(), "embtest-"));
for (const [proj, ids] of Object.entries(byProject)) {
	const d = join(root, proj);
	mkdirSync(d, { recursive: true });
	for (const id of ids) cpSync(join(POOL, `${id}.md`), join(d, `${id}.md`));
}

const rows = readFileSync(QUERIES, "utf8").split("\n").filter(Boolean).map((l) => {
	const [project, key, doc] = l.split("\t");
	return { project, key, q: doc.replace(/%%/g, " ").replace(/\b(lex|vec):\s*/g, "") };
});

const cfgDir = join(homedir(), ".config", "qmd");
const created = [];
const results = {};

for (const [label, embed] of Object.entries(MODELS)) {
	const acc = { n: 0, r1: 0, f5: 0, ms: 0 };
	for (const proj of Object.keys(byProject)) {
		const index = `embtest-${label.split(/[ (]/)[0].toLowerCase()}-${proj}`.replace(/[^a-z0-9-]/g, "");
		const cfg = join(cfgDir, `${index}.yml`);
		writeFileSync(cfg, `collections:\n  memories:\n    path: '${join(root, proj)}'\n    pattern: "**/*.md"\nmodels:\n  embed: ${embed}\n  generate: ${GENERATE}\n  rerank: ${RERANK}\n`);
		created.push(cfg);
		// Downloading a model that is not cached happens here, once, on first use.
		const u = runQmd(["--index", index, "update"], { cwd: root });
		const e = runQmd(["--index", index, "embed"], { cwd: root });
		if (!u.ok || !e.ok) { process.stderr.write(`  ${index}: index build failed\n`); continue; }
		shutdownQmdSession();
		for (const r of rows.filter((x) => x.project === proj)) {
			const gold = sourceOf.get(r.key);
			if (!gold) continue;
			const t = Date.now();
			const ids = await sessionQuery({ index, signature: label, cwd: root, query: r.q, limit: 5, rerank: false });
			acc.ms += Date.now() - t;
			const hits = (ids ?? []).map((x) => String(x).replace(/\.md$/, ""));
			acc.n++;
			if (hits[0] === gold) acc.r1++;
			if (hits.includes(gold)) acc.f5++;
		}
		shutdownQmdSession();
	}
	results[label] = { queries: acc.n, rank1: acc.n ? +(acc.r1 / acc.n).toFixed(3) : null, found_at_5: acc.n ? +(acc.f5 / acc.n).toFixed(3) : null, mean_ms: acc.n ? Math.round(acc.ms / acc.n) : null };
	process.stderr.write(`  ${label}: ${JSON.stringify(results[label])}\n`);
}

for (const c of created) { try { rmSync(c); } catch { /* leave no config behind */ } }
rmSync(root, { recursive: true, force: true });

const names = Object.keys(results);
const out = {
	register: LABEL, arms: results,
	rank1_delta: names.length === 2 && results[names[1]].rank1 != null ? +(results[names[1]].rank1 - results[names[0]].rank1).toFixed(3) : null,
	found5_delta: names.length === 2 && results[names[1]].found_at_5 != null ? +(results[names[1]].found_at_5 - results[names[0]].found_at_5).toFixed(3) : null,
	prediction: "Recorded before the run: a stronger embedder will not move rank-1 much, because found@5 is already high and a cross-encoder reranker — strictly stronger at ordering — moves it by zero. A material gain would falsify that.",
};
const json = JSON.stringify(out, null, 1);
if (OUT) writeFileSync(OUT, json);
console.log(json);
