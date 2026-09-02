#!/usr/bin/env node
/**
 * Replicate the embedder comparison on a SECOND vault, emitting aggregates only.
 *
 *   node harness/bench-vault-replicate.mjs <vault-dir> <label> <out.json> [n]
 *
 * The embedder result was measured on one vault. One vault is one writer, one
 * subject matter and one house style, and an embedder that suits it is not yet
 * an embedder that suits vaults. A second independently-written vault is the
 * cheapest thing that could falsify it.
 *
 * The second vault here holds work material, so this deliberately cannot carry
 * any of it out: `bench-vault-embedder.mjs` writes the resolved vault path into
 * its output, and its fixture is built from note descriptions. This variant
 * takes an opaque LABEL instead of a path, and writes nothing but counts and
 * rates. No title, description, filename or path from the subject vault reaches
 * the output file, and the temporary qmd config and index are removed at the end.
 *
 * That constraint is the reason this is a separate file rather than a flag: a
 * redaction that can be switched off by forgetting a flag is not a redaction.
 */
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initialize, query, startQmd, stop } from "./lib/qmd-mcp.mjs";

const [VAULT, LABEL, OUT, N = "60"] = process.argv.slice(2);
if (!VAULT || !LABEL || !OUT) { console.error("usage: bench-vault-replicate.mjs <vault> <label> <out.json> [n]"); process.exit(1); }
const PLUGIN = process.env.VESTIGE_PLUGIN ?? resolve("..", "vestige");
process.env.VESTIGE_NO_UPDATE = "1";
const { runQmd, qmdCommand } = await import(pathToFileURL(join(PLUGIN, "core/setup/qmd.ts")).href);
const EMB = {
	"embeddinggemma-300M (qmd default)": "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
	"Qwen3-Embedding-0.6B": "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
};
const RRM = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
const GEN = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";
const V = resolve(VAULT);

const walk = (d, out = []) => {
	for (const e of readdirSync(d)) {
		if (e.startsWith(".") || e === "node_modules") continue;
		const p = join(d, e);
		if (statSync(p).isDirectory()) walk(p, out); else if (e.endsWith(".md")) out.push(p);
	}
	return out;
};
const files = walk(V);
const fixture = [];
for (const f of files) {
	const m = readFileSync(f, "utf8").match(/^description:\s*"?([^"\n]{40,})"?$/m);
	if (m) fixture.push({ file: f.slice(V.length + 1), q: m[1].trim() });
}
// Deterministic even spread across the vault, so the sample is not the first N
// files of whichever folder sorts first.
fixture.sort((a, b) => a.file.localeCompare(b.file));
const step = Math.max(1, Math.floor(fixture.length / Number(N)));
const chosen = fixture.filter((_, i) => i % step === 0).slice(0, Number(N));

const cfgDir = join(homedir(), ".config", "qmd");
const cmd = qmdCommand([]);
const results = {};
const perQuery = {};
const built = [];
for (const [label, embed] of Object.entries(EMB)) {
	const name = `replicate-${label.startsWith("Qwen") ? "qwen" : "gemma"}`;
	const cfg = join(cfgDir, `${name}.yml`);
	writeFileSync(cfg, `collections:\n  vault:\n    path: '${V}'\n    pattern: "**/*.md"\nmodels:\n  embed: ${embed}\n  generate: ${GEN}\n  rerank: ${RRM}\n`);
	const t0 = Date.now();
	runQmd(["--index", name, "update"], { cwd: V });
	runQmd(["--index", name, "embed"], { cwd: V });
	const indexMs = Date.now() - t0;
	// An index that embedded nothing still answers, lexically, in a few ms, and
	// reports a rate that looks like a result. That is exactly how this arm
	// failed the first time: 2.1s to "build" where a real build takes 100s, then
	// 7ms queries and a rank-1 of 0.35 that read as a finding rather than a dead
	// index. Ask the store what it actually holds and refuse to score without it.
	const st = String(runQmd(["--index", name, "status"], { cwd: V })?.stdout ?? "");
	const vectors = Number(st.match(/Vectors:\s*([\d,]+)/)?.[1]?.replace(/,/g, "") ?? 0);
	const indexed = Number(st.match(/Total:\s*([\d,]+)/)?.[1]?.replace(/,/g, "") ?? 0);
	if (vectors < indexed || indexed < files.length * 0.9) {
		throw new Error(`${label}: index is not usable — ${indexed} of ${files.length} files indexed, ${vectors} vectors. A vector search over this measures nothing.`);
	}
	const s = startQmd(name, V, cmd.cmd, cmd.argv);
	await initialize(s);
	let r1 = 0, f5 = 0, ms = 0;
	const hitVec = [];
	for (const c of chosen) {
		const t = Date.now();
		let hits = [];
		try { hits = await query(s, { searches: [{ type: "lex", query: c.q }, { type: "vec", query: c.q }], intent: c.q, limit: 5, rerank: false }); } catch { /* a miss is a miss */ }
		ms += Date.now() - t;
		const gold = c.file.split("/").pop();
		if (hits[0] === gold) r1++;
		if (hits.includes(gold)) f5++;
		hitVec.push(hits[0] === gold ? 1 : 0);
	}
	stop(s);
	results[label] = { queries: chosen.length, rank1: +(r1 / chosen.length).toFixed(4), found_at_5: +(f5 / chosen.length).toFixed(4), mean_query_ms: Math.round(ms / chosen.length), index_build_ms: indexMs, files_indexed: indexed, vectors };
	perQuery[label] = hitVec;
	process.stderr.write(`  ${label}: rank1 ${results[label].rank1} found@5 ${results[label].found_at_5}\n`);
	// Leave nothing of the subject vault behind: the config names its path and
	// the index holds its embedded text.
	built.push({ name, cfg });
}
// Teardown runs after every arm has been scored. Dropping an index between arms
// is what broke the first attempt: the next build came back in 2s having
// embedded nothing.
for (const b of built) {
	try { runQmd(["--index", b.name, "drop", "--yes"], { cwd: V }); } catch { /* best effort */ }
	try { rmSync(b.cfg); } catch { /* already gone */ }
}
const k = Object.keys(perQuery);
let aOnly = 0, bOnly = 0;
for (let i = 0; i < chosen.length; i++) {
	if (perQuery[k[0]][i] && !perQuery[k[1]][i]) aOnly++;
	else if (perQuery[k[1]][i] && !perQuery[k[0]][i]) bOnly++;
}
const n = aOnly + bOnly, lo = Math.min(aOnly, bOnly);
let logC = 0, p = 0;
for (let i = 0; i <= n; i++) { if (i > 0) logC += Math.log((n - i + 1) / i); if (i <= lo || i >= n - lo) p += Math.exp(logC - n * Math.LN2); }

// LABEL, not the path. Counts and rates, nothing else.
const out = { vault: LABEL, documents: files.length, notes_with_a_description: fixture.length, fixture_size: chosen.length,
	arms: results, mcnemar_rank1: { default_only: aOnly, qwen_only: bOnly, discordant: n, p: n === 0 ? 1 : +Math.min(1, p).toFixed(4) },
	note: "Known-item retrieval: the query is a note's own description, the gold is that note. Aggregates only — no content from the subject vault is recorded here." };
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
