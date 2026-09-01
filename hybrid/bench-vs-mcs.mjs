#!/usr/bin/env node
/**
 * Bruno's qmd branch against Vestige, same corpus, same queries, same scorer.
 *
 * His configuration is replicated from hooks/sync-memories.sh on
 * bruno/qmd-retrieval-backend rather than approximated: a named index with
 * QMD_CONFIG_DIR/INDEX_PATH under the project, ONE model in all three of qmd's
 * slots, and the query shape his global_context instructs Claude to use —
 * structured lex/vec, rerank off, limit 5.
 *
 * Two arms for his design, because they scope differently:
 *   mcs-perproject  one index per project directory. Isolation by construction.
 *   mcs-shared      one index over the whole pool, which is what the
 *                   shared-memories pack produces. This is where scoping bites.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Sibling checkout by default; a machine-specific absolute path must never
// reach a public repository.
const PLUGIN = process.env.VESTIGE_PLUGIN ?? resolve(import.meta.dirname, "..", "..", "vestige");
const SRC = process.argv[2];
const QUERIES = process.argv[3];
const OUT = process.argv[4];
const { runQmd, ensureQmd } = await import(pathToFileURL(join(PLUGIN, "core/setup/qmd.ts")).href);
ensureQmd({ update: false });

const map = JSON.parse(readFileSync(join(SRC, "_map.json"), "utf8"));
const docs = readdirSync(SRC).filter((f) => f.endsWith(".md"));
const projects = [...new Set(Object.values(map).map((v) => v.project))].sort();
const queries = readFileSync(QUERIES, "utf8").split("\n").filter(Boolean).map((l) => {
  // The second column is an opaque KEY: a topic in the ladder's corpora, a
  // memory id in the generated one. It used to be treated as a topic and baked
  // into the artifact filename, which the scorers then split on `__` — a
  // separator memory ids contain. Both arms now write _queries.json beside their
  // artifacts, the same contract the Vestige arms use, so the two sides are
  // scored identically. Comparing a fixed scorer against an unfixed one would
  // make the comparison meaningless in our favour.
  const [proj, key, doc] = l.split("\t");
  const lex = doc.split("%%")[0].replace(/^lex:\s*/, "");
  const vec = (doc.split("%%")[1] ?? "").replace(/^vec:\s*/, "");
  return { proj, key, lex, vec };
});

const EMBED = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

/** His config file, written the way his hook writes it. */
function writeConfig(dir, memoriesDir) {
  mkdirSync(dir, { recursive: true });
  // qmd names the config after the INDEX, not "config.yml". Getting this wrong
  // produces "No collections found" from `update`, zero documents, and an
  // `embed` that still reports "All content hashes already have embeddings".
  writeFileSync(join(dir, "memory-loop.yml"),
`collections:
  memories:
    path: '${memoriesDir}'
    pattern: "**/*.md"
models:
  embed: ${EMBED}
  generate: ${EMBED}
  rerank: ${EMBED}
`);
}

function qmdIn(dir, indexPath, args) {
  const prev = { QMD_CONFIG_DIR: process.env.QMD_CONFIG_DIR, INDEX_PATH: process.env.INDEX_PATH };
  process.env.QMD_CONFIG_DIR = dir;
  process.env.INDEX_PATH = indexPath;
  const r = runQmd(args, { cwd: dir });
  process.env.QMD_CONFIG_DIR = prev.QMD_CONFIG_DIR ?? "";
  process.env.INDEX_PATH = prev.INDEX_PATH ?? "";
  return r;
}

const results = {};
rmSync(OUT, { recursive: true, force: true });

