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
if (!DIR) { console.error("usage: verify-corpus.mjs <corpus-dir>"); process.exit(1); }

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
};

// The reference numbers, measured from 413 real memories.
const GATES = [
  ["distinct_words_per_memory", report.distinct_words_per_memory, 30, "real store: 56.2 unique tokens per memory"],
  ["specifics_per_memory", report.specifics_per_memory, 3.5, "real store: 6.0"],
  ["median_words", report.words.median, 40, "real store: 61"],
  ["p90_words", report.words.p90, 150, "real store: 266 — a corpus with no long tail has nowhere for detail to live"],
];
const failures = GATES.filter(([, v, min]) => v < min).map(([k, v, min, note]) => `${k} = ${v}, below ${min} (${note})`);
report.verdict = failures.length ? "TOO THIN TO BENCHMARK" : "realistic enough to benchmark";
report.failures = failures;

console.log(JSON.stringify(report, null, 1));
process.exit(failures.length ? 1 : 0);
