#!/usr/bin/env node
/**
 * Score a hits directory against a written map, rather than against a corpus.
 *
 *   node harness/score-map.mjs <hits-dir> <map.json> <queries.tsv> <label>
 *
 * score.mjs reads ownership from the corpus on disk. Some benches never leave a
 * flat corpus behind — they write through the real path into one repo per
 * project — so the only surviving statement of "which document answers this
 * query" is the map the bench wrote. Without this, those runs could report
 * latency and nothing else, which is how the reranker was compared on speed
 * alone for a week.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const [HITS, MAP, QUERIES, LABEL = basename(HITS)] = process.argv.slice(2);
if (!HITS || !MAP || !QUERIES) { console.error("usage: score-map.mjs <hits-dir> <map.json> <queries.tsv> [label]"); process.exit(1); }

const map = JSON.parse(readFileSync(MAP, "utf8"));
const queries = readFileSync(QUERIES, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));

// The correct answer for (project, topic) is the single document the map files
// under both. A query whose target cannot be identified is EXCLUDED and
// counted, never scored as a miss: an unresolvable target is a fixture problem,
// and silently scoring it as a failure makes a broken map look like a bad engine.
const targetFor = (proj, topic) => {
	const hits = Object.entries(map).filter(([, m]) => m.project === proj && m.topic === topic);
	return hits.length === 1 ? hits[0][0] : null;
};

let scored = 0, unresolvable = 0, found = 0, rank1 = 0, mrrSum = 0, foreignSum = 0, empty = 0;
for (const [proj, topic] of queries) {
	const target = targetFor(proj, topic);
	if (!target) { unresolvable++; continue; }
	let lines = [];
	try { lines = readFileSync(join(HITS, `${proj}__${topic}.txt`), "utf8").split("\n").filter(Boolean); } catch { /* no answer file */ }
	if (!lines.length) empty++;
	const ids = lines.map((l) => basename(l).replace(/\.md$/, ""));
	const idx = ids.indexOf(target);
	scored++;
	if (idx >= 0) { found++; mrrSum += 1 / (idx + 1); if (idx === 0) rank1++; }
	foreignSum += ids.filter((id) => map[id] && map[id].project !== proj).length;
}

if (!scored) { console.error(`${LABEL}: 0 of ${queries.length} queries had a resolvable target — refusing to report a vacuous score`); process.exit(1); }

console.log(JSON.stringify({
	label: LABEL, queries: queries.length, scored, unresolvable, returned_nothing: empty,
	target_found_in_topk: +(found / scored).toFixed(3),
	target_at_rank1: +(rank1 / scored).toFixed(3),
	mrr: +(mrrSum / scored).toFixed(3),
	mean_foreign_in_topk: +(foreignSum / scored).toFixed(3),
}, null, 1));