// ── arm 1: one index per project, his config ──────────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), "mcs-pp-"));
  const idxOf = {};
  for (const p of projects) {
    const mem = join(root, p, ".claude", "memories");
    mkdirSync(mem, { recursive: true });
    for (const [id, v] of Object.entries(map)) {
      if (v.project === p) writeFileSync(join(mem, `${id}.md`), readFileSync(join(SRC, `${id}.md`), "utf8"));
    }
    const cfg = join(root, p, ".claude", "kb-index");
    writeConfig(cfg, mem);
    const idxPath = join(cfg, "memory-loop.sqlite");
    // `update` rescans the collection for added/changed/removed files; `embed`
    // vectorises what came back. Running embed alone indexes NOTHING and still
    // reports "All content hashes already have embeddings" — which is how the
    // first version of this bench scored 0.000 across the board.
    qmdIn(cfg, idxPath, ["--index", "memory-loop", "update"]);
    qmdIn(cfg, idxPath, ["--index", "memory-loop", "embed"]);
    const st = qmdIn(cfg, idxPath, ["--index", "memory-loop", "status"]);
    const total = Number((st.stdout.match(/Total:\s*(\d+)/) ?? [])[1] ?? 0);
    if (total === 0) throw new Error(`arm indexed 0 documents for ${p} — refusing to score a vacuous run`);
    idxOf[p] = { cfg, idxPath };
  }
  const out = join(OUT, "mcs-perproject");
  mkdirSync(out, { recursive: true });
  let ms = 0;
  for (const q of queries) {
    const { cfg, idxPath } = idxOf[q.proj];
    const doc = `intent: ${q.vec}\nlex: ${q.lex}\nvec: ${q.vec}`;
    const t = Date.now();
    const r = qmdIn(cfg, idxPath, ["--index", "memory-loop", "query", doc, "-n", "5", "--no-rerank", "--format", "files"]);
    ms += Date.now() - t;
    const hits = [...r.stdout.matchAll(/qmd:\/\/[^/]+\/([^\s:,]+\.md)/g)].map((m) => m[1]);
    writeFileSync(join(out, `${q.proj}__${q.key}.txt`), hits.join("\n"));
  }
  writeFileSync(join(out, "_queries.json"), JSON.stringify(queries.map((q) => ({ artifact: `${q.proj}__${q.key}.txt`, project: q.proj, key: q.key })), null, 1));
  results["mcs-perproject"] = { mean_ms: Math.round(ms / queries.length), artifacts: out };
  rmSync(root, { recursive: true, force: true });
}

// ── arm 2: one shared index over every project's memories ─────────────────
{
  const root = mkdtempSync(join(tmpdir(), "mcs-sh-"));
  const mem = join(root, "shared", "memories");
  mkdirSync(mem, { recursive: true });
  for (const d of docs) writeFileSync(join(mem, d), readFileSync(join(SRC, d), "utf8"));
  const cfg = join(root, "kb-index");
  writeConfig(cfg, mem);
  const idxPath = join(cfg, "memory-loop.sqlite");
  qmdIn(cfg, idxPath, ["--index", "memory-loop", "update"]);
  qmdIn(cfg, idxPath, ["--index", "memory-loop", "embed"]);
  const st = qmdIn(cfg, idxPath, ["--index", "memory-loop", "status"]);
  const total = Number((st.stdout.match(/Total:\s*(\d+)/) ?? [])[1] ?? 0);
  if (total !== docs.length) throw new Error(`shared arm indexed ${total} of ${docs.length} documents — refusing to score a vacuous run`);
  const out = join(OUT, "mcs-shared");
  mkdirSync(out, { recursive: true });
  let ms = 0;
  for (const q of queries) {
    const doc = `intent: ${q.vec}\nlex: ${q.lex}\nvec: ${q.vec}`;
    const t = Date.now();
    const r = qmdIn(cfg, idxPath, ["--index", "memory-loop", "query", doc, "-n", "5", "--no-rerank", "--format", "files"]);
    ms += Date.now() - t;
    const hits = [...r.stdout.matchAll(/qmd:\/\/[^/]+\/([^\s:,]+\.md)/g)].map((m) => m[1]);
    writeFileSync(join(out, `${q.proj}__${q.key}.txt`), hits.join("\n"));
  }
  writeFileSync(join(out, "_queries.json"), JSON.stringify(queries.map((q) => ({ artifact: `${q.proj}__${q.key}.txt`, project: q.proj, key: q.key })), null, 1));
  results["mcs-shared"] = { mean_ms: Math.round(ms / queries.length), artifacts: out };
  rmSync(root, { recursive: true, force: true });
}

console.log(JSON.stringify(results, null, 2));
