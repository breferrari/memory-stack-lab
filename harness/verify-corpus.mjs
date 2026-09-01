#!/usr/bin/env node
/**
 * Does this corpus look like the store it claims to model? A gate, not a report.
 *
 *   node harness/verify-corpus.mjs <corpus-dir> [--reference <profile.json>]
 *
 * Every retrieval number this project published once came from a fixture with
 * 0.2 concrete specifics per memory against a real 14.1. A corpus that thin
 * cannot distinguish its own documents, so a ranker cannot either, and the score
 * describes the fixture rather than the system.
 *
 * There is no universal right size for a memory. The tool imposes almost
 * nothing — a body over 8,000 characters only earns a warning suggesting a
 * split, and the search engine chunks rather than truncates — and length
 * follows the kind of thing being recorded. So "too rich" means nothing in the
 * abstract. What means something is differing from your reference: thinner and
 * the system looks broken, richer and it looks solved.
 *
 * The reference is a profile emitted by profile-corpus.mjs, defaulting to
 * reference/vault-memories.json. It is an artifact on purpose. The number this
 * gate first used was remembered from a shell rather than stored, and had
 * counted index-note bullets instead of whole memories: median 61 words against
 * a real 503. Every judgement built on it was wrong by a factor of eight, in the
 * direction that looked most like diligence.
 *
 * Measurement is imported, never redefined here — an earlier version carried its
 * own copy of these regexes, so the gate and the profile were not measuring the
 * same thing and a corpus could satisfy one while missing the other entirely.
 *
 * Exits non-zero when the corpus is not something worth benchmarking on.
 */
import { readFileSync } from "node:fs";
import { bodiesIn, profileBodies, tokens } from "./lib/measure.mjs";

const DIR = process.argv[2];
const ri = process.argv.indexOf("--reference");
const REF = ri > 0 ? process.argv[ri + 1] : "reference/vault-memories.json";
if (!DIR) { console.error("usage: verify-corpus.mjs <corpus-dir> [--reference <profile.json>]"); process.exit(1); }

const bodies = bodiesIn(DIR);
if (!bodies.length) { console.error("empty corpus"); process.exit(1); }
const ref = JSON.parse(readFileSync(REF, "utf8"));
const p = profileBodies(bodies);

// Connectivity is the one axis with no reference number: it is a property of
// this world's service graph, not of any vault. Reported, not gated.
const SERVICES = /\b(INC-\d+|payments-api|ledger|risk-scoring|feature-store|notifications|merchant-dashboard|mobile-ios|auth-gateway)\b/;

const report = {
  memories: p.n,
  words: { median: p.median_words, p10: p.p10_words, p90: p.p90_words },
  distinct_words_total: new Set(bodies.flatMap(tokens)).size,
  distinct_words_per_memory: p.distinct_words_per_doc,
  specifics_per_memory: p.specifics_per_doc,
  distinct_specifics_per_memory: p.distinct_specifics_per_doc,
  memories_naming_another_service_or_incident: bodies.filter((b) => SERVICES.test(b)).length,
  reference: `${ref.name} (n=${ref.n})`,
};

/**
 * Two-sided, because both directions are the same mistake, and half-to-double
 * on each axis: close enough to be the same kind of thing, loose enough that a
 * fixture need not be a forgery of one particular store.
 */
const GATES = [
  ["distinct_words_per_memory", p.distinct_words_per_doc, ref.distinct_words_per_doc],
  ["specifics_per_memory", p.specifics_per_doc, ref.specifics_per_doc],
  // The one that catches repetition dressed as density.
  ["distinct_specifics_per_memory", p.distinct_specifics_per_doc, ref.distinct_specifics_per_doc],
  ["median_words", p.median_words, ref.median_words],
  ["p90_words", p.p90_words, ref.p90_words],
];
const failures = GATES.flatMap(([k, v, r]) =>
  v < r / 2 ? [`${k} = ${v}, below ${(r / 2).toFixed(1)} — too thin to tell documents apart (reference ${r})`]
  : v > r * 2 ? [`${k} = ${v}, above ${(r * 2).toFixed(1)} — richer than production, which flatters the result (reference ${r})`]
  : []);

report.verdict = failures.length ? "DOES NOT MATCH THE REFERENCE STORE" : "realistic enough to benchmark";
report.failures = failures;
console.log(JSON.stringify(report, null, 1));
process.exit(failures.length ? 1 : 0);
