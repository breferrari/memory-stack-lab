#!/usr/bin/env node
/**
 * Deterministic incident seeds — the shared ancestor of a memory and a query.
 *
 *   node harness/gen-seeds.mjs <out.json> [count]
 *
 * Today's fixtures failed in two opposite ways and both came from the same
 * mistake: the query and the document were not independent. Queries written FROM
 * the documents share their vocabulary and make retrieval look solved; queries
 * written from the documents and then stripped of shared words make it look
 * broken. Neither is a workload.
 *
 * A seed fixes that. It describes an incident — stack, symptom, the specific
 * things a real engineer would have seen: an error code, a threshold, a symbol,
 * a version. The memory is written from the seed. The query is written from the
 * seed, by a separate call that never sees the memory. Both descend from the
 * situation; neither descends from the other.
 *
 * The specifics matter as much as the independence. A 64-word generic paragraph
 * cannot be told apart from its neighbour by any ranker, because the
 * information to prefer one is not in the document. Real memories carry
 * `idempotency_key`, `500 rows`, `EPERM`, `v14.2` — and those are what a
 * symptom query eventually collides with.
 */
import { writeFileSync } from "node:fs";

const OUT = process.argv[2];
const COUNT = Number(process.argv[3] ?? 183);
if (!OUT) { console.error("usage: gen-seeds.mjs <out.json> [count]"); process.exit(1); }

let seed = 20260901;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo));

const PROJECTS = [
  { repo: "payments-api", domain: "payment processing", stack: "Node + Postgres" },
  { repo: "mobile-ios", domain: "an iOS client", stack: "Swift + CoreData" },
  { repo: "analytics-pipeline", domain: "batch analytics", stack: "Python + Airflow" },
  { repo: "auth-service", domain: "authentication", stack: "Go + Redis" },
  { repo: "search-index", domain: "search indexing", stack: "Rust + Tantivy" },
  { repo: "billing-web", domain: "a billing dashboard", stack: "TypeScript + React" },
  { repo: "notifications", domain: "push and email delivery", stack: "Node + SQS" },
  { repo: "ml-risk-models", domain: "risk scoring", stack: "Python + PyTorch" },
];

const TOPICS = [
  { key: "retries", what: "a retried write produced a duplicate", symbols: ["idempotency_key", "ERR_DUPLICATE", "X-Request-Id"] },
  { key: "caching", what: "a cache served a value that was already stale", symbols: ["ETag", "cache_key", "max-age"] },
  { key: "migrations", what: "a schema change broke running instances mid-deploy", symbols: ["column_not_found", "ALTER TABLE", "pg_locks"] },
  { key: "ratelimit", what: "an upstream started rejecting a burst", symbols: ["429", "Retry-After", "token_bucket"] },
  { key: "auth", what: "sessions ended earlier than anyone expected", symbols: ["invalid_grant", "refresh_token", "exp claim"] },
  { key: "performance", what: "memory grew until the process was killed", symbols: ["OOMKilled", "heap_used_bytes", "RSS"] },
  { key: "flakytests", what: "a test passed locally and failed intermittently on CI", symbols: ["--runInBand", "TimeoutError", "seed"] },
  { key: "observability", what: "a slow request could not be traced to a service", symbols: ["trace_id", "span_context", "W3C traceparent"] },
  { key: "timezones", what: "a daily figure was wrong for some users", symbols: ["DST", "UTC offset", "toISOString"] },
  { key: "nullhandling", what: "an optional field crashed a code path", symbols: ["undefined is not an object", "COALESCE", "Optional.none"] },
  { key: "ci", what: "the pipeline spent most of its time not building", symbols: ["actions/cache", "restore-keys", "cold start"] },
  { key: "secrets", what: "a credential reached somewhere it should not have", symbols: ["AWS_SECRET_ACCESS_KEY", ".env", "git filter-repo"] },
];

const seeds = [];
for (let i = 0; i < COUNT; i++) {
  const p = PROJECTS[i % PROJECTS.length];
  const t = TOPICS[Math.floor(i / PROJECTS.length) % TOPICS.length];
  seeds.push({
    id: `${p.repo}__${t.key}__${String(i).padStart(3, "0")}`,
    project: p.repo, domain: p.domain, stack: p.stack, topic: t.key,
    incident: t.what,
    // Specifics are what make a document findable and a symptom recognisable.
    // Generated per seed so two memories on one topic are not near-clones.
    symbol: pick(t.symbols),
    threshold: `${int(2, 900)}${pick(["", "0", " rows", "ms", " MB", " req/s"])}`,
    version: `v${int(1, 19)}.${int(0, 12)}`,
    component: pick(["the worker", "the request handler", "the nightly job", "the sync loop", "the migration step", "the client SDK"]),
    discovered: pick(["in production", "in staging after a deploy", "during an incident review", "while profiling", "in a customer report"]),
  });
}
writeFileSync(OUT, JSON.stringify(seeds, null, 1));
console.log(JSON.stringify({ seeds: seeds.length, projects: PROJECTS.length, topics: TOPICS.length, note: "memory and query are both written from these, independently" }, null, 1));
