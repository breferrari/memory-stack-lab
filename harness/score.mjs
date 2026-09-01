#!/usr/bin/env node
// Shared scorer for every ablation rung.
// Reads the common artifact — one file per query, `<project>__<topic>.txt`,
// containing returned document identifiers, one per line, in rank order —
// so V0 (docs-mcp-server) and V1..V4 (qmd) are scored by identical code.
//
// Ownership is read from the corpus on disk via `**Applies to:** <repo>`,
// NOT from the manifest: in the flat corpus a filename collision means the
// surviving file belongs to whoever wrote last, and the manifest records all
// 183 intended writes including the 99 that were destroyed.
//
// A query that returned NOTHING scores zero and counts as a failure. It is not
// skipped. (The previous scorer skipped them, which inflated precision by
// excluding exactly the cases where retrieval failed hardest.)
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const ART = process.argv[2];                 // runs/res-<rung>
const CORPUS = process.argv[3];              // runs/scale/<variant>
const LABEL = process.argv[4] || basename(ART);
const K = Number(process.argv[5] || 5);
// The number of QUERIES this run must score, not the size of the corpus. The
// pipeline was passing the pool's document count, which matched only because
// this world happens to produce exactly one query per memory. A guard whose
// reference value is right by coincidence stops being a guard the moment either
// number moves, and says nothing while it does.
const EXPECTED = Number(process.argv[6] || 64);

// ── ownership map: document id -> owning project ─────────────────────
//
// A corpus may ship an explicit `_map.json` ({id: {project, topic}}). The hybrid
// does, because its filenames are `<project>__<title-slug>` and the topic is no
// longer recoverable from the name the way the ladder's corpora allowed. One
// scorer still serves every rung; only the source of the mapping differs.
const owner = new Map();
const topicOf = new Map();
// world memory id -> the document it became after the plugin renamed it on write
const sourceOf = new Map();
try {
  const explicit = JSON.parse(readFileSync(join(CORPUS, "_map.json"), "utf8"));
  for (const [id, v] of Object.entries(explicit)) {
    owner.set(id, v.project);
    topicOf.set(id, v.topic);
    if (v.source) sourceOf.set(v.source, id);
  }
} catch { /* fall through to the Applies-to convention below */ }

/**
 * How a query names its answer.
 *
 * The ladder's corpora ask by topic, and any memory in the asking project on
 * that topic counts. The generated corpus asks for ONE memory by id, because a
 * project there holds many memories on a topic and several of them correct each
 * other. Both are read from `_queries.json`, written beside the artifacts, so
 * neither is re-derived by splitting a filename on `__` — which memory ids
 * contain, and which silently resolved every generated query to the wrong
 * document.
 *
 * Where a gold id resolves, scoring is STRICT: a same-topic sibling is not a
 * hit. That keeps this scorer and analyse-stratum reporting the same number.
 */
const manifest = (() => { try { return JSON.parse(readFileSync(join(ART, "_queries.json"), "utf8")); } catch { return null; } })();
for (const f of readdirSync(CORPUS).filter(f => f.endsWith('.md'))) {
  const body = readFileSync(join(CORPUS, f), 'utf8');
  const m = body.match(/\*\*Applies to:\*\*\s*([a-z0-9-]+)/i);
  if (!m) { console.error(`FATAL: no 'Applies to' in ${f}`); process.exit(1); }
  owner.set(f.replace(/\.md$/, ''), m[1]);
}

const idOf = line => {
  const t = line.trim();
  if (!t) return null;
  // accepts `qmd://coll/<id>.md`, a bare path, or a bare id
  const m = t.match(/([^/\s:]+?)(?:\.md)?$/);
  return m ? m[1] : null;
};

const rows = [];
const files = readdirSync(ART).filter(f => f.endsWith('.txt')).sort();
const entries = manifest
  ? manifest.map(q => ({ f: q.artifact, proj: q.project, key: q.key }))
  : files.map(f => { const [proj, key] = basename(f, '.txt').split('__'); return { f, proj, key }; });
for (const { f, proj, key } of entries) {
  const gold = sourceOf.get(key) ?? null;
  const topic = gold ? (topicOf.get(gold) ?? key) : key;
  const hits = readFileSync(join(ART, f), 'utf8')
    .split('\n').map(idOf).filter(Boolean).slice(0, K);
  const owners = hits.map(h => owner.get(h) ?? null);
  // Relevance, not just ownership: the target document is the one owned by the
  // asking project AND on the asked topic. Under a per-project index every hit
  // is own-project by construction, so ownership precision goes to 1.0 while
  // saying nothing about whether the question was answered. This is the axis
  // that separates "scoped" from "useful".
  const relevant = hits.map((h, i) => owners[i] === proj
    && (gold ? h === gold : topicOf.size ? topicOf.get(h) === topic : h.includes(`_${topic}_`)));
  const unknown = owners.filter(o => o === null).length;
  const own = owners.filter(o => o === proj).length;
  rows.push({
    proj, topic,
    returned: hits.length,
    own,
    foreign: hits.length - own,
    unknown,
    top1_own: hits.length > 0 && owners[0] === proj,
    top1_relevant: hits.length > 0 && relevant[0],
    relevant_in_topk: relevant.some(Boolean),
    relevant_rank: relevant.indexOf(true) + 1,   // 0 = not found
    empty: hits.length === 0,
    owners,
  });
}

// ── non-vacuity guard: a short run silently changes every average ──
if (rows.length !== EXPECTED) {
  console.error(`FATAL: scored ${rows.length} queries, expected ${EXPECTED}. `
    + `A short run silently changes every average — refusing to report.`);
  process.exit(1);
}
const unknownTotal = rows.reduce((s, r) => s + r.unknown, 0);
if (unknownTotal > 0) {
  console.error(`FATAL: ${unknownTotal} returned ids did not map to any corpus document. `
    + `The id normaliser and the corpus disagree — refusing to report.`);
  process.exit(1);
}

const n = rows.length;
// precision@K divides by K, not by hits returned: returning 2 documents of which
// 2 are own is not the same result as returning 5 of which 5 are own, and a rung
// that returns less must not be rewarded for it.
const precision = rows.reduce((s, r) => s + r.own / K, 0) / n;
const summary = {
  rung: LABEL,
  corpus: basename(CORPUS),
  queries: n,
  k: K,
  corpus_docs: owner.size,
  precision_at_k: +(precision).toFixed(3),
  top1_is_own_project: +(rows.filter(r => r.top1_own).length / n).toFixed(3),
  nothing_own_returned: +(rows.filter(r => r.own === 0).length / n).toFixed(3),
  returned_nothing_at_all: +(rows.filter(r => r.empty).length / n).toFixed(3),
  mean_foreign_in_topk: +(rows.reduce((s, r) => s + r.foreign, 0) / n).toFixed(2),
  // the metrics that survive a per-project index
  target_found_in_topk: +(rows.filter(r => r.relevant_in_topk).length / n).toFixed(3),
  target_at_rank1: +(rows.filter(r => r.top1_relevant).length / n).toFixed(3),
  mrr: +(rows.reduce((s, r) => s + (r.relevant_rank ? 1 / r.relevant_rank : 0), 0) / n).toFixed(3),
};
console.log(JSON.stringify(summary, null, 2));
writeFileSync(join(ART, '_score.json'), JSON.stringify({ summary, rows }, null, 2));
