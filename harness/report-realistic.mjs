#!/usr/bin/env node
/**
 * Turn a realistic run into the tables that go in the record.
 *
 *   node harness/report-realistic.mjs [runs/rich] > runs/rich/REPORT.md
 *
 * Reads what the run wrote and states its conditions beside its results,
 * because every number this project has had to retract was retracted for a
 * condition that was true at the time and not written down: the machine's load,
 * the corpus it ran against, where the queries came from.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const R = process.argv[2] ?? "runs/rich";
const read = (f) => { try { return JSON.parse(readFileSync(join(R, f), "utf8")); } catch { return null; } };
const REGISTERS = ["symptom", "identifier", "short"];
const ARMS = ["typed", "expand", "rerank"];
const ARM_LABEL = { typed: "typed sub-queries", expand: "+ query expansion", rerank: "+ cross-encoder rerank" };
const n = (v, d = 3) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));

const realism = read("realism.json");
const world = read("world-summary.json");
const corpus = read("corpus-summary.json");
const out = [];

out.push("# The realistic-corpus run\n");
out.push("## Conditions\n");
if (realism) {
	out.push(`**Corpus.** ${realism.memories} memories, median ${realism.words.median} words (p10 ${realism.words.p10}, p90 ${realism.words.p90}), ${realism.distinct_words_per_memory} distinct words and ${realism.specifics_per_memory} concrete specifics per memory, ${realism.memories_naming_another_service_or_incident} naming another service or incident. Gate reference: ${realism.reference}. Verdict: ${realism.verdict}.\n`);
}
if (world) out.push(`**World.** ${world.incidents} incidents across ${world.services} services, ${world.multi_service_incidents} spanning more than one, ${world.memories_referencing_another} memories referencing an earlier one, ${world.supersessions} corrections of a same-topic predecessor.\n`);
if (corpus) out.push(`**Generation.** ${corpus.written} written, ${corpus.skipped} skipped, ${corpus.still_short_after_top_ups} still short of their sampled target after top-ups. Model: ${corpus.model}.\n`);
out.push("**Queries.** Written from the incident, never from the memory. The symptom register is additionally forbidden from using the artefact or metric name, so it cannot borrow the vocabulary of the document it is meant to find.\n");

// Load average per arm: a retrieval number taken on a busy machine has been
// wrong here twice, once by enough to invert the conclusion.
const loads = [];
for (const reg of REGISTERS) for (const arm of ARMS) {
	const e = read(`e2e-${reg}-${arm}.json`);
	if (e?.load_at_start) loads.push(e.load_at_start[0]);
}
if (loads.length) out.push(`**Machine.** Load average across the ${loads.length} benchmark legs: ${Math.min(...loads).toFixed(2)} to ${Math.max(...loads).toFixed(2)}.\n`);

out.push("\n## Retrieval, by how the question was asked\n");
out.push("| register | arm | rank-1 | found@5 | MRR | warm query |");
out.push("|---|---|---|---|---|---|");
for (const reg of REGISTERS) for (const arm of ARMS) {
	const a = read(`analysis-${reg}-${arm}.json`), e = read(`e2e-${reg}-${arm}.json`);
	if (!a) continue;
	out.push(`| ${reg} | ${ARM_LABEL[arm]} | ${n(a.rank1)} | ${n(a.found_at_5)} | ${n(a.mrr)} | ${e?.latency_ms?.steady_state_mean ? `${e.latency_ms.steady_state_mean.toFixed(0)} ms` : "—"} |`);
}

out.push("\n## What took the top slot when the right memory did not\n");
out.push("A sibling is a near-duplicate in the same project, so unique-gold scoring is the limit rather than retrieval. Another project's memory means the view is too wide. Junk means the embeddings are wrong.\n");
out.push("| register | scored | rank-1 | sibling | other project | junk | gold unresolvable |");
out.push("|---|---|---|---|---|---|---|");
for (const reg of REGISTERS) {
	const a = read(`analysis-${reg}-typed.json`);
	if (!a) continue;
	const m = a.when_gold_not_first ?? {};
	out.push(`| ${reg} | ${a.queries} | ${n(a.rank1)} | ${m.sibling ?? "—"} | ${m.otherProject ?? "—"} | ${m.junk ?? "—"} | ${a.unresolvable_gold} |`);
}

out.push("\n## Rank-1 against how much wording the query shares with the answer\n");
out.push("The bin is Jaccard overlap between query and gold. A flat row here would mean retrieval is not using the wording at all.\n");
for (const reg of REGISTERS) {
	const a = read(`analysis-${reg}-typed.json`);
	if (!a?.rank1_by_overlap_bin) continue;
	out.push(`\n**${reg}**\n`);
	out.push("| overlap | queries | rank-1 |");
	out.push("|---|---|---|");
	for (const b of a.rank1_by_overlap_bin) out.push(`| ${b.bin} | ${b.n} | ${b.rank1 === null ? "—" : n(b.rank1)} |`);
}

out.push("\n## Not a controlled comparison with the earlier numbers\n");
out.push("The figures this replaces came from queries paraphrased out of the memories themselves, against a corpus with a median of 75 words. Both the corpus and the query provenance changed, so the difference between the two runs cannot be attributed to either. The controlled version is `run-quality-ablation.sh`, which holds the world and the queries fixed and varies only how much was written per memory.\n");

console.log(out.join("\n"));
