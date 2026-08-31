#!/usr/bin/env node
// Generates a realistic multi-domain shared memory corpus in the MCS shape:
// one flat pool, filenames `(learning|decision)_<topic>_<specific>.md`,
// `**Applies to:** <repo>` inside the body. Deterministic (seeded).
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2];
const MODE = process.argv[3] || 'flat';   // flat | ns | rich
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ── deterministic RNG ────────────────────────────────────────────────
let seed = 20260830;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = a => a[Math.floor(rnd() * a.length)];
const shuffle = a => { const c = [...a]; for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; } return c; };

// ── the matrix ───────────────────────────────────────────────────────
const PROJECTS = [
  { repo: 'mobile-ios',          domain: 'frontend', stack: 'Swift / SwiftUI / Combine' },
  { repo: 'mobile-android',      domain: 'frontend', stack: 'Kotlin / Compose / Coroutines' },
  { repo: 'web-app',             domain: 'frontend', stack: 'TypeScript / React / Vite' },
  { repo: 'payments-service',    domain: 'backend',  stack: 'Kotlin / Spring Boot / Postgres' },
  { repo: 'onboarding-service',  domain: 'backend',  stack: 'Kotlin / Spring Boot / Postgres' },
  { repo: 'ledger-service',      domain: 'backend',  stack: 'Kotlin / Spring Boot / Postgres' },
  { repo: 'identity-service',    domain: 'backend',  stack: 'Kotlin / Spring Boot / Redis' },
  { repo: 'trading-service',     domain: 'backend',  stack: 'Kotlin / Spring Boot / Kafka' },
  { repo: 'notification-service',domain: 'backend',  stack: 'Kotlin / Spring Boot / Kafka' },
  { repo: 'reporting-service',   domain: 'backend',  stack: 'Kotlin / Spring Boot / Postgres' },
  { repo: 'document-service',    domain: 'backend',  stack: 'Kotlin / Spring Boot / S3' },
  { repo: 'platform-infra',      domain: 'infra',    stack: 'Terraform / AWS' },
  { repo: 'k8s-platform',        domain: 'infra',    stack: 'Kubernetes / Helm / ArgoCD' },
  { repo: 'analytics-pipeline',  domain: 'data',     stack: 'Airflow / dbt / Snowflake' },
  { repo: 'data-warehouse',      domain: 'data',     stack: 'dbt / Snowflake / SQL' },
  { repo: 'ml-risk-models',      domain: 'data',     stack: 'Python / scikit-learn / MLflow' },
];

// Topics that genuinely recur across every domain — this is where
// cross-project retrieval actually collides in real life.
const TOPICS = {
  caching:        { slug: 'caching',        label: 'cache invalidation' },
  retries:        { slug: 'retries',        label: 'retry and idempotency' },
  pagination:     { slug: 'pagination',     label: 'pagination' },
  auth:           { slug: 'auth',           label: 'auth token handling' },
  featureflags:   { slug: 'featureflags',   label: 'feature flags' },
  migrations:     { slug: 'migrations',     label: 'schema migration' },
  ratelimit:      { slug: 'ratelimit',      label: 'rate limiting' },
  observability:  { slug: 'observability',  label: 'logging and tracing' },
  timezones:      { slug: 'timezones',      label: 'date and timezone handling' },
  nullhandling:   { slug: 'nullhandling',   label: 'null and optional handling' },
  flakytests:     { slug: 'flakytests',     label: 'flaky tests' },
  ci:             { slug: 'ci',             label: 'CI pipeline' },
  secrets:        { slug: 'secrets',        label: 'secrets management' },
  errors:         { slug: 'errors',         label: 'error handling' },
  localization:   { slug: 'localization',   label: 'localization' },
  performance:    { slug: 'performance',    label: 'performance and memory' },
};

