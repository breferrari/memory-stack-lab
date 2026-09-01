#!/usr/bin/env node
/**
 * The rows that decide whether a rank-1 number is a ceiling or a headline.
 *
 *   node harness/analyse-stratum.mjs <hits-dir> <pool-dir> <queries.tsv>
 *
 * rank-1 alone cannot tell three different situations apart, and they have three
 * different fixes:
 *
 *   the gold was never in the caller's view      -> a reach problem
 *   the gold was in the view but not retrieved   -> an embedding problem
 *   the gold was retrieved but ranked second     -> a first-slot problem
 *
 * It also reports rank-1 by query/target token overlap. If the score climbs with
 * overlap, the headline is a point on a curve rather than a ceiling — and the
 * curve says where production actually sits, since real symptom language shares
 * SOME words with the answer.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";

const [HITS, POOL, QUERIES] = process.argv.slice(2);
if (!HITS || !POOL || !QUERIES) { console.error("usage: analyse-stratum.mjs <hits-dir> <pool-dir> <queries.tsv>"); process.exit(1); }

const STOP = new Set("the a an and or of to in on for with is are was were be it this that as by at from not no than then when if you your we our they their can could should would must may might do does did done have has had over under into out up down off about after before while each any all some more most other another such only same so nor own too very just also its".split(/\s+/));
const tok = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));
const jac = (a, b) => { let h = 0; for (const t of a) if (b.has(t)) h++; return h / (a.size + b.size - h || 1); };

const map = JSON.parse(readFileSync(join(POOL, "_map.json"), "utf8"));
// world memory id -> the document it became after the plugin renamed it
const sourceOf = new Map(Object.entries(map).filter(([, m]) => m.source).map(([id, m]) => [m.source, id]));
/**
 * A query names its gold by memory id where the corpus has ids, and by topic in
 * the ladder's older corpora, where a project holds one memory per topic. Here a
 * project holds many on a topic and some of them correct each other, so the
 * (project, topic) pair identifies nothing and returning null for it is right.
 */
const target = (proj, key) => {
  const byId = sourceOf.get(key);
  if (byId) return byId;
  const hit = Object.entries(map).filter(([, m]) => m.project === proj && m.topic === key);
  return hit.length === 1 ? hit[0][0] : null;
};

const bins = [[0, 0.005], [0.005, 0.02], [0.02, 0.06], [0.06, 1]];
const acc = { n: 0, rank1: 0, found5: 0, mrr: 0, noGold: 0, ranks: [], byBin: bins.map(() => ({ n: 0, r1: 0 })), miss: { sibling: 0, otherProject: 0, junk: 0 } };

for (const line of readFileSync(QUERIES, "utf8").split("\n").filter(Boolean)) {
  const [proj, key, doc] = line.split("\t");
  const gold = target(proj, key);
  if (!gold) { acc.noGold++; continue; }
  const f = join(HITS, `${proj}__${key}.txt`);
  if (!existsSync(f)) continue;
  const ids = readFileSync(f, "utf8").split("\n").filter(Boolean).map((x) => basename(x).replace(/\.md$/, ""));
  const rank = ids.indexOf(gold);

  const q = tok(doc.replace(/%%/g, " ").replace(/\b(lex|vec):\s*/g, ""));
  let goldText = ""; try { goldText = readFileSync(join(POOL, `${gold}.md`), "utf8"); } catch { /* */ }
  const ov = jac(q, tok(goldText));
  const bi = bins.findIndex(([lo, hi]) => ov >= lo && ov < hi);

  acc.n++;
  if (bi >= 0) { acc.byBin[bi].n++; if (rank === 0) acc.byBin[bi].r1++; }
  if (rank === 0) acc.rank1++;
  if (rank >= 0 && rank < 5) { acc.found5++; acc.mrr += 1 / (rank + 1); }
  if (rank >= 0) acc.ranks.push(rank + 1);

  // What took the top slot when the gold did not? Three causes, three fixes.
  if (rank !== 0 && ids.length) {
    const top = ids[0];
    const m = map[top];
    if (!m) acc.miss.junk++;
    else if (m.project === proj) acc.miss.sibling++;
    else acc.miss.otherProject++;
  }
}

const med = (v) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : null);
console.log(JSON.stringify({
  queries: acc.n,
  unresolvable_gold: acc.noGold,
  rank1: +(acc.rank1 / acc.n).toFixed(3),
  found_at_5: +(acc.found5 / acc.n).toFixed(3),
  mrr: +(acc.mrr / acc.n).toFixed(3),
  recall_in_returned_list: +(acc.ranks.length / acc.n).toFixed(3),
  median_rank_when_found: med(acc.ranks),
  rank1_by_overlap_bin: bins.map(([lo, hi], i) => ({ bin: `${lo}-${hi}`, n: acc.byBin[i].n, rank1: acc.byBin[i].n ? +(acc.byBin[i].r1 / acc.byBin[i].n).toFixed(3) : null })),
  when_gold_not_first: acc.miss,
  reading: "sibling = near-duplicate in the same project, so unique-gold scoring is the problem; other-project = the view is too wide; junk = embeddings",
}, null, 1));
