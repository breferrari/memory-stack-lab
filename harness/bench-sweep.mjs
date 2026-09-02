#!/usr/bin/env node
/**
 * Every qmd variable this project can set, crossed, on one corpus.
 *
 *   node harness/bench-sweep.mjs <pool> <q-REGISTER.tsv> <label> <out.json>
 *
 * No arm is here because it was expected to win. Two confident predictions were
 * already wrong on this corpus — that a stronger embedder could not help, and
 * that a reranker would fix first-slot ordering — so the selection is the full
 * cross-product of what qmd exposes, and the ranking at the end is whatever the
 * numbers say.
 *
 *   embedder   the two qmd ships
 *   context    qmd's README calls per-collection context "the key feature" and
 *              says it improves search relevance; this project sets none
 *   searches   typed sub-queries. The first carries 2x weight, so ORDER is a
 *              variable. An AUTHORED hyde passage is not the auto-expansion
 *              that was measured and rejected — that one is written by a model
 *              at query time, this one is caller text
 *   intent     documented as disambiguation that does not search on its own
 *   rerank     the cross-encoder, on and off
 *
 * Results are written after every arm, cheapest first, so a run that is cut
 * short still leaves everything it finished.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initialize, query, startQmd, stop } from "./lib/qmd-mcp.mjs";

const [POOL, QUERIES, LABEL, OUT] = process.argv.slice(2);
if (!POOL || !QUERIES || !OUT) { console.error("usage: bench-sweep.mjs <pool> <q.tsv> <label> <out.json>"); process.exit(1); }
const PLUGIN = process.env.VESTIGE_PLUGIN ?? resolve("..", "vestige");
process.env.VESTIGE_NO_UPDATE = "1";
const { runQmd, qmdCommand } = await import(pathToFileURL(join(PLUGIN, "core/setup/qmd.ts")).href);

const EMBEDDERS = {
	gemma: "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
	qwen: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
};
const RERANK_MODEL = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
const GENERATE = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";
const CONTEXTS = {
	none: null,
	global: "A project's own engineering memories: past incidents, what caused them, and what to do instead. Each memory is one incident in one service, not external documentation.",
};
const SEARCHES = {
	"lex+vec": (q) => [{ type: "lex", query: q }, { type: "vec", query: q }],
	"vec+lex": (q) => [{ type: "vec", query: q }, { type: "lex", query: q }],
	"lex+vec+hyde": (q) => [{ type: "lex", query: q }, { type: "vec", query: q }, { type: "hyde", query: q }],
	"hyde+lex+vec": (q) => [{ type: "hyde", query: q }, { type: "lex", query: q }, { type: "vec", query: q }],
	"lex": (q) => [{ type: "lex", query: q }],
	"vec": (q) => [{ type: "vec", query: q }],
};
const INTENTS = {
	query: (q) => q,
	none: () => undefined,
	disambiguating: (q) => `${q}. Prefer the memory about this specific incident over other incidents in the same service that share a topic.`,
};
const RERANKS = { off: false, on: true };

const map = JSON.parse(readFileSync(join(POOL, "_map.json"), "utf8"));
const sourceOf = new Map(Object.entries(map).filter(([, m]) => m.source).map(([id, m]) => [m.source, id]));
const byProject = {};
for (const [id, m] of Object.entries(map)) (byProject[m.project] ??= []).push(id);
const root = mkdtempSync(join(tmpdir(), "sweep-"));
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
const results = {};

const buildIndexes = (emb, ctxKey) => {
	for (const proj of Object.keys(byProject)) {
		const name = `sweep-${emb}-${ctxKey}-${proj}`;
		const f = join(cfgDir, `${name}.yml`);
		const ctx = CONTEXTS[ctxKey];
		writeFileSync(f, `collections:\n  memories:\n    path: '${join(root, proj)}'\n    pattern: "**/*.md"\nmodels:\n  embed: ${EMBEDDERS[emb]}\n  generate: ${GENERATE}\n  rerank: ${RERANK_MODEL}\n${ctx ? `global_context: |\n  ${ctx}\n` : ""}`);
		created.push(f);
		runQmd(["--index", name, "update"], { cwd: root });
		runQmd(["--index", name, "embed"], { cwd: root });
	}
};

const flush = () => {
	const ranked = Object.entries(results).filter(([, v]) => v.rank1 != null)
		.sort((a, b) => (b[1].rank1 - a[1].rank1) || (b[1].found_at_5 - a[1].found_at_5));
	writeFileSync(OUT, JSON.stringify({
		register: LABEL, arms_completed: ranked.length, arms: results,
		ranked_by_rank1: ranked.slice(0, 10).map(([k, v]) => ({ arm: k, rank1: v.rank1, found_at_5: v.found_at_5, mean_ms: v.mean_ms })),
		baseline: "gemma | ctx=none | lex+vec | intent=query | rerank=off",
	}, null, 1));
};

// rerank off first: it is 30x faster, so a truncated run still covers the cheap half.
for (const rrKey of ["off", "on"]) {
	for (const emb of Object.keys(EMBEDDERS)) {
		for (const ctxKey of Object.keys(CONTEXTS)) {
			if (rrKey === "off") buildIndexes(emb, ctxKey);
			for (const sKey of Object.keys(SEARCHES)) {
				for (const iKey of Object.keys(INTENTS)) {
					const arm = `${emb} | ctx=${ctxKey} | ${sKey} | intent=${iKey} | rerank=${rrKey}`;
					const acc = { n: 0, r1: 0, f5: 0, ms: 0 };
					for (const proj of Object.keys(byProject)) {
						const s = startQmd(`sweep-${emb}-${ctxKey}-${proj}`, root, cmd.cmd, cmd.argv);
						try { await initialize(s); } catch { stop(s); continue; }
						for (const r of rows.filter((x) => x.project === proj)) {
							const gold = sourceOf.get(r.key);
							if (!gold) continue;
							const intent = INTENTS[iKey](r.q);
							const args = { searches: SEARCHES[sKey](r.q), limit: 5, rerank: RERANKS[rrKey] };
							if (intent) args.intent = intent;
							const t = Date.now();
							let hits = [];
							try { hits = (await query(s, args)).map((x) => x.replace(/\.md$/, "")); } catch { /* empty */ }
							acc.ms += Date.now() - t; acc.n++;
							if (hits[0] === gold) acc.r1++;
							if (hits.includes(gold)) acc.f5++;
						}
						stop(s);
					}
					const d = (x) => (acc.n ? +(x / acc.n).toFixed(3) : null);
					results[arm] = { queries: acc.n, rank1: d(acc.r1), found_at_5: d(acc.f5), mean_ms: acc.n ? Math.round(acc.ms / acc.n) : null };
					process.stderr.write(`  ${arm}  ->  rank1 ${results[arm].rank1}  found@5 ${results[arm].found_at_5}  ${results[arm].mean_ms}ms\n`);
					flush();
				}
			}
		}
	}
}
for (const c of created) { try { rmSync(c); } catch { /* leave nothing behind */ } }
rmSync(root, { recursive: true, force: true });
flush();
console.log(readFileSync(OUT, "utf8"));