// Per-domain technical realisation of each shared topic.
const BODY = {
  frontend: {
    caching: p => [`The in-memory image and response cache in ${p.repo} is keyed by URL alone, which returns a stale asset after a server-side replacement.`,
      `Include the ETag in the cache key, and clear the entry on any mutation of the owning resource. On ${p.stack.split(' / ')[1]} the eviction must run on the main actor or the UI reads a freed entry.`],
    retries: p => [`Network retries in ${p.repo} previously replayed the whole request including the mutation body, producing duplicate submissions on flaky mobile networks.`,
      `Attach a client-generated idempotency key to every mutating call and reuse it across retries of the same user intent. Only retry on transport errors and 5xx, never on 4xx.`],
    pagination: p => [`Cursor pagination in ${p.repo} broke when the list was sorted by a non-unique column: items were skipped across page boundaries.`,
      `Sort by (createdAt, id) and encode both in the cursor. Never derive the cursor from an offset — inserts during scroll shift every subsequent page.`],
    auth: p => [`Token refresh in ${p.repo} was driven by a timer, which fired while the app was backgrounded and burned refresh tokens.`,
      `Refresh on a 401 response instead, behind a single-flight guard so concurrent requests share one refresh. Migrate stored credentials before the first biometric prompt or the refresh token is wiped.`],
    featureflags: p => [`Flags are read once at launch in ${p.repo}, so a remote change does not take effect until a cold start.`,
      `Read the flag at the decision point, not at startup, and treat a missing flag as the off state. Never branch UI layout on a flag read during view construction — the value can change mid-render.`],
    migrations: p => [`Local database migrations in ${p.repo} ran on the main thread and blocked launch for large stores.`,
      `Run migrations off the main thread behind a launch gate, and always ship a fallback that recreates the store rather than crashing on an unmigratable schema.`],
    ratelimit: p => [`The client in ${p.repo} retried a rate-limited endpoint immediately, which extended the ban window.`,
      `Honour Retry-After. Apply exponential backoff with jitter, and cap concurrent in-flight requests per host.`],
    observability: p => [`Log lines in ${p.repo} interpolated user-identifying values directly into the message body.`,
      `Log structured events with stable keys and pass identifiers as redactable fields. Never log a full request body on the client.`],
    timezones: p => [`Dates rendered in ${p.repo} used the device timezone while the backend emits UTC, so a transaction near midnight showed on the wrong day.`,
      `Parse as UTC, convert only at the formatting boundary, and never compare formatted strings.`],
    nullhandling: p => [`Force-unwrapping an optional decoded from the API crashed ${p.repo} whenever the backend omitted a newly-added field.`,
      `Decode new fields as optional and default at the model boundary. A missing field is a normal state during a rollout, not an error.`],
    flakytests: p => [`UI tests in ${p.repo} were flaky because they asserted on animation-driven state.`,
      `Disable animations under test and wait on an explicit accessibility state rather than a sleep.`],
    ci: p => [`The ${p.repo} pipeline rebuilt dependencies on every run because the cache key included a timestamp.`,
      `Key the cache on the lockfile hash. A cache key that changes every run is a cache that never hits.`],
    secrets: p => [`API keys were checked into the ${p.repo} repository inside a configuration plist.`,
      `Inject at build time from the secret store and fail the build when the value is absent, rather than shipping a placeholder.`],
    errors: p => [`Error handling in ${p.repo} collapsed every failure into a single generic alert, so retryable and terminal failures were indistinguishable.`,
      `Model the error domain explicitly and drive both the copy and the retry affordance from it.`],
    localization: p => [`Concatenated strings in ${p.repo} broke in languages where the clause order differs.`,
      `Use positional placeholders in the resource, never string concatenation, and pseudo-localize in CI to catch truncation.`],
    performance: p => [`A retain cycle between the view model and its closure in ${p.repo} leaked one controller per navigation.`,
      `Capture weakly in escaping closures and assert on the deallocation in a test.`],
  },
  backend: {
    caching: p => [`The read-through cache in ${p.repo} was invalidated by the writer, so a rollback left a stale entry served indefinitely.`,
      `Invalidate after commit, in the same transactional outbox that publishes the domain event. A cache invalidated before commit is a cache that lies on rollback.`],
    retries: p => [`Retries against ${p.repo} without an idempotency key double-applied a mutation when the client timed out after the write committed.`,
      `Require an idempotency key on every mutating endpoint, persist the key with the result, and return the stored response on replay. Key retention must outlive the client's maximum retry window.`],
    pagination: p => [`Offset pagination in ${p.repo} degraded badly past a few hundred thousand rows and skipped records under concurrent inserts.`,
      `Use keyset pagination on (created_at, id) with a covering index. Offsets are a scan, not a seek.`],
    auth: p => [`Service-to-service tokens in ${p.repo} were cached past their expiry because the refresh used the issued-at claim rather than expiry.`,
      `Refresh on expiry minus a safety margin, single-flight per audience, and fail closed when the token endpoint is unavailable.`],
    featureflags: p => [`A flag evaluated per request in ${p.repo} caused an N+1 lookup against the flag service under load.`,
      `Evaluate once per request at the edge and propagate the decision in the request context. Treat an unreachable flag service as the off state.`],
    migrations: p => [`A non-concurrent index build in ${p.repo} took an ACCESS EXCLUSIVE lock and stalled writes during a deploy window.`,
      `Build indexes concurrently, split expand-and-contract migrations across releases, and never combine a schema change with a data backfill in one step.`],
    ratelimit: p => [`The token bucket in ${p.repo} was per-instance, so the effective limit scaled with replica count.`,
      `Move the bucket to shared state keyed by principal, and return Retry-After so clients can back off correctly.`],
    observability: p => [`Trace context was dropped across the async boundary in ${p.repo}, so downstream spans were orphaned.`,
      `Propagate the context explicitly into coroutine scopes; a thread-local does not survive a dispatcher switch.`],
    timezones: p => [`Timestamps were stored in ${p.repo} without a zone, so a daylight-saving transition shifted reporting windows by an hour.`,
      `Store instants in UTC with an explicit type, and keep the business timezone as separate data, never implied by the server locale.`],
    nullhandling: p => [`A platform type crossing the Java boundary in ${p.repo} bypassed null checks and surfaced as an NPE deep in a handler.`,
      `Annotate the boundary and convert to a nullable Kotlin type at the edge, not at the point of use.`],
    flakytests: p => [`Integration tests in ${p.repo} shared a database and failed non-deterministically when run in parallel.`,
      `Isolate per test with a transactional rollback or a container per class. A test that passes only in serial hides a concurrency bug.`],
    ci: p => [`The ${p.repo} build ran the full integration suite on every push, so the pipeline exceeded the merge queue timeout.`,
      `Split fast unit checks from the integration stage and gate the slow stage on the merge queue only.`],
    secrets: p => [`Database credentials in ${p.repo} were injected as plain environment variables and appeared in crash dumps.`,
      `Mount from the secret manager, scrub the environment from diagnostic output, and rotate on a schedule the application can survive.`],
    errors: p => [`${p.repo} returned 500 for validation failures, which caused clients to retry an unretryable request.`,
      `Map domain errors to status codes deliberately: 4xx is terminal, 5xx invites a retry. The status code is a contract with every caller.`],
    localization: p => [`Server-rendered copy in ${p.repo} was selected from the Accept-Language header without a fallback chain.`,
      `Resolve through an explicit fallback chain to a default locale, and never fail a request because a translation is missing.`],
    performance: p => [`A blocking JDBC call inside a coroutine in ${p.repo} starved the shared dispatcher under load.`,
      `Confine blocking calls to a dedicated dispatcher sized to the connection pool.`],
  },
  infra: {
    caching: p => [`CDN cache keys in ${p.repo} omitted the Vary header, so a compressed response was served to a client that could not decode it.`,
      `Include the negotiated encoding in the key and set an explicit max-age; a default TTL is not a caching strategy.`],
    retries: p => [`Terraform retries in ${p.repo} re-ran a create after a partially-applied resource, orphaning infrastructure.`,
      `Import the orphan before re-applying, and never force-unlock state during an in-flight apply — a forced unlock during apply corrupts the state file.`],
    pagination: p => [`Cloud API listings in ${p.repo} were consumed without following the continuation token, so inventory scans silently truncated.`,
      `Always drain the paginator; a partial listing that returns success is worse than a failure.`],
    auth: p => [`Long-lived static credentials were used for CI access to ${p.repo} because federated identity was not wired up.`,
      `Move to short-lived federated credentials scoped per workflow, and alarm on any use of a static key.`],
    featureflags: p => [`Infrastructure toggles in ${p.repo} lived in variable files, so enabling one required a full plan and apply.`,
      `Keep runtime toggles out of the infrastructure layer entirely; they belong in the application's flag system.`],
    migrations: p => [`A provider major-version bump in ${p.repo} silently rewrote resource defaults during a routine apply.`,
      `Pin provider versions, and read the plan for in-place replacements before approving.`],
    ratelimit: p => [`Cloud provider API throttling during a large apply in ${p.repo} failed the run halfway through.`,
      `Reduce parallelism and add retry with backoff at the provider level rather than re-running the whole apply.`],
    observability: p => [`Cluster logs in ${p.repo} were shipped without resource attributes, so a noisy pod could not be attributed to a team.`,
      `Enforce ownership labels at admission and propagate them into every log and metric.`],
    timezones: p => [`Scheduled jobs in ${p.repo} were defined in local time and shifted with daylight saving.`,
      `Define schedules in UTC and document the local intent in a comment, not in the expression.`],
    nullhandling: p => [`An unset optional variable in ${p.repo} interpolated as an empty string and produced a resource with a blank name.`,
      `Validate required inputs at the module boundary and fail the plan, not the apply.`],
    flakytests: p => [`Infrastructure tests in ${p.repo} were flaky because they asserted on eventually-consistent cloud state immediately after create.`,
      `Poll for the terminal state with a bounded timeout instead of asserting once.`],
    ci: p => [`Concurrent pipeline runs in ${p.repo} raced on the same state lock and one run clobbered the other's plan.`,
      `Serialise applies per environment through a concurrency group keyed on the workspace.`],
    secrets: p => [`Secrets in ${p.repo} were written into state, which is stored unencrypted at rest in the default configuration.`,
      `Treat state as a secret artifact: encrypt the backend, restrict read access, and prefer references over materialised values.`],
    errors: p => [`A failed apply in ${p.repo} left the environment half-migrated with no record of which steps had run.`,
      `Make every change idempotent and re-runnable; recovery should be "run it again", not a manual reconciliation.`],
    localization: p => [`Region-specific resources in ${p.repo} were hardcoded to one region, blocking a second-market rollout.`,
      `Parameterise region at the module level and keep per-region values in tfvars, never inline.`],
    performance: p => [`Node autoscaling in ${p.repo} thrashed because the scale-down threshold sat inside the scale-up band.`,
      `Separate the thresholds with a stabilisation window wide enough to absorb a deploy.`],
  },
  data: {
    caching: p => [`Materialised views in ${p.repo} were refreshed on a fixed schedule that ran before the upstream load finished, publishing a partial day.`,
      `Trigger the refresh on upstream completion, not on a clock, and expose the watermark so consumers can tell what is included.`],
    retries: p => [`A retried task in ${p.repo} re-inserted rows because the load step was not idempotent.`,
      `Make loads idempotent with a merge keyed on the natural key plus the batch id, so a retry converges rather than duplicates.`],
    pagination: p => [`Extraction from a source API in ${p.repo} used offsets and silently missed records when the source was written to mid-extract.`,
      `Extract by an immutable watermark column and record the high-water mark per run.`],
    auth: p => [`Warehouse credentials in ${p.repo} were shared across pipelines, so a revocation broke unrelated jobs.`,
      `Issue one role per pipeline with least privilege; a shared credential turns every rotation into an outage.`],
    featureflags: p => [`Model behaviour in ${p.repo} was switched by editing a constant and redeploying, so experiment arms could not be compared.`,
      `Parameterise the arm and record it with every prediction, or the experiment is unanalysable after the fact.`],
    migrations: p => [`A column type change in ${p.repo} silently truncated values because the transformation ran before validation.`,
      `Validate against the new constraint on a shadow table first, then swap. Never migrate and transform in one statement.`],
    ratelimit: p => [`Parallel extraction tasks in ${p.repo} exhausted the source API quota and starved the incremental job.`,
      `Cap concurrency per source and give incremental jobs a reserved share of the quota.`],
    observability: p => [`Pipeline failures in ${p.repo} were visible only in task logs, so a silent partial load went unnoticed for days.`,
      `Assert row-count and freshness expectations as tests, and alert on the assertion rather than on the exception.`],
    timezones: p => [`Daily aggregates in ${p.repo} were bucketed in the warehouse session timezone, which differs from the business day.`,
      `Bucket explicitly against the declared business timezone and store the boundary with the aggregate.`],
    nullhandling: p => [`Nulls in a join key in ${p.repo} silently dropped rows, understating a metric by a few percent.`,
      `Assert null-rate on join keys as a test; a quiet row-loss is worse than a failure because nobody investigates it.`],
    flakytests: p => [`Data tests in ${p.repo} failed intermittently because they ran against live upstream tables.`,
      `Pin tests to a frozen fixture; a test whose input changes underneath it cannot fail usefully.`],
    ci: p => [`The ${p.repo} pipeline ran a full refresh on every pull request, which exhausted the warehouse credits budget.`,
      `Run incremental builds against a limited sample in CI and reserve full refreshes for the scheduled run.`],
    secrets: p => [`A notebook in ${p.repo} embedded a warehouse token and was committed with output cells intact.`,
      `Strip outputs in a pre-commit hook and read credentials from the environment; a committed notebook output is a published artifact.`],
    errors: p => [`A failing transform in ${p.repo} was caught and logged, so the pipeline reported success with missing data.`,
      `Fail loudly. A caught exception that leaves the output incomplete is a data incident with a green checkmark.`],
    localization: p => [`Currency amounts in ${p.repo} were aggregated across markets without normalising to a single currency.`,
      `Normalise at load time against the rate valid for the event date, and keep the original alongside.`],
    performance: p => [`A model retrain in ${p.repo} loaded the full feature table into memory and was killed by the scheduler.`,
      `Batch by partition with a bounded memory budget, and checkpoint between partitions.`],
  },
};

