#!/usr/bin/env node
/**
 * A world, not a list of seeds.
 *
 *   node harness/gen-world.mjs <out.json> [memories]
 *
 * The templated corpus this replaces had 183 independent paragraphs. A real
 * store is not that. The same service is named across a dozen memories; one
 * incident is recorded twice from different angles; a later lesson supersedes an
 * earlier one; vocabulary recurs because it is the SAME SYSTEM. That structure
 * is most of what retrieval has to cope with, and its absence is why the
 * siblings in the old fixture were interchangeable — nothing distinguished them
 * because nothing connected anything.
 *
 * So the generator starts from an architecture and a timeline:
 *
 *   services with real dependencies      shared entities across memories
 *   incidents that touch 1-3 services    the same event, recorded from each side
 *   a chronology                         later memories reference earlier ones
 *   revisions                            a lesson that supersedes its predecessor
 *   shared libraries and config keys      vocabulary that recurs for a reason
 *
 * Queries are generated later from the INCIDENT, never from the memory, so the
 * two stay independent — the failure that produced both a 1.000 and a 0.541 on
 * the same system.
 */
import { writeFileSync } from "node:fs";

const OUT = process.argv[2];
const COUNT = Number(process.argv[3] ?? 183);
if (!OUT) { console.error("usage: gen-world.mjs <out.json> [memories]"); process.exit(1); }

let s = 20260901;
const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const some = (a, n) => { const c = [...a]; const o = []; while (o.length < n && c.length) o.push(c.splice(Math.floor(rnd() * c.length), 1)[0]); return o; };
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo));

/** One company, eight services, real dependency edges. */
const SERVICES = [
  { repo: "payments-api",       stack: "Node 20 + Postgres 15",   role: "takes card payments and issues refunds",     deps: ["ledger", "notifications", "risk-scoring"] },
  { repo: "ledger",             stack: "Go 1.22 + Postgres 15",   role: "the double-entry book of record",            deps: [] },
  { repo: "risk-scoring",       stack: "Python 3.12 + PyTorch",   role: "scores a transaction before it is captured", deps: ["feature-store"] },
  { repo: "feature-store",      stack: "Python 3.12 + Redis 7",   role: "serves precomputed features to models",      deps: [] },
  { repo: "notifications",      stack: "Node 20 + SQS",           role: "sends receipts by email and push",           deps: [] },
  { repo: "merchant-dashboard", stack: "TypeScript + React 18",   role: "what merchants log into",                    deps: ["payments-api", "ledger"] },
  { repo: "mobile-ios",         stack: "Swift 5.9 + CoreData",    role: "the consumer app",                           deps: ["payments-api", "auth-gateway"] },
  { repo: "auth-gateway",       stack: "Go 1.22 + Redis 7",       role: "issues and refreshes session tokens",        deps: [] },
];

/** Shared vocabulary that recurs because it is one codebase, not eight. */
const SHARED = {
  libs: ["retry-go v2.4", "pg-pool 8.11", "opentelemetry-js 1.24", "sqs-consumer 9.0", "swift-log 1.5", "tenacity 8.2"],
  keys: ["IDEMPOTENCY_TTL_SECONDS", "PGPOOL_MAX", "OTEL_TRACES_SAMPLER_ARG", "SQS_VISIBILITY_TIMEOUT", "FEATURE_CACHE_TTL", "TOKEN_REFRESH_SKEW"],
  // A signal carries its own unit. Drawing the magnitude separately produced
  // lines like "cache_hit_ratio had climbed to around 350MB", which no engineer
  // would write and no query would match — visible only by reading the prose,
  // never by any count. Each signal now says what a bad value of it looks like.
  signals: [
    { name: "p99_latency_ms", mag: (n) => `${400 + n * 55}ms` },
    { name: "pool_wait_ms", mag: (n) => `${120 + n * 40}ms` },
    { name: "dlq_depth", mag: (n) => `${(n + 2) * 180} messages` },
    { name: "cache_hit_ratio", mag: (n) => `${Math.min(61, 12 + n * 3)}%, down from the usual 94%` },
    { name: "token_refresh_failures", mag: (n) => `${(n + 1) * 30} per minute` },
    { name: "capture_lag_seconds", mag: (n) => `${20 + n * 9} seconds` },
  ],
};

/** Incident classes. Each names the shape a person would recognise it by. */
const CLASSES = [
  { key: "retries",       symptom: "the same charge was captured twice",                          artefacts: ["idempotency_key", "ERR_DUPLICATE_CAPTURE", "409"] },
  { key: "pooling",       symptom: "requests queued behind a database connection pool",           artefacts: ["pool_wait_ms", "PGPOOL_MAX", "too many clients already"] },
  { key: "caching",       symptom: "a value kept being served after it changed",                  artefacts: ["FEATURE_CACHE_TTL", "cache_hit_ratio", "stale read"] },
  { key: "queueing",      symptom: "messages were processed more than once, or not at all",       artefacts: ["SQS_VISIBILITY_TIMEOUT", "dlq_depth", "ReceiptHandle"] },
  { key: "auth",          symptom: "people were signed out in the middle of something",           artefacts: ["invalid_grant", "TOKEN_REFRESH_SKEW", "exp claim"] },
  { key: "migrations",    symptom: "a deploy broke instances that were still running",            artefacts: ["column does not exist", "ALTER TABLE", "pg_locks"] },
  { key: "tracing",       symptom: "a slow request could not be followed across services",        artefacts: ["traceparent", "OTEL_TRACES_SAMPLER_ARG", "span_context"] },
  { key: "memory",        symptom: "a process grew until it was killed",                          artefacts: ["OOMKilled", "RSS", "heap snapshot"] },
  { key: "flakiness",     symptom: "a test failed only sometimes, and only on CI",                artefacts: ["--runInBand", "TimeoutError", "test seed"] },
  { key: "timezones",     symptom: "a daily total was wrong for part of the userbase",            artefacts: ["DST", "UTC offset", "date_trunc"] },
  { key: "ratelimit",     symptom: "an upstream started refusing a burst",                        artefacts: ["429", "Retry-After", "token bucket"] },
  { key: "nullability",   symptom: "an absent field crashed a path that assumed it",              artefacts: ["undefined is not an object", "COALESCE", "Optional.none"] },
];

