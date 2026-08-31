#!/usr/bin/env node
/**
 * Plant synthetic contamination into a write plan, to test that a content gate
 * keeps it out of a shared store.
 *
 * The fixture is GENERATED rather than committed: it is large, it is derivable,
 * and a checked-in file full of credential-shaped strings trips every secret
 * scanner that will ever look at this repository. Nothing here is a real
 * secret — the tokens are alphabet sequences and the addresses are RFC1918.
 *
 *   node harness/gen-leaky-plan.mjs harness/plan-x.json harness/plan-x-leaky.json [rate]
 */
import { readFileSync, writeFileSync } from "node:fs";

const [src, dest, rateArg] = process.argv.slice(2);
const rate = Number(rateArg ?? 0.10);
const plan = JSON.parse(readFileSync(src, "utf8"));

// Assembled at runtime so the literals never appear in a file a scanner reads.
const KEY = ["sk", "live"].join("-") + "AbcdEfghIjklMnopQrstUvwxYz012345";
const LEAKS = [
  (i) => `Repro dump at /home/exampleuser/dumps/session-${i}.json.`,
  (i) => `Traced on auth-db-${String(i).padStart(2, "0")}.internal before the rollback.`,
  (i) => `On-call rota is oncall-team${i}@example.invalid.`,
  (i) => `Session id 550e8400-e29b-41d4-a716-4466554400${String(i).padStart(2, "0")} never expired.`,
  (i) => `Static token ${KEY}${i} was still valid.`,
  (i) => `The host was 10.42.7.${i}.`,
];

let seed = 20260831;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

let n = 0;
plan.plan.forEach((item, i) => {
  if (rnd() >= rate) return;
  item.body = `${item.body}\n\n${LEAKS[i % LEAKS.length](i % 90)}`;
  n++;
});
writeFileSync(dest, JSON.stringify(plan));
console.log(JSON.stringify({ source: src, dest, contaminated: n, of: plan.plan.length, rate }));
