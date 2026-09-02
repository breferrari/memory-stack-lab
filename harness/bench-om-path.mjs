#!/usr/bin/env node
/**
 * Does what Vestige learned apply to obsidian-mind? Measured, not asserted.
 *
 *   node harness/bench-om-path.mjs <vault> <out.json>
 *
 * OM drives qmd through `subQueries` in `.claude/scripts/lib/mcp-qmd-client.ts`:
 * lexical and vector always, HyDE only when the query is question-shaped and at
 * least four words, and `rerank` never passed. It also never names an embedder,
 * so it runs whatever qmd defaults to.
 *
 * Three of those are decisions, and none of them had a number. This reproduces
 * OM's shape exactly and varies one thing at a time against it, on the vault's
 * own 211 human-labelled pairs — the same fixture as bench-vault-real.mjs, whose
 * gold labels are promotion decisions a person made months ago for other reasons.
 *
 * The shipped arm is a REPRODUCTION, not an import: OM's source is TypeScript
 * inside a plugin that expects a Claude session around it. The regex and the
 * word-count gate below are copied literally so a change upstream shows up here
 * as a divergence rather than passing silently.
 */
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initialize, query, startQmd, stop } from "./lib/qmd-mcp.mjs";

const [VAULT, OUT] = process.argv.slice(2);
if (!VAULT || !OUT) { console.error("usage: bench-om-path.mjs <vault> <out.json>"); process.exit(1); }
const PLUGIN = process.env.VESTIGE_PLUGIN ?? resolve("..", "vestige");
process.env.VESTIGE_NO_UPDATE = "1";
const { runQmd, qmdCommand } = await import(pathToFileURL(join(PLUGIN, "core/setup/qmd.ts")).href);

const EMB = {
	"embeddinggemma-300M (OM's inherited default)": "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
	"Qwen3-Embedding-0.6B": "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
};
const RRM = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
const GEN = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";
const V = resolve(VAULT);

// Copied verbatim from mcp-qmd-client.ts. If upstream edits either line, this
// arm stops being a reproduction of OM and the divergence is the finding.
const QUESTION_SHAPED = /\b(why|how|what|when|where|which|who|should|can|does|did|is|are|was)\b|\?/i;
const omShipped = (q) => {
	const subs = [{ type: "lex", query: q }, { type: "vec", query: q }];
	if (q.split(/\s+/).length >= 4 && QUESTION_SHAPED.test(q)) subs.push({ type: "hyde", query: q });
	return subs;
};

const walk = (d, out = []) => {
	for (const e of readdirSync(d)) {
		if (e.startsWith(".") || e === "node_modules") continue;
		const p = join(d, e);
		if (statSync(p).isDirectory()) walk(p, out); else if (e.endsWith(".md")) out.push(p);
	}
	return out;
};
const fixture = [];
for (const f of walk(join(V, "memories"))) {
	const t = readFileSync(f, "utf8");
	const p = t.match(/^promoted:\s*"([^"#]+)/m);
	const d = t.match(/^description:\s*"([^"]+)"/m);
	const h = t.match(/^#\s+(.+)$/m);
	if (!p) continue;
	const q = [h?.[1], d?.[1]].filter(Boolean).join(". ");
	if (q.length > 30) fixture.push({ q, gold: `${basename(p[1])}.md`, self: basename(f) });
}
const shaped = fixture.filter((c) => omShipped(c.q).length === 3).length;

const ARMS = {
	"OM as shipped (lex+vec, hyde if question-shaped)": { build: omShipped, rerank: false },
	"OM as shipped + rerank": { build: omShipped, rerank: true },
	"lex+vec, HyDE never": { build: (q) => [{ type: "lex", query: q }, { type: "vec", query: q }], rerank: false },
	"lex+vec, HyDE always": { build: (q) => [{ type: "lex", query: q }, { type: "vec", query: q }, { type: "hyde", query: q }], rerank: false },
};

const cfgDir = join(homedir(), ".config", "qmd");
const cmd = qmdCommand([]);
const results = {};
// Per-query outcomes are kept so the comparison can be tested for significance
// on the pairs rather than eyeballed on two rates; a 2-point gap over 211
// queries is 4 documents and proves nothing on its own.
const perQuery = {};
for (const [elabel, embed] of Object.entries(EMB)) {
	const name = `ompath-${elabel.startsWith("Qwen") ? "qwen" : "gemma"}`;
	const cfg = join(cfgDir, `${name}.yml`);
	writeFileSync(cfg, `collections:\n  vault:\n    path: '${V}'\n    pattern: "**/*.md"\nmodels:\n  embed: ${embed}\n  generate: ${GEN}\n  rerank: ${RRM}\n`);
	runQmd(["--index", name, "update"], { cwd: V });
	runQmd(["--index", name, "embed"], { cwd: V });
	for (const [alabel, arm] of Object.entries(ARMS)) {
		const s = startQmd(name, V, cmd.cmd, cmd.argv);
		await initialize(s);
		let r1 = 0, f5 = 0, ms = 0;
		const hitVec = [];
		for (const c of fixture) {
			const t = Date.now();
			let hits = [];
			try { hits = await query(s, { searches: arm.build(c.q), intent: c.q, limit: 6, rerank: arm.rerank }); } catch { /* a miss is a miss */ }
			ms += Date.now() - t;
			hits = hits.filter((h) => h !== c.self).slice(0, 5);
			if (hits[0] === c.gold) r1++;
			if (hits.includes(c.gold)) f5++;
			hitVec.push(hits[0] === c.gold ? 1 : 0);
		}
		stop(s);
		const k = `${elabel}  |  ${alabel}`;
		results[k] = { queries: fixture.length, rank1: +(r1 / fixture.length).toFixed(4), found_at_5: +(f5 / fixture.length).toFixed(4), mean_ms: Math.round(ms / fixture.length) };
		perQuery[k] = hitVec;
		process.stderr.write(`  ${k}\n    rank1 ${results[k].rank1}  found@5 ${results[k].found_at_5}  ${results[k].mean_ms}ms\n`);
	}
	try { rmSync(cfg); } catch { /* leave nothing behind */ }
}

// McNemar's exact test on the pairs that disagree. Two rates differing by a few
// documents is not a result; this says whether the difference could be shuffle.
const mcnemar = (a, b) => {
	let bOnly = 0, aOnly = 0;
	for (let i = 0; i < a.length; i++) { if (a[i] && !b[i]) aOnly++; else if (b[i] && !a[i]) bOnly++; }
	const n = aOnly + bOnly;
	if (n === 0) return { discordant: 0, p: 1 };
	const lo = Math.min(aOnly, bOnly);
	let logC = 0, tail = 0;
	for (let k = 0; k <= n; k++) {
		if (k > 0) logC += Math.log((n - k + 1) / k);
		if (k <= lo || k >= n - lo) tail += Math.exp(logC - n * Math.LN2);
	}
	return { a_only: aOnly, b_only: bOnly, discordant: n, p: +Math.min(1, tail).toFixed(4) };
};
const keys = Object.keys(perQuery);
const tests = {};
for (const base of keys) {
	for (const other of keys) {
		if (base >= other) continue;
		tests[`${base}   vs   ${other}`] = mcnemar(perQuery[base], perQuery[other]);
	}
}

const out = { vault: V, documents: walk(V).length, human_labelled_pairs: fixture.length,
	question_shaped_queries: shaped, arms: results, mcnemar_rank1: tests,
	note: "OM's shipped query path reproduced from mcp-qmd-client.ts and varied one axis at a time, on the vault's own promotion labels." };
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log("wrote " + OUT);
