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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const srcMap = JSON.parse(readFileSync(join(SRC, "_map.json"), "utf8"));
const projects = [...new Set(Object.values(srcMap).map((v) => v.project))].sort();
const root = mkdtempSync(join(tmpdir(), "rr-repos-"));
const repoOf = {};
for (const p of projects) { const d = join(root, p); mkdirSync(d, { recursive: true }); execFileSync("git", ["init", "-q", d]); repoOf[p] = d; }

const idMap = {};
for (const [id, meta] of Object.entries(srcMap)) {
  const md = readFileSync(join(SRC, `${id}.md`), "utf8");
  const title = (md.match(/^# (.+)$/m) ?? [])[1] ?? id;
  const body = md.slice(md.indexOf("## Problem")).replace(/^## Problem\s*/, "").replace(/\n## /g, "\n\n").trim();
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