const SPECIFIC = {
  caching: ['stale_entry', 'key_design', 'invalidation_order'],
  retries: ['idempotency_key', 'backoff', 'duplicate_writes'],
  pagination: ['cursor_stability', 'offset_drift', 'page_boundary'],
  auth: ['token_refresh', 'single_flight', 'credential_scope'],
  featureflags: ['read_timing', 'default_off', 'evaluation_cost'],
  migrations: ['lock_contention', 'expand_contract', 'rollback_path'],
  ratelimit: ['retry_after', 'shared_bucket', 'concurrency_cap'],
  observability: ['context_propagation', 'structured_fields', 'redaction'],
  timezones: ['utc_boundary', 'dst_shift', 'business_day'],
  nullhandling: ['boundary_conversion', 'optional_decode', 'join_key_nulls'],
  flakytests: ['shared_state', 'timing_assertions', 'frozen_fixture'],
  ci: ['cache_key', 'stage_split', 'concurrency_group'],
  secrets: ['injection', 'state_at_rest', 'rotation'],
  errors: ['status_mapping', 'error_domain', 'silent_failure'],
  localization: ['placeholder_order', 'fallback_chain', 'normalisation'],
  performance: ['memory_budget', 'dispatcher_starvation', 'retain_cycle'],
};

const TITLE = {
  caching: 'Cache entries must be invalidated after commit, not before',
  retries: 'Every retryable mutation needs an idempotency key',
  pagination: 'Paginate on a stable, unique sort key',
  auth: 'Refresh credentials on rejection, not on a timer',
  featureflags: 'Read flags at the decision point and default to off',
  migrations: 'Split schema change from data change across releases',
  ratelimit: 'Honour Retry-After and cap concurrency per principal',
  observability: 'Propagate context explicitly across async boundaries',
  timezones: 'Store instants in UTC and convert only at the boundary',
  nullhandling: 'Convert nullable values at the boundary, not at use',
  flakytests: 'Isolate test state; a serial-only pass hides a race',
  ci: 'Key caches on content, and split slow stages from fast ones',
  secrets: 'Inject secrets at runtime and fail closed when absent',
  errors: 'Map failures deliberately; the status code is a contract',
  localization: 'Use positional placeholders and an explicit fallback chain',
  performance: 'Bound the memory and concurrency budget explicitly',
};

