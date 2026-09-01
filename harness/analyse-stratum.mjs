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

/**
 * The world's correction graph, when it is available.
 *
 * A single gold per query is a known-item metric, and this world is not a
 * known-item world: 27 of its 183 memories are corrected by a later one. When a
 * query's gold has since been superseded, returning the CORRECTION is the
 * behaviour the product wants, and scoring it as a miss penalises exactly that.
 * Returning the superseded memory while its correction exists is the genuinely
 * bad outcome, and until now the two were the same number.
 *
 * So three figures instead of one: strict known-item rank-1, rank-1 that accepts
 * the correction, and how often a stale memory took the top slot while its
 * correction sat in the same store. The superseded queries are also reported as
 * their own slice, because 27 of 183 disappears inside a micro-average and there
 * is no power to say anything about it from the mixed number.
 */
const wi = process.argv.indexOf("--world");
const correctionOf = new Map();
// stale id -> every memory that corrects it, in order, ending with the current one
const chainOf = new Map();
// world memory id -> the incident it is about. Without it, another write-up of
// the SAME incident — the predecessor, its correction, or the other service's
// side of a dual write-up — is indistinguishable from a note about a different
// incident that happens to share a project. Those are different failures with
// different fixes, and merging them makes the sibling bucket a restatement of
// the supersession slice.
const incidentOfSource = new Map();
if (wi > 0) {
  const world = JSON.parse(readFileSync(process.argv[wi + 1], "utf8"));
  for (const m of world.memories) if (m.supersedes) correctionOf.set(m.supersedes, m.id);
  for (const m of world.memories) incidentOfSource.set(m.id, m.incident);
  // Corrections chain: A is corrected by B, which is itself corrected by C. The
  // memory an agent should get is the one at the END of that chain, and crediting
  // only the immediate corrector marks the CURRENT memory as a miss. One such
  // chain exists in this world, which is exactly few enough to have been missed.
  for (const [stale] of [...correctionOf]) {
    const seen = new Set([stale]);
    let cur = correctionOf.get(stale);
    while (correctionOf.has(cur) && !seen.has(cur)) { seen.add(cur); cur = correctionOf.get(cur); }
    chainOf.set(stale, [...seen].slice(1).concat(cur).filter((x, i, a) => x && a.indexOf(x) === i));
  }
}
// world memory id -> the document it became after the plugin renamed it
const sourceOf = new Map();
for (const [id, m] of Object.entries(map)) {
  if (!m.source) continue;
  // Last-write-wins would make one of the two dual-perspective write-ups of an
  // incident silently unresolvable as a gold. Refuse instead of losing it.
  if (sourceOf.has(m.source)) { console.error(`two documents claim source ${m.source}: ${sourceOf.get(m.source)} and ${id}`); process.exit(1); }
  sourceOf.set(m.source, id);
}
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
const acc = { n: 0, rank1: 0, found5: 0, mrr: 0, noGold: 0, ranks: [], byBin: bins.map(() => ({ n: 0, r1: 0 })), miss: { sameIncidentOtherVersion: 0, sibling: 0, otherProject: 0, junk: 0 }, sup: { n: 0, strict: 0, accepting: 0, stale_outranks: 0, current_on_top: 0 } };

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

  // Graded, on the queries whose gold the world has since corrected.
  const chain = (chainOf.get(key) ?? []).map((id) => sourceOf.get(id)).filter(Boolean);
  if (chain.length) {
    acc.sup.n++;
    if (rank === 0) acc.sup.strict++;
    if (rank === 0 || chain.includes(ids[0])) acc.sup.accepting++;
    if (ids[0] === chain[chain.length - 1]) acc.sup.current_on_top++;
    // The harmful outcome, and it needs its own predicate. Counting it on
    // `rank === 0` made it a second name for the strict rate: two figures that
    // read as different measurements and were arithmetically identical. What
    // actually harms is the stale memory being ranked ABOVE its correction —
    // including the case where the correction never appears at all.
    const corrRanks = chain.map((c) => ids.indexOf(c)).filter((r) => r >= 0);
    const bestCorrection = corrRanks.length ? Math.min(...corrRanks) : -1;
    if (rank >= 0 && (bestCorrection < 0 || rank < bestCorrection)) acc.sup.stale_outranks++;
  }

  // What took the top slot when the gold did not? Three causes, three fixes.
  if (rank !== 0 && ids.length) {
    const top = ids[0];
    const m = map[top];
    const goldIncident = incidentOfSource.get(key);
    const topIncident = m?.source ? incidentOfSource.get(m.source) : undefined;
    if (!m) acc.miss.junk++;
    else if (goldIncident && topIncident && topIncident === goldIncident) acc.miss.sameIncidentOtherVersion++;
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
  reading: "sameIncidentOtherVersion = another write-up of the SAME event (the predecessor, its correction, or the other service's side) — a version-policy question, not a retrieval failure; sibling = a different incident in the same project, which is topical confusion; other-project = the view is too wide; junk = embeddings",
  // The candidate set every found@5 above is measured against. A found@5 over 22
  // documents is not a found@5 over a real store, and quoting one without the
  // other invites the comparison it cannot support.
  candidate_set: (() => {
    const per = {};
    for (const m of Object.values(map)) per[m.project] = (per[m.project] ?? 0) + 1;
    const v = Object.values(per).sort((a, b) => a - b);
    return { projects: v.length, memories_per_project_median: v[Math.floor(v.length / 2)] ?? null, min: v[0] ?? null, max: v[v.length - 1] ?? null };
  })(),
  superseded_gold_slice: acc.sup.n ? {
    queries: acc.sup.n,
    rank1_strict: +(acc.sup.strict / acc.sup.n).toFixed(3),
    rank1_accepting_the_correction: +(acc.sup.accepting / acc.sup.n).toFixed(3),
    stale_memory_ranked_above_its_correction: acc.sup.stale_outranks,
    current_memory_on_top: acc.sup.current_on_top,
    reading: "strict scores the superseded memory as the only right answer, which is the wrong ask for a memory system; accepting counts either it or the memory that corrects it. The third row is the outcome that actually harms an agent.",
  } : wi > 0
    ? "world graph passed; no query in this set has a gold that a later memory corrects"
    : "no world graph passed (--world <world.json>), so supersession was not graded",
}, null, 1));
