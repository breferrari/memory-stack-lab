#!/usr/bin/env node
/**
 * Per-query outcomes, so a difference can be tested instead of eyeballed.
 *
 *   node harness/bench-paired.mjs <pool> <out.json> <q1.tsv> [q2.tsv ...]
 *
 * The repeat check found every arm reproduces with sd 0.000 across runs. That
 * establishes DETERMINISM and nothing else — it is not precision, and it does
 * not make a difference real. rank-1 is a mean of Bernoulli draws over queries,
 * so the uncertainty that matters is sampling over QUERIES, and three identical
 * runs of the same 183 labels will always give sd 0 no matter how few queries
 * separate two arms. A 0.03 gap on 183 queries is about five of them.
 *
 * So: one run per arm (they are deterministic), per-query hit/miss recorded, and
 * then the tests that fit paired binary outcomes on identical inputs —
 * McNemar's exact test on the discordant pairs, and a bootstrap interval over
 * queries for each arm.
 *
 * Registers are pooled as well as reported separately, because 549 queries has
 * power that 183 does not.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initialize, query, startQmd, stop } from "./lib/qmd-mcp.mjs";

const [POOL, OUT, ...QFILES] = process.argv.slice(2);
if (!POOL || !OUT || !QFILES.length) { console.error("usage: bench-paired.mjs <pool> <out.json> <q1.tsv> [...]"); process.exit(1); }
const PLUGIN = process.env.VESTIGE_PLUGIN ?? resolve("..", "vestige");
process.env.VESTIGE_NO_UPDATE = "1";
const { runQmd, qmdCommand } = await import(pathToFileURL(join(PLUGIN, "core/setup/qmd.ts")).href);

const GEMMA = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
const QWEN = "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";
const RR = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
const GEN = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";
const lex = (q) => ({ type: "lex", query: q });
const vec = (q) => ({ type: "vec", query: q });
const hyde = (q) => ({ type: "hyde", query: q });
const ARMS = {
	"gemma lex+vec (shipped)": { emb: GEMMA, s: (q) => [lex(q), vec(q)] },
	"qwen lex+vec": { emb: QWEN, s: (q) => [lex(q), vec(q)] },
	"qwen vec": { emb: QWEN, s: (q) => [vec(q)] },
	"qwen lex+vec+hyde": { emb: QWEN, s: (q) => [lex(q), vec(q), hyde(q)] },
};

const map = JSON.parse(readFileSync(join(POOL, "_map.json"), "utf8"));
const sourceOf = new Map(Object.entries(map).filter(([, m]) => m.source).map(([id, m]) => [m.source, id]));
const byProject = {};
for (const [id, m] of Object.entries(map)) (byProject[m.project] ??= []).push(id);
const root = mkdtempSync(join(tmpdir(), "paired-"));
for (const [proj, ids] of Object.entries(byProject)) {
	const d = join(root, proj);
	mkdirSync(d, { recursive: true });
	for (const id of ids) cpSync(join(POOL, `${id}.md`), join(d, `${id}.md`));
}
const cfgDir = join(homedir(), ".config", "qmd");
const created = [];
for (const [tag, emb] of [["gemma", GEMMA], ["qwen", QWEN]]) {
	for (const proj of Object.keys(byProject)) {
		const name = `paired-${tag}-${proj}`;
		const f = join(cfgDir, `${name}.yml`);
		writeFileSync(f, `collections:\n  memories:\n    path: '${join(root, proj)}'\n    pattern: "**/*.md"\nmodels:\n  embed: ${emb}\n  generate: ${GEN}\n  rerank: ${RR}\n`);
		created.push(f);
		runQmd(["--index", name, "update"], { cwd: root });
		runQmd(["--index", name, "embed"], { cwd: root });
	}
}

