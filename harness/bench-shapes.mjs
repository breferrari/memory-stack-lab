#!/usr/bin/env node
/**
 * Every sub-query shape qmd supports, on one index, to find the best one.
 *
 *   node harness/bench-shapes.mjs <pool> <q-REGISTER.tsv> <label> [out.json]
 *
 * qmd's own skill says: "Default to structured query with intent:, lex:, vec:
 * and hyde:" and "Do not lean on query expansion — write them yourself." This
 * project sends lex + vec and nothing else, and had conflated two different
 * things: AUTO-expansion, where a model writes the hypothetical document and the
 * ranking moves between runs, and an AUTHORED hyde sub-query, which is caller
 * text and deterministic. The first was measured and rejected. The second has
 * never been tried.
 *
 * Documented and unused too: the first sub-query carries 2x weight, so the ORDER
 * is a variable, and nobody here has checked whether lexical or semantic
 * deserves that weight on this corpus.
 *
 * One index, one embedder, reranking off, limit 5 everywhere. The only variable
 * is the shape of the call.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initialize, query, startQmd, stop } from "./lib/qmd-mcp.mjs";

const [POOL, QUERIES, LABEL, OUT] = process.argv.slice(2);
if (!POOL || !QUERIES) { console.error("usage: bench-shapes.mjs <pool> <q.tsv> <label> [out.json]"); process.exit(1); }
const PLUGIN = process.env.VESTIGE_PLUGIN ?? resolve("..", "vestige");
process.env.VESTIGE_NO_UPDATE = "1";
const { runQmd, qmdCommand } = await import(pathToFileURL(join(PLUGIN, "core/setup/qmd.ts")).href);

// The better of the two embedders qmd ships, measured on all three registers.
const EMBED = "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";
const RERANK = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
const GENERATE = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";

/** `q` is the caller's question. A hyde passage is authored from it, not generated. */
const SHAPES = {
	"lex + vec  (current default)": (q) => ({ searches: [{ type: "lex", query: q }, { type: "vec", query: q }], intent: q }),
	"vec + lex  (2x weight on semantic)": (q) => ({ searches: [{ type: "vec", query: q }, { type: "lex", query: q }], intent: q }),
	"lex + vec + hyde  (qmd's recommendation)": (q) => ({ searches: [{ type: "lex", query: q }, { type: "vec", query: q }, { type: "hyde", query: q }], intent: q }),
	"lex only": (q) => ({ searches: [{ type: "lex", query: q }], intent: q }),
	"vec only": (q) => ({ searches: [{ type: "vec", query: q }], intent: q }),
	"lex + vec, no intent": (q) => ({ searches: [{ type: "lex", query: q }, { type: "vec", query: q }] }),
};

const map = JSON.parse(readFileSync(join(POOL, "_map.json"), "utf8"));
const sourceOf = new Map(Object.entries(map).filter(([, m]) => m.source).map(([id, m]) => [m.source, id]));
const byProject = {};
for (const [id, m] of Object.entries(map)) (byProject[m.project] ??= []).push(id);

const root = mkdtempSync(join(tmpdir(), "shapes-"));
for (const [proj, ids] of Object.entries(byProject)) {
	const d = join(root, proj);
	mkdirSync(d, { recursive: true });
	for (const id of ids) cpSync(join(POOL, `${id}.md`), join(d, `${id}.md`));
}
const cfgDir = join(homedir(), ".config", "qmd");
const created = [];
for (const proj of Object.keys(byProject)) {
	const name = `shapes-${proj}`;
	const f = join(cfgDir, `${name}.yml`);
	writeFileSync(f, `collections:\n  memories:\n    path: '${join(root, proj)}'\n    pattern: "**/*.md"\nmodels:\n  embed: ${EMBED}\n  generate: ${GENERATE}\n  rerank: ${RERANK}\n`);
	created.push(f);
	runQmd(["--index", name, "update"], { cwd: root });
	runQmd(["--index", name, "embed"], { cwd: root });
}

const rows = readFileSync(QUERIES, "utf8").split("\n").filter(Boolean).map((l) => {
	const [project, key, doc] = l.split("\t");
	return { project, key, q: doc.replace(/%%/g, " ").replace(/\b(lex|vec):\s*/g, "") };
});

const cmd = qmdCommand([]);
const results = {};
for (const [name, build] of Object.entries(SHAPES)) {
	const acc = { n: 0, r1: 0, f5: 0, ms: 0, empty: 0 };
	for (const proj of Object.keys(byProject)) {
		const s = startQmd(`shapes-${proj}`, root, cmd.cmd, cmd.argv);
		try { await initialize(s); } catch { stop(s); continue; }
		for (const r of rows.filter((x) => x.project === proj)) {
			const gold = sourceOf.get(r.key);
			if (!gold) continue;
			const t = Date.now();
			let hits = [];
			try { hits = (await query(s, { ...build(r.q), limit: 5, rerank: false })).map((x) => x.replace(/\.md$/, "")); } catch { /* counted as empty */ }
			acc.ms += Date.now() - t;
			acc.n++;
			if (!hits.length) acc.empty++;
			if (hits[0] === gold) acc.r1++;
			if (hits.includes(gold)) acc.f5++;
		}
		stop(s);
	}
	const d = (x) => (acc.n ? +(x / acc.n).toFixed(3) : null);
	results[name] = { queries: acc.n, rank1: d(acc.r1), found_at_5: d(acc.f5), returned_nothing: acc.empty, mean_ms: acc.n ? Math.round(acc.ms / acc.n) : null };
	process.stderr.write(`  ${name}: rank1 ${results[name].rank1} found@5 ${results[name].found_at_5} ${results[name].mean_ms}ms\n`);
}

for (const c of created) { try { rmSync(c); } catch { /* leave nothing behind */ } }
rmSync(root, { recursive: true, force: true });
const best = Object.entries(results).filter(([, v]) => v.rank1 != null).sort((a, b) => (b[1].rank1 - a[1].rank1) || (b[1].found_at_5 - a[1].found_at_5))[0];
const out = { register: LABEL, embedder: EMBED, arms: results, best_by_rank1: best?.[0] ?? null };
const json = JSON.stringify(out, null, 1);
if (OUT) writeFileSync(OUT, json);
console.log(json);
