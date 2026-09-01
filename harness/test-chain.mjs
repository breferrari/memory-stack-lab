#!/usr/bin/env node
/**
 * The corpus-to-score contract, tested where it actually broke.
 *
 *   node harness/test-chain.mjs
 *
 * Three stages once read a corpus by assumptions about its FORMAT, and when the
 * generator changed, each produced a number instead of an error: a body taken
 * from a heading the corpus no longer had became one character; a topic pulled
 * out of a filename became "unknown" for every document; and a gold id parsed
 * out of an artifact name resolved to the wrong document. Nothing in the suite
 * covered any of it, because the suite predated the format.
 *
 * No search engine here on purpose. These are the pure steps around it, so this
 * stays fast enough to run before every corpus build.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "chain-"));
let failures = 0;
const check = (name, cond, detail = "") => {
	if (cond) return console.log(`  ok    ${name}`);
	failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
};

// A corpus in the GENERATED shape: prose under an H1, no `## Problem` heading,
// topic in the frontmatter, filename `<project>__<topic>__<n>.md`.
const src = join(root, "corpus");
mkdirSync(src, { recursive: true });
const ids = ["payments-api__retries__000", "payments-api__retries__001", "ledger__pooling__002"];
for (const [i, id] of ids.entries()) {
	const [project, topic] = id.split("__");
	writeFileSync(join(src, `${id}.md`),
`---
scope: project
projects:
  - ${project}
topic: ${topic}
---

# Something went wrong ${i} — ${project}

**Applies to:** ${project}

The ${topic} path on ${project} failed in a way that took a while to see, and the body has to be long enough to clear the minimum length the write path enforces, so here is a second sentence carrying \`idempotency_key\` and a p99 of 480ms and enough ordinary words that it reads like prose rather than a fixture stub.
`);
}

const pool = join(root, "pool");
const out = execFileSync("node", ["--experimental-strip-types", "hybrid/gen-hybrid-corpus.ts", src, pool, "0"], { encoding: "utf8", env: { ...process.env, VESTIGE_PLUGIN: process.env.VESTIGE_PLUGIN ?? join(root, "..", "..", "vestige") } });
const summary = JSON.parse(out);

// A body read by a marker the corpus lacks collapses to one character, and the
// write path then refuses it for being too short. That is the whole failure.
check("every memory lands", summary.landed === ids.length, `landed ${summary.landed}, refused ${summary.refused}, quarantined ${summary.quarantined}`);

const map = JSON.parse(readFileSync(join(pool, "_map.json"), "utf8"));
check("no document scores as topic unknown", !Object.values(map).some((m) => m.topic === "unknown"),
	JSON.stringify([...new Set(Object.values(map).map((m) => m.topic))]));
check("every document records the memory it came from", Object.values(map).every((m) => m.source),
	"without `source` the only link back is (project, topic), which is not unique here");

// Gold resolution, against an artifact whose key contains the `__` that the old
// filename-splitting parse used as its separator.
const hits = join(root, "hits");
mkdirSync(hits, { recursive: true });
const docOf = Object.fromEntries(Object.entries(map).map(([doc, m]) => [m.source, doc]));
const q = join(root, "q.tsv");
writeFileSync(q, ids.map((id) => `${id.split("__")[0]}\t${id}\tlex: something went wrong%%vec: something went wrong`).join("\n") + "\n");
for (const id of ids) writeFileSync(join(hits, `${id.split("__")[0]}__${id}.txt`), `${docOf[id]}\n`);
writeFileSync(join(hits, "_queries.json"), JSON.stringify(ids.map((id) => ({ artifact: `${id.split("__")[0]}__${id}.txt`, project: id.split("__")[0], key: id })), null, 1));

const strat = JSON.parse(execFileSync("node", ["harness/analyse-stratum.mjs", hits, pool, q], { encoding: "utf8" }));
check("every gold resolves", strat.unresolvable_gold === 0, `${strat.unresolvable_gold} of ${ids.length} unresolvable`);
check("a planted correct answer scores rank-1", strat.rank1 === 1, `rank1 ${strat.rank1}`);

const scored = JSON.parse(execFileSync("node", ["harness/score.mjs", hits, pool, "chain-test", "5", String(ids.length)], { encoding: "utf8" }));
// Two scorers over one run were free to disagree, because each decided
// relevance its own way. Where a gold id resolves, both match strictly.
check("both scorers agree on the same run", scored.target_at_rank1 === strat.rank1,
	`score ${scored.target_at_rank1} vs analyse ${strat.rank1}`);

// Non-vacuity: a sibling in the same project on the same topic must NOT count.
const sibling = docOf[ids[1]];
writeFileSync(join(hits, `payments-api__${ids[0]}.txt`), `${sibling}\n`);
const strict = JSON.parse(execFileSync("node", ["harness/score.mjs", hits, pool, "chain-test", "5", String(ids.length)], { encoding: "utf8" }));
check("a same-topic sibling is not counted as the answer", strict.target_at_rank1 < 1,
	`still ${strict.target_at_rank1}; strict gold matching is not in effect`);

// Supersession grading. A world where memory 001 corrects 000 and a run that
// returns the CORRECTION for 000's query: strict scoring calls that a miss,
// graded scoring calls it a hit, and neither should call it a stale answer.
// No corpus here has supersessions, so without this the grading path is only
// ever exercised by its own empty case — which reports the same string whether
// it was wired up or forgotten.
const world = join(root, "world.json");
writeFileSync(world, JSON.stringify({ memories: [
	{ id: ids[0], supersedes: null }, { id: ids[1], supersedes: ids[0] }, { id: ids[2], supersedes: null },
] }));
writeFileSync(join(hits, `payments-api__${ids[0]}.txt`), `${docOf[ids[1]]}\n`);   // the correction on top
writeFileSync(join(hits, `payments-api__${ids[1]}.txt`), `${docOf[ids[1]]}\n`);
const graded = JSON.parse(execFileSync("node", ["harness/analyse-stratum.mjs", hits, pool, q, "--world", world], { encoding: "utf8" }));
const sup = graded.superseded_gold_slice;
check("the superseded slice is found and reported alone", sup?.queries === 1, JSON.stringify(sup));
check("returning the correction is a strict miss", sup?.rank1_strict === 0);
check("returning the correction counts when grading accepts it", sup?.rank1_accepting_the_correction === 1);
check("returning the correction is not counted as a stale answer", sup?.stale_memory_on_top_while_its_correction_exists === 0);
check("the candidate set is reported beside the scores", graded.candidate_set?.memories_per_project_median > 0);

rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nchain contract holds");
process.exit(failures ? 1 : 0);
