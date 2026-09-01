#!/usr/bin/env node
/**
 * Queries written from the INCIDENT, never from the memory.
 *
 *   node harness/gen-world-queries.mjs <world.json> <out-prefix> [model]
 *
 * Both previous fixtures failed on independence, in opposite directions. Queries
 * written from the documents shared their vocabulary and made retrieval look
 * solved — 1.000. Queries written from the documents and then stripped of every
 * shared word made it look broken — 0.541. Neither is a workload; both are the
 * fixture describing itself.
 *
 * Here the model that writes a query sees the incident — what happened, which
 * services, which artefacts — and never sees the memory written about it. The
 * two are siblings of the same situation, which is what a real session is: the
 * user knows the symptom, the store holds someone's write-up of it.
 *
 * Three registers, kept separate because they behave differently and averaging
 * them reports none of them:
 *
 *   symptom     what a person types when they know what they are seeing
 *   identifier  what they paste when they have the error in front of them
 *   short       four or five words, the way people actually search
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [WORLD, PREFIX, MODEL = "haiku"] = process.argv.slice(2);
if (!WORLD || !PREFIX) { console.error("usage: gen-world-queries.mjs <world.json> <out-prefix> [model]"); process.exit(1); }

const world = JSON.parse(readFileSync(WORLD, "utf8"));
const incidents = new Map(world.incidents.map((i) => [i.id, i]));

const ask = (prompt) => {
  for (let a = 1; a <= 2; a++) {
    try {
      const o = execFileSync("claude", ["-p", "--model", MODEL], { input: prompt, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024 }).trim();
      if (o) return o.split("\n").map((l) => l.trim()).filter(Boolean);
    } catch { /* retry once */ }
  }
  return [];
};

/**
 * Resumable, because it is not: a run is one model call per memory and the
 * previous version wrote nothing until the last one returned, so a crash at
 * 180 of 183 cost the whole hour. The corpus generator has been resumable from
 * the start and this one was not, which is an asymmetry that costs nothing
 * until the day it does.
 *
 * Each query is appended to a JSONL as it is produced; a restart reads it back
 * and skips what is already there. The TSVs are still written at the end, from
 * the log, so their format is unchanged for every consumer.
 */
const LOG = `${PREFIX}-queries.jsonl`;
const already = new Map();
if (existsSync(LOG)) {
  for (const line of readFileSync(LOG, "utf8").split("\n").filter(Boolean)) {
    try { const r = JSON.parse(line); already.set(r.id, r); } catch { /* a torn last line */ }
  }
  process.stderr.write(`  resuming: ${already.size} queries already written\n`);
}

const rows = { symptom: [], identifier: [], short: [] };
let done = 0;

for (const m of world.memories) {
  const prior = already.get(m.id);
  if (prior) {
    rows.symptom.push(`${m.project}\t${m.id}\tlex: ${prior.symptom}%%vec: ${prior.symptom}`);
    rows.identifier.push(`${m.project}\t${m.id}\tlex: ${prior.ident}%%vec: ${prior.ident}`);
    rows.short.push(`${m.project}\t${m.id}\tlex: ${prior.short}%%vec: ${prior.short}`);
    done++;
    continue;
  }
  const inc = incidents.get(m.incident);
  // One query set per memory, so every memory is findable and the gold is
  // unambiguous within the caller's view.
  const out = ask(
`Someone on the ${m.project} team hits this and goes looking for whether it is already known. They have NOT read any write-up of it.

What is happening: ${inc.symptom}. The thing in front of them is ${m.artefact}. A metric moved: ${m.signal}, around ${m.magnitude}.

Write exactly three lines, nothing else, no numbering, no quotes:
1. How they would describe it in their own words, one sentence, WITHOUT using the words "${m.artefact}" or "${m.signal}".
2. What they would paste from their terminal or dashboard — an identifier, code or metric name, four words or fewer.
3. What they would type in a hurry — three to five words.`);

  if (out.length < 3) { done++; continue; }
  const [symptom, ident, short] = out;
  appendFileSync(LOG, `${JSON.stringify({ id: m.id, project: m.project, symptom, ident, short })}\n`);
  rows.symptom.push(`${m.project}\t${m.id}\tlex: ${symptom}%%vec: ${symptom}`);
  rows.identifier.push(`${m.project}\t${m.id}\tlex: ${ident}%%vec: ${ident}`);
  rows.short.push(`${m.project}\t${m.id}\tlex: ${short}%%vec: ${short}`);
  done++;
  if (done % 10 === 0) process.stderr.write(`  ${done}/${world.memories.length}\n`);
}

for (const [k, v] of Object.entries(rows)) writeFileSync(`${PREFIX}-${k}.tsv`, `${v.join("\n")}\n`);
console.log(JSON.stringify({ memories: world.memories.length, queries_per_register: rows.symptom.length, registers: Object.keys(rows) }, null, 1));