const rows = [];
for (const qf of QFILES) {
	const reg = (qf.match(/q-([a-z]+)\.tsv$/) ?? [, qf])[1];
	for (const l of readFileSync(qf, "utf8").split("\n").filter(Boolean)) {
		const [project, key, doc] = l.split("\t");
		rows.push({ reg, project, key, q: doc.replace(/%%/g, " ").replace(/\b(lex|vec):\s*/g, "") });
	}
}
const cmd = qmdCommand([]);
const outcomes = {};
for (const [name, cfg] of Object.entries(ARMS)) {
	const tag = cfg.emb === QWEN ? "qwen" : "gemma";
	const o = [];
	for (const proj of Object.keys(byProject)) {
		const s = startQmd(`paired-${tag}-${proj}`, root, cmd.cmd, cmd.argv);
		try { await initialize(s); } catch { stop(s); continue; }
		for (const r of rows.filter((x) => x.project === proj)) {
			const gold = sourceOf.get(r.key);
			if (!gold) continue;
			let hits = [];
			try { hits = (await query(s, { searches: cfg.s(r.q), intent: r.q, limit: 5, rerank: false })).map((x) => x.replace(/\.md$/, "")); } catch { /* miss */ }
			o.push({ reg: r.reg, key: r.key, r1: hits[0] === gold ? 1 : 0, f5: hits.includes(gold) ? 1 : 0 });
		}
		stop(s);
	}
	outcomes[name] = o;
	process.stderr.write(`  ${name}: ${o.length} queries, rank-1 ${(o.reduce((a, b) => a + b.r1, 0) / o.length).toFixed(4)}\n`);
}
for (const c of created) { try { rmSync(c); } catch { /* nothing left behind */ } }
rmSync(root, { recursive: true, force: true });

// ── the statistics ────────────────────────────────────────────────────────
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const boot = (v, n = 5000) => {
	const means = [];
	for (let i = 0; i < n; i++) {
		let s = 0;
		for (let j = 0; j < v.length; j++) s += v[Math.floor(rnd() * v.length)];
		means.push(s / v.length);
	}
	means.sort((a, b) => a - b);
	return [+means[Math.floor(n * 0.025)].toFixed(4), +means[Math.floor(n * 0.975)].toFixed(4)];
};
/** McNemar exact: two-sided binomial on the discordant pairs. */
const logC = (n, k) => { let s = 0; for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i); return s; };
const mcnemar = (a, b) => {
	let n01 = 0, n10 = 0;
	for (let i = 0; i < a.length; i++) { if (a[i] === 0 && b[i] === 1) n01++; else if (a[i] === 1 && b[i] === 0) n10++; }
	const n = n01 + n10;
	if (!n) return { b_better: n01, a_better: n10, p: 1 };
	const k = Math.min(n01, n10);
	let p = 0;
	for (let i = 0; i <= k; i++) p += Math.exp(logC(n, i) - n * Math.LN2);
	return { b_better: n01, a_better: n10, discordant: n, p: +Math.min(1, 2 * p).toFixed(5) };
};

const names = Object.keys(ARMS);
const report = { queries: outcomes[names[0]].length, registers: [...new Set(rows.map((r) => r.reg))], arms: {}, pairwise: {} };
for (const n of names) {
	const r1 = outcomes[n].map((x) => x.r1), f5 = outcomes[n].map((x) => x.f5);
	report.arms[n] = {
		rank1: +(r1.reduce((a, b) => a + b, 0) / r1.length).toFixed(4), rank1_ci95: boot(r1),
		found5: +(f5.reduce((a, b) => a + b, 0) / f5.length).toFixed(4), found5_ci95: boot(f5),
	};
}
for (let i = 0; i < names.length; i++) {
	for (let j = i + 1; j < names.length; j++) {
		const a = outcomes[names[i]].map((x) => x.r1), b = outcomes[names[j]].map((x) => x.r1);
		report.pairwise[`${names[i]}  vs  ${names[j]}`] = { rank1: mcnemar(a, b), found5: mcnemar(outcomes[names[i]].map((x) => x.f5), outcomes[names[j]].map((x) => x.f5)) };
	}
}
report.reading = "sd across runs was 0.000, which establishes determinism and NOT precision. These intervals resample QUERIES, which is where the uncertainty lives. McNemar counts only the queries where two arms disagree — a difference that rests on a handful of them is not a ranking.";
writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
