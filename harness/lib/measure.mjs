/**
 * One definition of "what this corpus looks like", used by both the generator
 * that targets a shape and the gate that checks one. Two implementations drift;
 * a fixture that passes its gate because the two disagree is worse than no gate.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Things an embedder grips and a symptom query collides with.
 *
 * The unit alternative ends in `\b` for the alphabetic units only. It used to
 * close the whole group, and `%` and `×` are non-word characters, so a trailing
 * `\b` could never fire after them: "dropped to 15%" and "2×" counted as
 * nothing. Cost was 4% of this corpus's specifics and 2% of the reference
 * store's, symmetric enough that it moved no conclusion — but it was silently
 * blind to a unit class the method claims to count.
 */
export const SPECIFIC =
  /`[^`]+`|\b[a-z_]+\.(?:ts|js|mjs|rs|py|json|toml|yaml|yml|md)\b|\b[A-Z][A-Za-z0-9]*(?:::|\.)[A-Za-z0-9_]+\b|\b\d+(?:\.\d+)?\s?(?:(?:ms|s|MB|KB|GB|x)\b|[%×])|\b[A-Z]{2,}[A-Z0-9_]*\b|\bv?\d+\.\d+(?:\.\d+)?\b/g;

export const words = (s) => s.trim().split(/\s+/).filter(Boolean);
export const tokens = (s) => (s.match(/[A-Za-z][A-Za-z0-9_.-]+/g) ?? []).map((t) => t.toLowerCase());
export const stripFrontmatter = (s) => s.replace(/^---[\s\S]*?---\n/, "");

/**
 * The prose of a memory: no frontmatter, no title heading, no `**Applies to:**`
 * line. One definition, because three copies of it had already drifted.
 *
 * The pool writes a blank line between the frontmatter and the title and the
 * generated corpus does not, so an unanchored `^#` strips the heading from one
 * shape and silently leaves it in the other. That put the title INSIDE the
 * indexed body for every benchmarked memory — appearing twice in the document,
 * and titles here derive from the incident symptom, which is what the paraphrase
 * queries are built from. The realism gate meanwhile measured prose alone. Two
 * different corpora, one of them measured and the other one searched.
 */
export const proseOf = (md) => md
	.replace(/^---[\s\S]*?---\n/, "")
	.replace(/^\s*#[^\n]*\n/, "")
	.replace(/^\s*\*\*Applies to:\*\*[^\n]*\n/, "")
	.trim();

/** Word count, computed rather than estimated. A model cannot count its own output. */
export const countWords = (s) => words(s).length;

const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

export function profileBodies(bodies) {
  // An empty corpus otherwise emits a VALID-LOOKING profile: n 0, a decile table
  // of nulls, NaN rates that JSON renders as null. A generator handed that samples
  // a target of one word for every document and reports nothing wrong. A wrong
  // path is the likeliest way to get here, and it must not produce a reference.
  if (!bodies.length) throw new Error("cannot profile an empty corpus — check the path");
  const w = bodies.map(countWords).sort((a, b) => a - b);
  return {
    n: bodies.length,
    // Deciles, so a generator can sample the real shape instead of a guess at it.
    word_deciles: Array.from({ length: 11 }, (_, i) => quantile(w, i / 10)),
    median_words: quantile(w, 0.5),
    p10_words: quantile(w, 0.1),
    p90_words: quantile(w, 0.9),
    distinct_words_per_doc: +(bodies.reduce((a, b) => a + new Set(tokens(b)).size, 0) / bodies.length).toFixed(1),
    // Occurrences AND distinct types. Counting occurrences alone lets a document
    // reach the target by repeating three identifiers fourteen times, and the
    // generated corpus does exactly that: it matches on occurrences (15.7 against
    // a real 14.1) while carrying 9.3 distinct specifics against a real 11.1. The
    // axis that would have shown it was the one not being measured — the same
    // wrong-unit failure as the reference itself, one level down.
    specifics_per_doc: +(bodies.reduce((a, b) => a + (b.match(SPECIFIC) ?? []).length, 0) / bodies.length).toFixed(1),
    distinct_specifics_per_doc: +(bodies.reduce((a, b) => a + new Set((b.match(SPECIFIC) ?? []).map((x) => x.toLowerCase())).size, 0) / bodies.length).toFixed(1),
  };
}

/** Recursive: a real store is dated subdirectories, a fixture is flat. Both are corpora. */
export function bodiesIn(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    if (e.startsWith("_") || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...bodiesIn(p));
    else if (e.endsWith(".md")) out.push(proseOf(readFileSync(p, "utf8")));
  }
  return out;
}

/** Sample a length from an empirical decile table: pick a decile, then within it. */
export const sampleWords = (deciles, rnd) => {
  const i = Math.min(9, Math.floor(rnd() * 10));
  const [lo, hi] = [deciles[i], deciles[i + 1]];
  return Math.round(lo + rnd() * Math.max(1, hi - lo));
};
