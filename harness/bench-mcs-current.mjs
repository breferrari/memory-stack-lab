#!/usr/bin/env node
/**
 * The other stack as its branch actually configures itself, not as we once
 * reconstructed it.
 *
 *   node harness/bench-mcs-current.mjs <pool> <q-REGISTER.tsv> <label> [out.json]
 *
 * The previous replication was taken from an earlier read of hooks/sync-memories.sh
 * and had drifted from the branch in two ways that both understated it:
 *
 *   embedding model  it hardcoded embeddinggemma-300M. The branch has used
 *                    Qwen3-Embedding-0.6B — twice the parameters — in all three
 *                    slots since before this comparison was first run.
 *   call shape       it sent one structured document to the CLI. The branch
 *                    instructs typed `lex` + `vec` sub-queries through the MCP
 *                    query tool with rerank false and limit 6, stated in three
 *                    separate files on purpose. That is essentially the shape
 *                    used here, so the earlier comparison measured a path its
 *                    author does not recommend.
 *
 * Benchmarking someone else's design against a configuration they do not use is
 * not a measurement of their design. Replicated from bruno/qmd-retrieval-backend
 * at 3a75dd9, on the same pinned qmd 2.8.3 this project uses.
 *
 * Two arms, because they scope differently and the difference is the point:
 *   per-project  one index per project directory — isolation by construction
 *   shared       one index over every project's memories, which is what the
 *                shared-memories pack produces
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [POOL, QUERIES, LABEL, OUT] = process.argv.slice(2);
if (!POOL || !QUERIES) { console.error("usage: bench-mcs-current.mjs <pool> <q.tsv> <label> [out.json]"); process.exit(1); }
const PLUGIN = process.env.VESTIGE_PLUGIN ?? resolve("..", "vestige");
process.env.VESTIGE_NO_UPDATE = "1";
const { sessionQuery, shutdownQmdSession } = await import(pathToFileURL(join(PLUGIN, "core/lib/qmd-session.ts")).href);
const { runQmd } = await import(pathToFileURL(join(PLUGIN, "core/setup/qmd.ts")).href);

/** hooks/sync-memories.sh: one model in all three slots, and why. */
const EMBED = "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";
/** His index carries identity only — guidance is paid for per result. */
const GLOBAL_CONTEXT = "  Project memory KB: this project's own past learnings, decisions and debugging\n  discoveries — not external documentation.";
/** templates/continuous-learning.md and skills/continuous-learning/SKILL.md. */
const LIMIT = 6;

const map = JSON.parse(readFileSync(join(POOL, "_map.json"), "utf8"));
const sourceOf = new Map(Object.entries(map).filter(([, m]) => m.source).map(([id, m]) => [m.source, id]));
const byProject = {};
for (const [id, m] of Object.entries(map)) (byProject[m.project] ??= []).push(id);

const root = mkdtempSync(join(tmpdir(), "mcscur-"));
for (const [proj, ids] of Object.entries(byProject)) {
	const d = join(root, proj);
	mkdirSync(d, { recursive: true });
	for (const id of ids) cpSync(join(POOL, `${id}.md`), join(d, `${id}.md`));
}
const sharedDir = join(root, "_shared");
mkdirSync(sharedDir, { recursive: true });
for (const id of Object.keys(map)) cpSync(join(POOL, `${id}.md`), join(sharedDir, `${id}.md`));

const cfgDir = join(homedir(), ".config", "qmd");
const created = [];
const writeIndex = (name, path) => {
	const f = join(cfgDir, `${name}.yml`);
	writeFileSync(f, `collections:\n  memories:\n    path: '${path}'\n    pattern: "**/*.md"\nmodels:\n  embed: ${EMBED}\n  generate: ${EMBED}\n  rerank: ${EMBED}\nglobal_context: |\n${GLOBAL_CONTEXT}\n`);
	created.push(f);
	return runQmd(["--index", name, "update"], { cwd: root }).ok && runQmd(["--index", name, "embed"], { cwd: root }).ok;
};

const rows = readFileSync(QUERIES, "utf8").split("\n").filter(Boolean).map((l) => {
	const [project, key, doc] = l.split("\t");
	return { project, key, q: doc.replace(/%%/g, " ").replace(/\b(lex|vec):\s*/g, "") };
});

const run = async (indexFor) => {
	const acc = { n: 0, r1: 0, f5: 0, f6: 0, empty: 0 };
	let current = null;
	for (const r of rows) {
		const gold = sourceOf.get(r.key);
		const index = indexFor(r.project);
		if (!gold || !index) continue;
		if (index !== current) { shutdownQmdSession(); current = index; }
		const ids = await sessionQuery({ index, signature: "mcs-current", cwd: root, query: r.q, limit: LIMIT, rerank: false });
		const hits = (ids ?? []).map((x) => String(x).replace(/\.md$/, ""));
		acc.n++;
		if (!hits.length) acc.empty++;
		if (hits[0] === gold) acc.r1++;
		if (hits.slice(0, 5).includes(gold)) acc.f5++;
		if (hits.includes(gold)) acc.f6++;
	}
	shutdownQmdSession();
	const d = (x) => (acc.n ? +(x / acc.n).toFixed(3) : null);
	return { queries: acc.n, rank1: d(acc.r1), found_at_5: d(acc.f5), found_at_6: d(acc.f6), returned_nothing: acc.empty };
};

const results = {};
const perProjectOk = Object.keys(byProject).every((p) => writeIndex(`mcscur-pp-${p}`, join(root, p)));
if (perProjectOk) results["per-project index"] = await run((p) => `mcscur-pp-${p}`);
if (writeIndex("mcscur-shared", sharedDir)) results["one shared pool"] = await run(() => "mcscur-shared");

for (const c of created) { try { rmSync(c); } catch { /* leave nothing behind */ } }
rmSync(root, { recursive: true, force: true });

const out = {
	register: LABEL, replicated_from: "bruno/qmd-retrieval-backend @ 3a75dd9",
	configuration: { embed: EMBED, generate: EMBED, rerank: EMBED, call: "typed lex+vec sub-queries via MCP, rerank false", limit: LIMIT },
	arms: results,
	note: "found_at_5 is reported for comparability with every other arm in this suite; found_at_6 is the configuration his instructions actually specify.",
};
const json = JSON.stringify(out, null, 1);
if (OUT) writeFileSync(OUT, json);
console.log(json);
