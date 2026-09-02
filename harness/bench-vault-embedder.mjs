#!/usr/bin/env node
/**
 * Does the embedder finding transfer to a real vault?
 *
 *   node harness/bench-vault-embedder.mjs <vault-dir> <out.json> [n]
 *
 * The benchmark corpus is synthetic, adversarially near-duplicate, and built to
 * make scoping matter. A personal knowledge vault is none of those: one caller,
 * no scoping, and documents that are genuinely about different things. So the
 * ONE result worth carrying across is the one that is a property of the engine
 * rather than of the fixture — that qmd's default embedder is not its best.
 *
 * Fixture: notes carrying a `description` in frontmatter. The query is that
 * description, the gold is that note. A description is written from the note, so
 * this is easier than a real question — but it is exactly as easy for both arms,
 * and the comparison is what is being measured.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initialize, query, startQmd, stop } from "./lib/qmd-mcp.mjs";

const [VAULT, OUT, N = "60"] = process.argv.slice(2);
if (!VAULT || !OUT) { console.error("usage: bench-vault-embedder.mjs <vault> <out.json> [n]"); process.exit(1); }
const PLUGIN = process.env.VESTIGE_PLUGIN ?? resolve("..", "vestige");
process.env.VESTIGE_NO_UPDATE = "1";
const { runQmd, qmdCommand } = await import(pathToFileURL(join(PLUGIN, "core/setup/qmd.ts")).href);
const MODELS = {
	"embeddinggemma-300M (what the vault runs)": "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
	"Qwen3-Embedding-0.6B": "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
};
const RRM = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
const GEN = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";

const walk = (d, out = []) => {
	for (const e of readdirSync(d)) {
		if (e.startsWith(".") || e === "node_modules") continue;
		const p = join(d, e);
		if (statSync(p).isDirectory()) walk(p, out); else if (e.endsWith(".md")) out.push(p);
	}
	return out;
};
const files = walk(resolve(VAULT));
const fixture = [];
for (const f of files) {
	const t = readFileSync(f, "utf8");
	const m = t.match(/^---[\s\S]*?^description:\s*"([^"]{40,300})"[\s\S]*?^---/m);
	if (m) fixture.push({ file: relative(resolve(VAULT), f), q: m[1] });
}
// Deterministic spread across the vault rather than the first n alphabetically.
fixture.sort((a, b) => a.file.localeCompare(b.file));
const step = Math.max(1, Math.floor(fixture.length / Number(N)));
const chosen = fixture.filter((_, i) => i % step === 0).slice(0, Number(N));

const cfgDir = join(homedir(), ".config", "qmd");
const cmd = qmdCommand([]);
const results = {};
for (const [label, embed] of Object.entries(MODELS)) {
	const name = `vaulttest-${label.startsWith("Qwen") ? "qwen" : "gemma"}`;
	const f = join(cfgDir, `${name}.yml`);
	writeFileSync(f, `collections:\n  vault:\n    path: '${resolve(VAULT)}'\n    pattern: "**/*.md"\nmodels:\n  embed: ${embed}\n  generate: ${GEN}\n  rerank: ${RRM}\n`);
	const t0 = Date.now();
	runQmd(["--index", name, "update"], { cwd: resolve(VAULT) });
	runQmd(["--index", name, "embed"], { cwd: resolve(VAULT) });
	const indexMs = Date.now() - t0;
	const s = startQmd(name, resolve(VAULT), cmd.cmd, cmd.argv);
	await initialize(s);
	let r1 = 0, f5 = 0, ms = 0;
	for (const c of chosen) {
		const t = Date.now();
		let hits = [];
		try { hits = await query(s, { searches: [{ type: "lex", query: c.q }, { type: "vec", query: c.q }], intent: c.q, limit: 5, rerank: false }); } catch { /* miss */ }
		ms += Date.now() - t;
		const want = c.file.split("/").pop();
		if (hits[0] === want) r1++;
		if (hits.includes(want)) f5++;
	}
	stop(s);
	try { rmSync(f); } catch { /* leave no config behind */ }
	results[label] = { queries: chosen.length, rank1: +(r1 / chosen.length).toFixed(4), found_at_5: +(f5 / chosen.length).toFixed(4), mean_query_ms: Math.round(ms / chosen.length), index_build_ms: indexMs };
	process.stderr.write(`  ${label}: rank1 ${results[label].rank1} found@5 ${results[label].found_at_5} ${results[label].mean_query_ms}ms\n`);
}
const out = { vault: resolve(VAULT), documents: files.length, fixture_size: chosen.length, arms: results,
	caveat: "The query is each note's own description, which is written from the note. That makes this easier than a real question and equally easy for both arms — the comparison is the measurement, the absolute numbers are not." };
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
