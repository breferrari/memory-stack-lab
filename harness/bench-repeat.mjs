#!/usr/bin/env node
/**
 * Are the sweep's arms repeatable, or is every one of them a sample of size one?
 *
 *   node harness/bench-repeat.mjs <pool> <q.tsv> <label> <out.json> [runs]
 *
 * The sweep runs each arm once. That is defensible only if the arms are
 * deterministic, and "it should be deterministic" is a supposition — the same
 * kind that was already wrong twice on this corpus. An earlier repeat measured
 * one configuration at sd 0.000 over three runs, which covers that
 * configuration and nothing else.
 *
 * So: three runs each of the arms a conclusion would rest on — the shipped
 * default, the sweep's leader, the two shapes that differ, and a reranking arm,
 * since the reranker is an LLM scoring pass and has never been repeated.
 *
 * Whatever comes back decides how the sweep may be read. Identical rows mean
 * n=1 was enough; any spread means every difference smaller than it is noise.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initialize, query, startQmd, stop } from "./lib/qmd-mcp.mjs";

const [POOL, QUERIES, LABEL, OUT, RUNS = "3"] = process.argv.slice(2);
if (!POOL || !QUERIES || !OUT) { console.error("usage: bench-repeat.mjs <pool> <q.tsv> <label> <out.json> [runs]"); process.exit(1); }
const PLUGIN = process.env.VESTIGE_PLUGIN ?? resolve("..", "vestige");
process.env.VESTIGE_NO_UPDATE = "1";
const { runQmd, qmdCommand } = await import(pathToFileURL(join(PLUGIN, "core/setup/qmd.ts")).href);

const GEMMA = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
const QWEN = "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";
const RERANK_MODEL = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
const GENERATE = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";
const lex = (q) => ({ type: "lex", query: q });
const vec = (q) => ({ type: "vec", query: q });
const hyde = (q) => ({ type: "hyde", query: q });

const ARMS = {
	"gemma | lex+vec | rerank=off  (shipped default)": { emb: GEMMA, s: (q) => [lex(q), vec(q)], rr: false },
	"qwen | vec | rerank=off  (sweep leader)": { emb: QWEN, s: (q) => [vec(q)], rr: false },
	"qwen | lex+vec | rerank=off": { emb: QWEN, s: (q) => [lex(q), vec(q)], rr: false },
	"qwen | lex+vec+hyde | rerank=off": { emb: QWEN, s: (q) => [lex(q), vec(q), hyde(q)], rr: false },
	"qwen | vec | rerank=on": { emb: QWEN, s: (q) => [vec(q)], rr: true },
};

const map = JSON.parse(readFileSync(join(POOL, "_map.json"), "utf8"));
const sourceOf = new Map(Object.entries(map).filter(([, m]) => m.source).map(([id, m]) => [m.source, id]));
const byProject = {};
for (const [id, m] of Object.entries(map)) (byProject[m.project] ??= []).push(id);
const root = mkdtempSync(join(tmpdir(), "repeat-"));
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
const cmd = qmdCommand([]);
const created = [];
const build = (tag, emb) => {
	for (const proj of Object.keys(byProject)) {
		const name = `repeat-${tag}-${proj}`;
		const f = join(cfgDir, `${name}.yml`);
		writeFileSync(f, `collections:\n  memories:\n    path: '${join(root, proj)}'\n    pattern: "**/*.md"\nmodels:\n  embed: ${emb}\n  generate: ${GENERATE}\n  rerank: ${RERANK_MODEL}\n`);
		created.push(f);
		runQmd(["--index", name, "update"], { cwd: root });
		runQmd(["--index", name, "embed"], { cwd: root });
	}
};
build("gemma", GEMMA);
build("qwen", QWEN);

const results = {};
for (const [name, cfg] of Object.entries(ARMS)) {
	const tag = cfg.emb === QWEN ? "qwen" : "gemma";
	const runs = [];
	for (let r = 0; r < Number(RUNS); r++) {
		const acc = { n: 0, r1: 0, f5: 0 };
		for (const proj of Object.keys(byProject)) {
			const s = startQmd(`repeat-${tag}-${proj}`, root, cmd.cmd, cmd.argv);
			try { await initialize(s); } catch { stop(s); continue; }
			for (const row of rows.filter((x) => x.project === proj)) {
				const gold = sourceOf.get(row.key);
				if (!gold) continue;
				let hits = [];
				try { hits = (await query(s, { searches: cfg.s(row.q), intent: row.q, limit: 5, rerank: cfg.rr })).map((x) => x.replace(/\.md$/, "")); } catch { /* empty */ }
				acc.n++;
				if (hits[0] === gold) acc.r1++;
				if (hits.includes(gold)) acc.f5++;
			}
			stop(s);
		}
		runs.push({ rank1: +(acc.r1 / acc.n).toFixed(4), found_at_5: +(acc.f5 / acc.n).toFixed(4) });
	}
	const sd = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return +Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length).toFixed(4); };
	results[name] = { runs, rank1_sd: sd(runs.map((r) => r.rank1)), found5_sd: sd(runs.map((r) => r.found_at_5)) };
	process.stderr.write(`  ${name}: rank1 ${runs.map((r) => r.rank1).join(", ")}  sd ${results[name].rank1_sd}\n`);
	writeFileSync(OUT, JSON.stringify({ register: LABEL, runs: Number(RUNS), arms: results }, null, 1));
}
for (const c of created) { try { rmSync(c); } catch { /* nothing left behind */ } }
rmSync(root, { recursive: true, force: true });
const anyNoise = Object.values(results).some((r) => r.rank1_sd > 0 || r.found5_sd > 0);
writeFileSync(OUT, JSON.stringify({
	register: LABEL, runs: Number(RUNS), arms: results,
	verdict: anyNoise
		? "At least one arm varies between runs. Every sweep difference smaller than that spread is noise and must be quoted with it."
		: "Every arm reproduced exactly across runs. The sweep's single-run arms are measurements, not samples.",
}, null, 1));
console.log(readFileSync(OUT, "utf8"));
