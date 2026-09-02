#!/usr/bin/env node
/**
 * The question the rest of this suite could not ask.
 *
 *   node harness/bench-transfer.mjs <corpus> <world.json> <q-transfer.tsv> <out.json>
 *
 * Every other query here is asked by the service that wrote the memory it is
 * looking for. Under that shape a per-project index and a declared reach model
 * cannot be told apart: the answer is already in the asker's own folder either
 * way. That is why the earlier scoped-versus-shared result measured index
 * cardinality — 23 documents against 183 — and not reach.
 *
 * These 57 queries are asked by a service that did NOT write the memory, about a
 * fault in a library every service imports, where the memory declares it applies
 * to all of them. Three arms, and their differences are structural rather than a
 * matter of ranking:
 *
 *   declared reach          the memory is in the caller's view because it says
 *                           it is for them. Reach also decided WHERE it is
 *                           stored: a memory reaching several projects cannot
 *                           live inside one repository.
 *   one index per project   the memory is in its author's index. The caller's
 *                           index has never heard of it. Unreachable at any k.
 *   one shared pool         reachable, and competing with 182 other documents.
 *
 * A ceiling is reported beside each arm, because a system that cannot see a
 * document is not failing to rank it.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initialize, query as mcpQuery, startQmd, stop } from "./lib/qmd-mcp.mjs";
import { proseOf } from "./lib/measure.mjs";

const [CORPUS, WORLD, QUERIES, OUT] = process.argv.slice(2);
if (!CORPUS || !WORLD || !QUERIES || !OUT) { console.error("usage: bench-transfer.mjs <corpus> <world.json> <q-transfer.tsv> <out.json>"); process.exit(1); }
const PLUGIN = process.env.VESTIGE_PLUGIN ?? resolve("..", "vestige");
process.env.VESTIGE_NO_UPDATE = "1";
process.env.VESTIGE_HOME = mkdtempSync(join(tmpdir(), "vh-transfer-"));
delete process.env.CLAUDE_PROJECT_DIR;
const { remember, search } = await import(pathToFileURL(join(PLUGIN, "core/lib/vestige.ts")).href);
const { runQmd, qmdCommand } = await import(pathToFileURL(join(PLUGIN, "core/setup/qmd.ts")).href);
const EMBED = "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";
const RRM = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
const GEN = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";

const world = JSON.parse(readFileSync(WORLD, "utf8"));
const mem = new Map(world.memories.map((m) => [m.id, m]));
const services = [...new Set(world.memories.map((m) => m.project))].sort();
const rows = readFileSync(QUERIES, "utf8").split("\n").filter(Boolean).map((l) => {
	const [asker, key, doc] = l.split("\t");
	return { asker, key, q: doc.replace(/%%/g, " ").replace(/\b(lex|vec):\s*/g, "") };
});
const bodyOf = (id) => { try { return proseOf(readFileSync(join(CORPUS, `${id}.md`), "utf8")); } catch { return null; } };
const titleOf = (id) => { try { return (readFileSync(join(CORPUS, `${id}.md`), "utf8").match(/^# (.+?)(?: — [a-z0-9-]+)?$/m) ?? [])[1] ?? id; } catch { return id; } };

// ── arm 1: declared reach, through the real write and read path ───────────
const root = mkdtempSync(join(tmpdir(), "transfer-repos-"));
const repoOf = {};
for (const s of services) { const d = join(root, s); mkdirSync(d, { recursive: true }); execFileSync("git", ["init", "-q", d]); repoOf[s] = d; }
const nameOf = new Map();
let landed = 0;
for (const m of world.memories) {
	const body = bodyOf(m.id);
	if (!body) continue;
	const r = remember({ title: titleOf(m.id), body, confidence: "inferred", scope: "project", projects: m.reaches ?? [m.project] }, { cwd: repoOf[m.project] });
	if (r.ok) { landed++; nameOf.set(m.id, r.rel.replace(/\.md$/, "")); }
}
const reachArm = { queries: 0, r1: 0, f5: 0, visible: 0 };
for (const r of rows) {
	const gold = nameOf.get(r.key);
	if (!gold) continue;
	const res = await search(r.q, { cwd: repoOf[r.asker], limit: 5 });
	const hits = res.hits.map((h) => h.name.replace(/\.md$/, ""));
	reachArm.queries++;
	if (hits[0] === gold) reachArm.r1++;
	if (hits.includes(gold)) reachArm.f5++;
}

// ── arms 2 and 3: folders, queried through a neutral MCP client ───────────
const cfgDir = join(homedir(), ".config", "qmd");
const created = [];
const froot = mkdtempSync(join(tmpdir(), "transfer-folders-"));
for (const s of services) {
	const d = join(froot, s);
	mkdirSync(d, { recursive: true });
	// A per-project index holds what that project WROTE. That is the shape.
	for (const m of world.memories.filter((x) => x.project === s)) cpSync(join(CORPUS, `${m.id}.md`), join(d, `${m.id}.md`));
}
const sharedDir = join(froot, "_shared");
mkdirSync(sharedDir, { recursive: true });
for (const m of world.memories) cpSync(join(CORPUS, `${m.id}.md`), join(sharedDir, `${m.id}.md`));
const mkIndex = (name, path) => {
	const f = join(cfgDir, `${name}.yml`);
	writeFileSync(f, `collections:\n  memories:\n    path: '${path}'\n    pattern: "**/*.md"\nmodels:\n  embed: ${EMBED}\n  generate: ${GEN}\n  rerank: ${RRM}\n`);
	created.push(f);
	runQmd(["--index", name, "update"], { cwd: froot });
	runQmd(["--index", name, "embed"], { cwd: froot });
};
for (const s of services) mkIndex(`transfer-pp-${s}`, join(froot, s));
mkIndex("transfer-shared", sharedDir);

const cmd = qmdCommand([]);
const folderArm = async (indexFor, label) => {
	const acc = { label, queries: 0, r1: 0, f5: 0, present_in_index: 0 };
	let cur = null, s = null;
	for (const r of rows) {
		const idx = indexFor(r.asker);
		if (idx !== cur) { if (s) stop(s); s = startQmd(idx, froot, cmd.cmd, cmd.argv); await initialize(s); cur = idx; }
		// Is the gold even in the index this caller searches?
		const inIndex = label.startsWith("one shared") || mem.get(r.key)?.project === r.asker;
		if (inIndex) acc.present_in_index++;
		const hits = (await mcpQuery(s, { searches: [{ type: "lex", query: r.q }, { type: "vec", query: r.q }], intent: r.q, limit: 5, rerank: false })).map((x) => x.replace(/\.md$/, ""));
		acc.queries++;
		if (hits[0] === r.key) acc.r1++;
		if (hits.includes(r.key)) acc.f5++;
	}
	if (s) stop(s);
	return acc;
};
const pp = await folderArm((asker) => `transfer-pp-${asker}`, "one index per project");
const sh = await folderArm(() => "transfer-shared", "one shared pool");

for (const c of created) { try { rmSync(c); } catch { /* nothing left behind */ } }
rmSync(root, { recursive: true, force: true });
rmSync(froot, { recursive: true, force: true });

const pct = (a, b) => (b ? +(a / b).toFixed(4) : null);
const out = {
	transfer_queries: rows.length, memories_written: landed,
	arms: {
		"declared reach (Vestige)": { queries: reachArm.queries, rank1: pct(reachArm.r1, reachArm.queries), found_at_5: pct(reachArm.f5, reachArm.queries), gold_reachable_at_all: 1 },
		"one index per project": { queries: pp.queries, rank1: pct(pp.r1, pp.queries), found_at_5: pct(pp.f5, pp.queries), gold_reachable_at_all: pct(pp.present_in_index, pp.queries) },
		"one shared pool": { queries: sh.queries, rank1: pct(sh.r1, sh.queries), found_at_5: pct(sh.f5, sh.queries), gold_reachable_at_all: pct(sh.present_in_index, sh.queries) },
	},
	reading: "Every query is asked by a service that did not write the memory it needs, about a fault in a library all of them import. gold_reachable_at_all is the ceiling: a per-project index does not contain the document, so its score is not a ranking failure but an absence.",
};
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
