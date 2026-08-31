#!/usr/bin/env node
// Measures cross-project retrieval precision on a shared memory pool.
// For each project, asks questions an engineer in that project would ask —
// deliberately WITHOUT naming the project, because a real session doesn't.
// Scores: what fraction of top-k results actually belong to that project.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('./scale/manifest.json', import.meta.url), 'utf8'));
const PROJECTS = [...new Set(manifest.map(m => m.repo))];
const byProject = {};
for (const m of manifest) (byProject[m.repo] ??= new Set()).add(m.topic);

// natural-language questions per topic; no project name anywhere
const Q = {
  caching:       ['lex: cache invalidation stale entry key', 'vec: how do we invalidate a cached entry after a write so it stops serving stale data'],
  retries:       ['lex: retry idempotency duplicate', 'vec: how do we stop a retried request from applying the same change twice'],
  pagination:    ['lex: pagination cursor offset page', 'vec: why are records being skipped between pages when new rows arrive'],
  auth:          ['lex: token refresh credential expiry', 'vec: when should an access token be refreshed and how do we avoid concurrent refreshes'],
  featureflags:  ['lex: feature flag toggle default', 'vec: when is a feature flag evaluated and what happens if the flag service is unreachable'],
  migrations:    ['lex: migration schema lock deploy', 'vec: how do we run a schema change safely without blocking during a deploy window'],
  ratelimit:     ['lex: rate limit throttling backoff', 'vec: what should happen when we get rate limited by a dependency'],
  observability: ['lex: logging tracing context span', 'vec: how is trace context propagated and what must never be logged'],
  timezones:     ['lex: timezone utc date daylight', 'vec: how are timestamps stored and converted so the day boundary is correct'],
  nullhandling:  ['lex: null optional boundary', 'vec: how do we handle a missing or null value coming across a boundary'],
  flakytests:    ['lex: flaky test isolation shared state', 'vec: why does this test only fail sometimes and how do we make it deterministic'],
  ci:            ['lex: ci pipeline cache build stage', 'vec: why is the pipeline slow and how should the cache key be chosen'],
  secrets:       ['lex: secret credential injection rotation', 'vec: where do credentials come from at runtime and how do we avoid committing them'],
  errors:        ['lex: error handling status code failure', 'vec: how should a failure be surfaced so callers know whether to retry'],
  localization:  ['lex: localization translation placeholder locale', 'vec: how is user-facing copy translated and what breaks in other languages'],
  performance:   ['lex: performance memory concurrency budget', 'vec: what causes memory growth or starvation under load and how is it bounded'],
};

const IDX = process.argv[2];          // ns-idx | rich-idx
const COLL = process.argv[3];         // ns | rich
const K = Number(process.argv[4] || 5);

const slugToProject = slug => {
  // slugs look like `<project-with-dashes>-<kind>-<topic>-<specific>`
  const hit = PROJECTS.filter(p => slug.startsWith(p.replace(/[^a-z0-9]+/gi, '-') + '-'));
  return hit.sort((a, b) => b.length - a.length)[0] ?? null;
};

const rows = [];
for (const proj of PROJECTS) {
  for (const topic of [...byProject[proj]].slice(0, 4)) {
    const doc = Q[topic].join('\n');
    let out = '';
    try {
      out = execFileSync(process.env.QMD_BIN, ['query', doc, '--limit', String(K)], {
        cwd: new URL(`./scale/${IDX}/`, import.meta.url).pathname.slice(1),
        encoding: 'utf8', stdio: ['ignore','pipe','ignore'], maxBuffer: 1 << 24, shell: false,
      });
    } catch { continue; }
    const hits = [...out.matchAll(new RegExp(`qmd://${COLL}/([^\\s:]+)\\.md`, 'g'))].map(m => m[1]);
    if (!hits.length) continue;
    const owners = hits.map(slugToProject);
    const own = owners.filter(o => o === proj).length;
    const top1 = owners[0] === proj;
    rows.push({ proj, topic, k: hits.length, own, foreign: hits.length - own, top1, owners });
  }
}

const n = rows.length;
const precision = rows.reduce((s, r) => s + r.own / r.k, 0) / n;
const top1acc = rows.filter(r => r.top1).length / n;
const anyForeign = rows.filter(r => r.foreign > 0).length / n;
const allForeign = rows.filter(r => r.own === 0).length / n;

console.log(JSON.stringify({
  corpus: COLL, queries: n, k: K,
  precision_at_k: +precision.toFixed(3),
  top1_is_own_project: +top1acc.toFixed(3),
  queries_with_any_foreign_hit: +anyForeign.toFixed(3),
  queries_where_nothing_own_returned: +allForeign.toFixed(3),
}, null, 2));
writeFileSync(new URL(`./scale/bench-${COLL}.json`, import.meta.url), JSON.stringify(rows, null, 2));
