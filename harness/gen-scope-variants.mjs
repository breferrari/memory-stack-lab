#!/usr/bin/env node
// Builds the two corpora that make the downgrade rule measurable.
//
// Derived from the `rich` corpus rather than by editing gen-corpus.mjs, so the
// seeded output of flat/ns/rich stays byte-identical for the other rungs.
//
// A `scope: general` memory must be returned to EVERY project — so a filter
// (V4) is obliged to admit it. An over-claimed `general` therefore pollutes all
// 16 projects *through* the filter. The downgrade rule from obsidian-mind's
// memory-write.ts is what stops that: declaring `general` while naming specific
// projects is forced back to `project`.
//
//   mixed-raw : scope as declared, including over-claims   (no downgrade rule)
//   mixed-dg  : same corpus with the downgrade rule applied
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'runs/scale/rich';
const RAW = 'runs/scale/mixed-raw';
const DG  = 'runs/scale/mixed-dg';
const OVERCLAIM_RATE = 0.20;   // 1 in 5 memories declares itself company-wide

let seed = 20260831;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

for (const d of [RAW, DG]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); }

// The downgrade rule, ported from obsidian-mind memory-write.ts:
// a memory that claims general scope while naming specific projects is not
// general. The declaration loses to the evidence.
const downgrade = (scope, projects) =>
  (scope === 'general' && projects.length > 0) ? 'project' : scope;

let overclaimed = 0, downgraded = 0;
const files = readdirSync(SRC).filter(f => f.endsWith('.md')).sort();
for (const f of files) {
  const body = readFileSync(join(SRC, f), 'utf8');
  const projects = [...body.matchAll(/^\s+- (\S+)$/gm)].map(m => m[1]);
  // deterministically over-claim a fraction: declare company-wide scope while
  // the body still names one repository and one stack
  const over = rnd() < OVERCLAIM_RATE;
  if (over) overclaimed++;
  const declared = over ? 'general' : 'project';
  const effective = downgrade(declared, projects);
  if (declared !== effective) downgraded++;
  writeFileSync(join(RAW, f), body.replace(/^scope: .*$/m, `scope: ${declared}`));
  writeFileSync(join(DG,  f), body.replace(/^scope: .*$/m, `scope: ${effective}`));
}
console.log(JSON.stringify({
  documents: files.length,
  overclaimed_as_general: overclaimed,
  overclaim_pct: +(100 * overclaimed / files.length).toFixed(1),
  downgraded_by_rule: downgraded,
  general_surviving_in_raw: overclaimed,
  general_surviving_after_rule: overclaimed - downgraded,
}, null, 2));
