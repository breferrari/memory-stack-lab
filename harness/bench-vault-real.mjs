#!/usr/bin/env node
/**
 * A benchmark with no generator in it.
 *
 *   node harness/bench-vault-real.mjs <vault> <out.json>
 *
 * Every other measurement in this project runs on a corpus one model wrote and
 * queries the same model wrote, and the deepest objection to all of it is that
 * no control can fully separate the systems from the generator. This fixture has
 * no generator anywhere.
 *
 *   documents  a working vault, written by a person over months
 *   queries    MCP captures, each written by a DIFFERENT session in a DIFFERENT
 *              repository at the time the lesson was learned
 *   labels     `promoted:` — a human's decision about which note a capture
 *              belongs in, recorded when it was promoted, not for this benchmark
 *
 * The one thing to be honest about: promotion COPIES the capture into the target
 * note, so the gold contains text the query is drawn from. That is not a flaw in
 * the fixture, it is the task — a memory store does contain what was written
 * into it, and "which note already covers this observation" is the question
 * `search` is asked in practice. The difficulty is real: the target is one entry
 * inside a note of twenty, competing with forty sibling notes on adjacent
 * subjects, all written in one voice.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initialize, query, startQmd, stop } from "./lib/qmd-mcp.mjs";

const [VAULT, OUT] = process.argv.slice(2);
if (!VAULT || !OUT) { console.error("usage: bench-vault-real.mjs <vault> <out.json>"); process.exit(1); }
const PLUGIN = process.env.VESTIGE_PLUGIN ?? resolve("..", "vestige");
process.env.VESTIGE_NO_UPDATE = "1";
const { runQmd, qmdCommand } = await import(pathToFileURL(join(PLUGIN, "core/setup/qmd.ts")).href);
const EMB = {
	"embeddinggemma-300M (what the vault runs)": "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
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
// The query is the capture's TITLE and its own description — what a session
// knows at the moment it wonders whether this is already written down. The
// capture body is deliberately not used: it is the text that was copied.
const fixture = [];
for (const f of walk(join(V, "memories"))) {
	const t = readFileSync(f, "utf8");
	const p = t.match(/^promoted:\s*"([^"#]+)/m);
	const d = t.match(/^description:\s*"([^"]+)"/m);
	const h = t.match(/^#\s+(.+)$/m);
	if (!p) continue;
	const gold = `${basename(p[1])}.md`;
	const q = [h?.[1], d?.[1]].filter(Boolean).join(". ");
	if (q.length > 30) fixture.push({ q, gold, self: basename(f) });
}

const cfgDir = join(homedir(), ".config", "qmd");
const cmd = qmdCommand([]);
const SHAPES = {
	"lex+vec": (q) => [{ type: "lex", query: q }, { type: "vec", query: q }],
	"vec only": (q) => [{ type: "vec", query: q }],
};
const results = {};
for (const [elabel, embed] of Object.entries(EMB)) {
	const name = `vaultreal-${elabel.startsWith("Qwen") ? "qwen" : "gemma"}`;
	const cfg = join(cfgDir, `${name}.yml`);
	writeFileSync(cfg, `collections:\n  vault:\n    path: '${V}'\n    pattern: "**/*.md"\nmodels:\n  embed: ${embed}\n  generate: ${GEN}\n  rerank: ${RRM}\n`);
	runQmd(["--index", name, "update"], { cwd: V });
	runQmd(["--index", name, "embed"], { cwd: V });
	for (const [slabel, build] of Object.entries(SHAPES)) {
		const s = startQmd(name, V, cmd.cmd, cmd.argv);
		await initialize(s);
		let r1 = 0, f5 = 0, ms = 0;
		for (const c of fixture) {
			const t = Date.now();
			let hits = [];
			try { hits = await query(s, { searches: build(c.q), intent: c.q, limit: 6, rerank: false }); } catch { /* miss */ }
			ms += Date.now() - t;
			// Drop the capture the query was drawn from. It is in the vault and it
			// is a perfect match for its own title, so it takes the top slot on
			// every single query — measured, 60 of 60 — and rank-1 reads 0.000.
			// Removing the query's own source document is the standard shape of a
			// known-item evaluation; leaving it in measures nothing.
			hits = hits.filter((h) => h !== c.self).slice(0, 5);
			if (hits[0] === c.gold) r1++;
			if (hits.includes(c.gold)) f5++;
		}
		stop(s);
		const k = `${elabel}  |  ${slabel}`;
		results[k] = { queries: fixture.length, rank1: +(r1 / fixture.length).toFixed(4), found_at_5: +(f5 / fixture.length).toFixed(4), mean_ms: Math.round(ms / fixture.length) };
		process.stderr.write(`  ${k}: rank1 ${results[k].rank1} found@5 ${results[k].found_at_5}\n`);
	}
	try { rmSync(cfg); } catch { /* leave nothing behind */ }
}
const out = { vault: V, documents: walk(V).length, human_labelled_pairs: fixture.length, arms: results,
	note: "Documents written by a person over months. Queries are MCP captures written by other sessions in other repositories. Labels are the promotion decisions recorded at the time. No part of this fixture was generated for it." };
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
