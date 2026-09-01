#!/usr/bin/env node
/**
 * Does this corpus look like a real store? A gate, not a report.
 *
 *   node harness/verify-corpus.mjs <corpus-dir> [--reference <dir-of-real-md>]
 *
 * Every retrieval number this project published came from a fixture with 0.1
 * concrete specifics per memory, against 5.8 measured across 413 real memories
 * from a working vault. A corpus that thin cannot distinguish its own documents,
 * so a ranker cannot either, and the resulting score describes the fixture.
 *
 * Targets come from that measurement:
 *   words           median ~61, mean ~117, p90 ~266  (short by default, long tail)
 *   distinct words  ~56 unique tokens per memory
 *   specifics       ~6.0 per memory — backticked identifiers, snake_case,
 *                   numbers with units, error codes, versions
 *   connectivity    memories that name another memory or a sibling service
 *
 * Exits non-zero when a corpus is too thin to benchmark on, because the whole
 * point is to stop measuring against something bare.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = process.argv[2];
const REF = (() => { const i = process.argv.indexOf("--reference"); return i > 0 ? process.argv[i + 1] : null; })();
if (!DIR) { console.error("usage: verify-corpus.mjs <corpus-dir> [--reference <dir>]"); process.exit(1); }

const STOP = new Set("the a an and or of to in on for with is are was were be it this that as by at from not no than then when if you your we our they their can could should would must may might do does did done have has had over under into out up down off about after before while each any all some more most other another such only same so nor own too very just also its".split(/\s+/));
const words = (s) => s.split(/\s+/).filter(Boolean);
const tok = (s) => [...s.toLowerCase().matchAll(/[a-z0-9_.\-]{4,}/g)].map((m) => m[0]).filter((w) => !STOP.has(w));
const SPECIFIC = /`[^`]+`|\b[a-z]+_[a-z_]+\b|\b\d+(?:\.\d+)?\s?(?:ms|s|%|x|MB|GB|KB|rows|req\/s|seconds)?\b|\bERR_[A-Z_]+\b|\bv\d+\.\d+|\b[A-Z][A-Z0-9_]{4,}\b|\b\d{3}\b/g;

const files = readdirSync(DIR).filter((f) => f.endsWith(".md"));
if (!files.length) { console.error("empty corpus"); process.exit(1); }

const bodies = files.map((f) => readFileSync(join(DIR, f), "utf8").replace(/^---[\s\S]*?---\n/, ""));
const lens = bodies.map((b) => words(b).length).sort((a, b) => a - b);
const allTok = bodies.flatMap(tok);
const distinctPer = bodies.reduce((a, b) => a + new Set(tok(b)).size, 0) / bodies.length;
const specPer = bodies.reduce((a, b) => a + (b.match(SPECIFIC) ?? []).length, 0) / bodies.length;
const linked = bodies.filter((b) => /\b(INC-\d+|payments-api|ledger|risk-scoring|feature-store|notifications|merchant-dashboard|mobile-ios|auth-gateway)\b/.test(b)).length;

const at = (p) => lens[Math.min(lens.length - 1, Math.floor(lens.length * p))];
const report = {
  memories: files.length,
  words: { mean: +(lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(0), median: at(0.5), p10: at(0.1), p90: at(0.9), max: lens[lens.length - 1] },
  distinct_words_total: new Set(allTok).size,
  distinct_words_per_memory: +distinctPer.toFixed(1),
  specifics_per_memory: +specPer.toFixed(1),
  memories_naming_another_service_or_incident: linked,
  reference: REF ? REF : "a working vault (built-in numbers)",
};

// The reference numbers, measured from 413 real memories.
/**
 * Measured, not asserted.
 *
 * There is no universal right size for a memory. The tool imposes almost
 * nothing — a body over 8,000 characters only earns a warning that it might
 * want splitting — and length follows the KIND of thing being recorded: a
 * one-line gotcha and a decision record are both legitimate and differ by an
 * order of magnitude. So "too rich" is meaningless in the abstract.
 *
 * What is not meaningless is a fixture that differs from the store you claim to
 * model. Denser than production and the benchmark flatters itself; thinner and
 * it measures a task nobody has. Pass --reference and the bounds come from that
 * corpus; without it they fall back to a working vault's numbers, stated below
 * so they can be argued with.
 */
const REFERENCE = (() => {
  const fallback = { distinct: 56.2, specifics: 6.0, median: 61, p90: 266 };
  if (!REF) return fallback;
  const rf = readdirSync(REF).filter((f) => f.endsWith(".md"));
  if (!rf.length) return fallback;
  const rb = rf.map((f) => readFileSync(join(REF, f), "utf8").replace(/^---[\s\S]*?---\n/, ""));
  const rl = rb.map((b) => words(b).length).sort((a, b) => a - b);
  const rat = (p) => rl[Math.min(rl.length - 1, Math.floor(rl.length * p))];
  return {
    distinct: rb.reduce((a, b) => a + new Set(tok(b)).size, 0) / rb.length,
    specifics: rb.reduce((a, b) => a + (b.match(SPECIFIC) ?? []).length, 0) / rb.length,
    median: rat(0.5), p90: rat(0.9),
  };
})();

/**
 * Two-sided, because both directions are the same mistake.
 *
 * A corpus thinner than reality has no information to retrieve on and makes the
 * system look broken. A corpus RICHER than reality — more identifiers, longer
 * documents — is easier to search than production and makes it look solved. The
 * first version of this gate only checked minimums and passed a corpus carrying
 * 2.3x the real density of specifics.
 *
 * Bounds are the real measurement, halved and doubled: close enough to be the
 * same kind of thing, loose enough that a fixture need not be a forgery.
 */
// Half to double the reference on each axis: close enough to be the same kind
// of thing, loose enough that a fixture need not be a forgery of one store.
const R = REFERENCE;
const GATES = [
  ["distinct_words_per_memory", report.distinct_words_per_memory, R.distinct / 2, R.distinct * 2, `reference: ${R.distinct.toFixed(1)}`],
  ["specifics_per_memory", report.specifics_per_memory, R.specifics / 2, R.specifics * 2, `reference: ${R.specifics.toFixed(1)}`],
  ["median_words", report.words.median, R.median / 2, R.median * 2, `reference: ${R.median}`],
  ["p90_words", report.words.p90, R.p90 / 2, R.p90 * 2, `reference: ${R.p90} — no long tail means nowhere for detail to live`],
];
const failures = GATES.flatMap(([k, v, min, max, note]) =>
  v < min ? [`${k} = ${v}, BELOW ${min} — too thin to tell documents apart (${note})`]
  : v > max ? [`${k} = ${v}, ABOVE ${max} — richer than production, which flatters the result (${note})`]
  : []);
report.verdict = failures.length ? "DOES NOT MATCH A REAL STORE" : "realistic enough to benchmark";
report.failures = failures;

console.log(JSON.stringify(report, null, 1));
process.exit(failures.length ? 1 : 0);
