#!/usr/bin/env node
/**
 * Is the reranker worth 2.3 seconds on a per-caller view?
 *
 * It is the dominant cost in `search` — 3.8s hybrid against 1.6s without it —
 * and the protocol asks a session to search freely, which a 4-second call
 * quietly discourages. On a large shared pool the reranker previously scored
 * WORSE than skipping it. The question is whether that holds on the small
 * filtered views the architecture actually queries.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Sibling checkout by default; a machine-specific absolute path must never
// reach a public repository.
const PLUGIN = process.env.VESTIGE_PLUGIN ?? resolve(import.meta.dirname, "..", "..", "vestige");
const SRC = process.argv[2];
const QUERIES = process.argv[3];
const HOME = mkdtempSync(join(tmpdir(), "rr-home-"));
process.env.VESTIGE_HOME = HOME;
process.env.VESTIGE_NO_UPDATE = "1";

const { remember } = await import(pathToFileURL(join(PLUGIN, "core/lib/vestige.ts")).href);
const { ensureIndex } = await import(pathToFileURL(join(PLUGIN, "core/lib/index-view.ts")).href);
const { runQmd } = await import(pathToFileURL(join(PLUGIN, "core/setup/qmd.ts")).href);

/**
 * Derive what the corpus does not carry.
 *
 * This bench needed a SRC that had BOTH a `_map.json` and `## Problem` headings
 * in its documents, and no such directory exists any more: the raw corpus has
 * the headings and writes its map to stdout, while the written pool has the map
 * and no headings, because the write path renders them away. So the map is read
 * when present and otherwise rebuilt from the `**Applies to:**` line — the same
 * ownership convention the scorer uses — and the body falls back to everything
 * after the Applies-to line when there is no `## Problem` to slice at.
 */
const srcMap = (() => {
	try { return JSON.parse(readFileSync(join(SRC, "_map.json"), "utf8")); } catch { /* derive it */ }
	const map = {};
	for (const f of readdirSync(SRC).filter((x) => x.endsWith(".md"))) {
		const owner = (readFileSync(join(SRC, f), "utf8").match(/\*\*Applies to:\*\*\s*([a-z0-9-]+)/i) ?? [])[1];
		if (owner) map[f.replace(/\.md$/, "")] = { project: owner };
	}
	if (!Object.keys(map).length) { console.error(`no _map.json in ${SRC} and no **Applies to:** lines to derive one from`); process.exit(1); }
	return map;
})();
const projects = [...new Set(Object.values(srcMap).map((v) => v.project))].sort();
const root = mkdtempSync(join(tmpdir(), "rr-repos-"));
const repoOf = {};
for (const p of projects) { const d = join(root, p); mkdirSync(d, { recursive: true }); execFileSync("git", ["init", "-q", d]); repoOf[p] = d; }

const idMap = {};
for (const [id, meta] of Object.entries(srcMap)) {
  const md = readFileSync(join(SRC, `${id}.md`), "utf8");
  const title = (md.match(/^# (.+)$/m) ?? [])[1] ?? id;
  const cut = md.indexOf("## Problem");
  const body = (cut >= 0 ? md.slice(cut).replace(/^## Problem\s*/, "") : md.replace(/^[\s\S]*?\*\*Applies to:\*\*[^\n]*\n/, "")).replace(/\n## /g, "\n\n").trim();
  const r = remember({ title, body, confidence: "inferred", scope: "project", projects: [meta.project] }, { cwd: repoOf[meta.project] });
  if (r.ok) idMap[r.rel.replace(/\.md$/, "")] = meta;
}
writeFileSync(join(HOME, "_map.json"), JSON.stringify(idMap, null, 1));

for (const arm of ["rerank", "norerank"]) {
  const out = join(HOME, `res-${arm}`);
  mkdirSync(out, { recursive: true });
  let ms = 0, n = 0;
  for (const line of readFileSync(QUERIES, "utf8").split("\n").filter(Boolean)) {
    const [proj, topic, doc] = line.split("\t");
    const q = doc.replace(/%%/g, " ").replace(/\b(lex|vec):\s*/g, "");
    const idx = ensureIndex({ cwd: repoOf[proj] });
    if (!idx.ok) continue;
    const args = ["--index", idx.index, "query", q, "-n", "5", "--format", "files"];
    if (arm === "norerank") args.push("--no-rerank");
    const t = Date.now();
    const r = runQmd(args, { cwd: idx.dir });
    ms += Date.now() - t; n++;
    const hits = [...r.stdout.matchAll(/qmd:\/\/[^/]+\/([^\s:,]+\.md)/g)].map((m) => m[1]);
    writeFileSync(join(out, `${proj}__${topic}.txt`), hits.join("\n"));
  }
  // A run that answered nothing is not a fast run, it is not a run. This
  // printed `queries: 0, mean_ms: null` and exited 0, which reads as success in
  // any log and in any results file. The usual cause is a SRC that is already a
  // written pool rather than the raw corpus, so every `remember` is refused for
  // an empty body and there is nothing to index.
  if (n === 0) { console.error(`arm ${arm} answered 0 of the supplied queries — no index was built. Is SRC the raw corpus rather than a written pool?`); process.exit(1); }
  console.log(JSON.stringify({ arm, queries: n, mean_ms: Math.round(ms / n), artifacts: out }));
}
console.log(JSON.stringify({ map: join(HOME, "_map.json"), home: HOME }));