const topicKeys = Object.keys(TOPICS);
let n = 0;
const manifest = [];
const collisions = new Map();

for (const p of PROJECTS) {
  // each project covers 9-14 of the 16 shared topics
  const count = 9 + Math.floor(rnd() * 6);
  for (const t of shuffle(topicKeys).slice(0, count)) {
    const kind = rnd() < 0.34 ? 'decision' : 'learning';
    const spec = pick(SPECIFIC[t]);
    // flat = MCS convention (no project component). ns/rich = namespaced.
    const fname = MODE === 'flat'
      ? `${kind}_${TOPICS[t].slug}_${spec}.md`
      : `${p.repo}__${kind}_${TOPICS[t].slug}_${spec}.md`;
    const [problem, solution] = BODY[p.domain][t](p);
    const bare = `# ${TITLE[t]}\n\n**Applies to:** ${p.repo}\n\n## Problem\n\n${problem}\n\n## Solution\n\n${solution}\n`;
    const rich = `---\nscope: project\nprojects:\n  - ${p.repo}\ndomain: ${p.domain}\nstack: ${p.stack}\ntopic: ${TOPICS[t].slug}\nkind: ${kind}\n---\n\n# ${p.repo} — ${TITLE[t]}\n\n**Applies to:** ${p.repo} (${p.domain}, ${p.stack})\n\n> Scoped to the ${p.repo} repository only. Concerns ${TOPICS[t].label} as it behaves in a ${p.domain} codebase built on ${p.stack}. It does not describe any other repository.\n\n## Problem\n\n${problem}\n\n## Solution\n\n${solution}\n\n## Context\n\nRepository: ${p.repo}. Domain: ${p.domain}. Stack: ${p.stack}. Topic: ${TOPICS[t].label}.\n`;
    const body = MODE === 'rich' ? rich : bare;
    manifest.push({ repo: p.repo, domain: p.domain, topic: t, fname, bytes: body.length });
    if (!collisions.has(fname)) collisions.set(fname, []);
    collisions.get(fname).push(p.repo);
    // flat pool, last writer wins — exactly what the shared repo does
    writeFileSync(join(OUT, fname), body);
    n++;
  }
}

const colliding = [...collisions.entries()].filter(([, v]) => v.length > 1);
const lostRepos = new Set();
for (const [, v] of colliding) v.slice(0, -1).forEach(r => lostRepos.add(r));

console.log(JSON.stringify({
  projects: PROJECTS.length,
  memories_written: n,
  unique_filenames: collisions.size,
  colliding_filenames: colliding.length,
  memories_lost_to_collision: n - collisions.size,
  loss_pct: +(((n - collisions.size) / n) * 100).toFixed(1),
  worst: colliding.sort((a, b) => b[1].length - a[1].length).slice(0, 6)
    .map(([f, v]) => ({ file: f, claimed_by: v })),
}, null, 2));
writeFileSync(join(OUT, '..', 'manifest.json'), JSON.stringify(manifest, null, 2));