const incidents = [];
const memories = [];
let day = 0;

while (memories.length < COUNT) {
  const cls = CLASSES[incidents.length % CLASSES.length];
  const primary = pick(SERVICES);
  // An incident spans the service and, often, something it depends on — which is
  // how one event ends up recorded from two sides.
  const others = primary.deps.length && rnd() < 0.55 ? some(primary.deps, 1) : [];
  const involved = [primary.repo, ...others];
  day += int(2, 11);

  const inc = {
    id: `INC-${String(incidents.length + 1).padStart(3, "0")}`,
    day, class: cls.key, symptom: cls.symptom, involved,
    artefact: pick(cls.artefacts),
    lib: pick(SHARED.libs), key: pick(SHARED.keys),
    ...(() => { const sig = pick(SHARED.signals); return { signal: sig.name, magnitude: sig.mag(int(0, 9)) }; })(),
  };
  incidents.push(inc);

  // One memory per involved service: the same event, from each side. That is
  // where genuine near-duplicates come from — related, not interchangeable.
  for (const repo of involved) {
    if (memories.length >= COUNT) break;
    const svc = SERVICES.find((x) => x.repo === repo);
    // Prior notes in this repo, and — separately — prior notes in this repo ON
    // THE SAME TOPIC. A correction is always within a subject: a caching note
    // does not correct a retries note, and allowing it would sink the wrong
    // memory for every retries query, since superseded entries rank last.
    const inRepo = memories.filter((m) => m.project === repo);
    const prior = inRepo.slice(-2);
    const sameTopic = inRepo.filter((m) => m.topic === inc.class);
    const corrects = sameTopic.length && rnd() < 0.35 ? sameTopic[sameTopic.length - 1] : null;
    // A correction is a REVISIT of the same event, so it takes its predecessor's
    // incident and that incident's artefact and signal. Letting it keep its own
    // produced 27 notes claiming to correct a write-up of a different incident:
    // two accurate records of two different things, with an edge between them
    // the prose could not support. Every count said the graph was fine — reading
    // two of them was what showed it.
    const subject = corrects ? incidents.find((i) => i.id === corrects.incident) : inc;
    memories.push({
      id: `${repo}__${inc.class}__${String(memories.length).padStart(3, "0")}`,
      project: repo, topic: inc.class, incident: subject.id, day: inc.day,
      revisits: Boolean(corrects),
      stack: svc.stack, role: svc.role,
      perspective: repo === primary.repo ? "where it originated" : "the service that saw the effect",
      counterpart: involved.filter((r) => r !== repo),
      artefact: subject.artefact, lib: inc.lib, configKey: inc.key, signal: subject.signal, magnitude: subject.magnitude,
      // Later memories in the same repo can reference earlier ones by name, and
      // occasionally correct them outright.
      references: prior.map((p) => p.id),
      supersedes: corrects ? corrects.id : null,
    });
  }
}

// Assert the properties this world claims, rather than trusting that the code
// above produced them. The supersession graph was wrong for a full run and no
// count could see it: 27 edges, all present, all pointing at a note about a
// different event. A generator that states its invariants is the only thing that
// would have caught it before a benchmark did not.
{
  const byId = new Map(memories.map((m) => [m.id, m]));
  const bad = memories.filter((m) => m.supersedes && byId.get(m.supersedes)?.incident !== m.incident);
  if (bad.length) { console.error(`${bad.length} corrections point at a different incident than the note they correct`); process.exit(1); }
  const crossTopic = memories.filter((m) => m.supersedes && byId.get(m.supersedes)?.topic !== m.topic);
  if (crossTopic.length) { console.error(`${crossTopic.length} corrections cross topics`); process.exit(1); }
  const crossProject = memories.filter((m) => m.supersedes && byId.get(m.supersedes)?.project !== m.project);
  if (crossProject.length) { console.error(`${crossProject.length} corrections cross projects`); process.exit(1); }
}

writeFileSync(OUT, JSON.stringify({ services: SERVICES, shared: SHARED, incidents, memories }, null, 1));
const withRefs = memories.filter((m) => m.references.length).length;
console.log(JSON.stringify({
  memories: memories.length, incidents: incidents.length, services: SERVICES.length,
  multi_service_incidents: incidents.filter((i) => i.involved.length > 1).length,
  // What the world OFFERS, not what the prose does. The generator shows a
  // memory the titles of earlier notes in its repo and says it may refer to
  // them; roughly a third actually do. Reporting this as "memories referencing
  // another" overstated the corpus's connectivity by about three times. The
  // realised rate is measured on the corpus by verify-corpus.
  memories_offered_a_prior_note: withRefs,
  supersessions: memories.filter((m) => m.supersedes).length,
}, null, 1));
