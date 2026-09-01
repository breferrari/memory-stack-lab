#!/usr/bin/env node
/**
 * A STRATIFIED query set: paraphrase, identifier, and short-ambiguous.
 *
 *   node harness/gen-paraphrase-queries.mjs <corpus-dir> <out.tsv>
 *
 * The existing fixture derives its queries from the documents, so lexical
 * search alone can win and query expansion has nothing to contribute. That
 * makes it the wrong instrument for asking whether expansion or reranking earn
 * their cost — it is the one case they are not for.
 *
 * The honest fix is not "write vaguer queries", which only measures how much
 * signal you destroyed. It is to describe the same problem from the SYMPTOM a
 * person would actually arrive with, using vocabulary the document does not
 * contain, and then MEASURE the lexical distance so nobody has to take the
 * wording on trust.
 *
 * A set of only paraphrases is still a rigged instrument, in the other
 * direction: query expansion is expected to help there and to HURT on
 * identifier-shaped lookups — an error code, a symbol, an exception name — which
 * are a large share of real debugging. An experiment that contains only the
 * favourable stratum can produce one answer, so it is not a test. Three strata
 * are emitted and scored separately; averaging them would hide exactly the
 * trade this is meant to expose.
 *
 *   B  paraphrase        the symptom, in words the document does not use
 *   C  identifier        an error string or symbol, as someone would paste it
 *   D  short ambiguous   under eight tokens, deliberately underspecified
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = process.argv[2];
const OUT = process.argv[3];
if (!SRC || !OUT) { console.error("usage: gen-paraphrase-queries.mjs <corpus-dir> <out.tsv>"); process.exit(1); }

/**
 * One symptom per topic, phrased as the thing that is actually happening to
 * someone — not as the lesson's own summary. Deliberately avoids the topic's
 * own label and the vocabulary the templates use.
 */
const SYMPTOM = {
  caching: "the page shows yesterday's numbers even right after a change was saved",
  retries: "two charges appeared for one checkout when the network blipped",
  pagination: "scrolling the list shows the same row twice and skips another",
  auth: "people get signed out halfway through a long form",
  featureflags: "half the users see the new screen and half do not, in the same build",
  migrations: "the deploy went out and the old servers started throwing on a column",
  ratelimit: "the third party started returning 429 during the nightly job",
  observability: "we cannot tell which service was slow for one particular customer",
  timezones: "a report for the last day of the month is off by one for some users",
  nullhandling: "a crash with 'undefined is not an object' only for accounts with no address",
  flakytests: "the suite passes locally and fails maybe one run in five on the server",
  ci: "the build takes twenty minutes and most of it is downloading things",
  secrets: "a token ended up somewhere it should not have been",
  errors: "the client shows a spinner forever instead of telling the user what went wrong",
  localization: "German text overflows the button and Japanese sorts in the wrong order",
  performance: "memory climbs all afternoon until the process is killed",
};

const STOP = new Set("the a an and or of to in on for with is are was were be it this that as by at from not no than then when if you your we our they their can could should would must may might do does did done have has had over under into out up down off about after before while each any all some more most other another such only same so nor own too very just also its".split(/\s+/));
const tok = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));
const jaccard = (a, b) => { let h = 0; for (const t of a) if (b.has(t)) h++; return h / (a.size + b.size - h || 1); };

/** Stratum C: what someone actually pastes — a symbol or error, no prose. */
const IDENTIFIER = {
  caching: "stale_cache_hit ETag mismatch",
  retries: "ERR_DUPLICATE_CHARGE idempotency_key",
  pagination: "OFFSET_SKEW cursor_invalid",
  auth: "401 invalid_grant refresh_token_expired",
  featureflags: "FLAG_EVAL_DEFAULT variant_mismatch",
  migrations: "column_does_not_exist relation already exists",
  ratelimit: "HTTP 429 Retry-After",
  observability: "trace_id missing span_context null",
  timezones: "DST_OFFSET_ERROR UTC conversion",
  nullhandling: "TypeError undefined is not an object",
  flakytests: "test_timeout intermittent CI failure",
  ci: "cache miss job took 20m",
  secrets: "AWS_SECRET_ACCESS_KEY committed",
  errors: "unhandled promise rejection 500",
  localization: "i18n missing_key layout overflow",
  performance: "OOMKilled heap_used_bytes",
};

/** Stratum D: too short to be unambiguous on purpose. */
const SHORT = {
  caching: "stale data", retries: "duplicate writes", pagination: "missing rows",
  auth: "token expiry", featureflags: "inconsistent rollout", migrations: "deploy broke schema",
  ratelimit: "throttled", observability: "cannot trace", timezones: "off by one day",
  nullhandling: "null crash", flakytests: "flaky", ci: "slow build",
  secrets: "leaked key", errors: "silent failure", localization: "text overflow", performance: "memory growth",
};

const map = JSON.parse(readFileSync(join(SRC, "_map.json"), "utf8"));
const rows = [];
const overlaps = [];

const perStratum = { B: [], C: [], D: [] };
for (const [id, meta] of Object.entries(map)) {
  let text = "";
  try { text = readFileSync(join(SRC, `${id}.md`), "utf8"); } catch { continue; }
  for (const [stratum, table] of [["B", SYMPTOM], ["C", IDENTIFIER], ["D", SHORT]]) {
    const q = table[meta.topic];
    if (!q) continue;
    const ov = jaccard(tok(q), tok(text));
    overlaps.push(ov);
    perStratum[stratum].push(ov);
    rows.push({ stratum, line: `${meta.project}\t${meta.topic}\tlex: ${q}%%vec: ${q}` });
  }
}

if (!rows.length) { console.error("no queries produced — does the map carry a topic per entry?"); process.exit(1); }

// One file per stratum. Averaging them would hide the trade: a method that
// gains on paraphrases and loses on identifiers is a router candidate, not an
// improvement, and a single mean calls it a win.
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const written = {};
for (const st of ["B", "C", "D"]) {
  const lines = rows.filter((r) => r.stratum === st).map((r) => r.line);
  if (!lines.length) continue;
  const file = OUT.replace(/\.tsv$/, `-${st}.tsv`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  written[st] = { file, queries: lines.length, mean_overlap_with_target: +mean(perStratum[st]).toFixed(4) };
}
writeFileSync(OUT, `${rows.map((r) => r.line).join("\n")}\n`);

console.log(JSON.stringify({
  total_queries: rows.length,
  strata: written,
  overall_mean_overlap: +mean(overlaps).toFixed(4),
  note: "score each stratum separately. B is where expansion is expected to help and C is where it is expected to hurt; a combined mean would report neither.",
}, null, 1));
