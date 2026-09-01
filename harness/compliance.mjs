#!/usr/bin/env node
/**
 * Does the injected protocol change what the agent DOES?
 *
 *   node harness/compliance.mjs <out-dir> [samples]
 *
 * Presence was already settled — a session completed a phrase that exists
 * nowhere else on the machine. That is a priming check and answers nothing
 * about behaviour: text can sit in context and be ignored. This measures the
 * tool SEQUENCE instead.
 *
 * Design, and why each part is there:
 *
 *   Factor 1  protocol present vs absent. Absent = VESTIGE_PROTOCOL=off, so the
 *             tools, the hooks and the MCP server are identical in both cells.
 *             Comparing "plugin installed" against "plugin missing" would
 *             confound the instruction with the availability of what it names.
 *   Factor 2  prompt family. `debug` should trigger a lookup; `edit` should not.
 *             Measuring only the positive class rewards a protocol that makes
 *             the agent search on every turn, which is a cost, not compliance.
 *
 * The gate is OFF in both cells. It is a separate treatment and the stronger
 * one; mixing it in would credit the essay for what the hook does.
 *
 * Endpoint: a vestige search/recall call BEFORE the first other tool. Searching
 * eventually is not compliance with a protocol that says search first.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] ?? "runs/compliance";
const SAMPLES = Number(process.argv[3] ?? 1);
mkdirSync(OUT, { recursive: true });

// Fresh prompts: not from the README, not from any fixture, so they cannot have
// been seen. Each debug prompt is a situation a store might plausibly answer.
const DEBUG = [
  "the checkout endpoint started returning duplicate charges after a retry — what do we know about this?",
  "our nightly job is getting throttled by the payments provider, how have we handled that before?",
  "tests pass locally and fail about one run in five on CI — where do we usually start?",
  "the dashboard is showing yesterday's totals right after a save, any prior context?",
  "we are seeing 'undefined is not an object' only for accounts without an address",
  "deploy went out and the old pods started erroring on a missing column",
];
const EDIT = [
  "rename the variable `tmp` to `pending` in src/queue.js",
  "add a trailing newline to README.md",
  "sort the keys in package.json alphabetically",
  "change the copyright year in LICENSE to 2026",
  "wrap the long line in src/util.js at 100 columns",
  "delete the unused import in src/index.js",
];

const MEMORY_TOOL = /vestige.*__(search|recall)$/i;

/** Run one episode and return the ordered list of tool names it called. */
function episode(prompt, protocolOn) {
  const env = { ...process.env, VESTIGE_GATE: "off" };
  if (!protocolOn) env.VESTIGE_PROTOCOL = "off";
  let out = "";
  try {
    out = execFileSync("claude", [
      "-p", "--model", "claude-haiku-4-5-20251001",
      "--output-format", "stream-json", "--verbose",
      "--allowedTools", "mcp__plugin_vestige_vestige__search,mcp__plugin_vestige_vestige__recall,Read,Edit,Grep,Glob",
    ], { input: prompt, encoding: "utf8", env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { out = String(e?.stdout ?? ""); }

  const tools = [];
  for (const line of out.split("\n")) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    const content = d?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) if (b?.type === "tool_use" && b.name) tools.push(b.name);
  }
  return tools;
}

const rows = [];
for (const [family, prompts] of [["debug", DEBUG], ["edit", EDIT]]) {
  for (const protocolOn of [true, false]) {
    for (const prompt of prompts) {
      for (let s = 0; s < SAMPLES; s++) {
        const tools = episode(prompt, protocolOn);
        const firstOther = tools.findIndex((t) => !MEMORY_TOOL.test(t));
        const firstMemory = tools.findIndex((t) => MEMORY_TOOL.test(t));
        const searchedFirst = firstMemory >= 0 && (firstOther < 0 || firstMemory < firstOther);
        rows.push({ family, protocol: protocolOn ? "present" : "absent", prompt: prompt.slice(0, 60), tools, searchedAtAll: firstMemory >= 0, searchedFirst });
        process.stderr.write(`  ${family}/${protocolOn ? "present" : "absent"} ${searchedFirst ? "SEARCHED-FIRST" : tools.length ? "no" : "(no tools)"}\n`);
      }
    }
  }
}

const cell = (family, protocol) => {
  const r = rows.filter((x) => x.family === family && x.protocol === protocol);
  return { n: r.length, searched_first: r.filter((x) => x.searchedFirst).length, searched_at_all: r.filter((x) => x.searchedAtAll).length };
};
const summary = {
  samples_per_prompt: SAMPLES,
  gate: "off in every cell — this measures the protocol text, not the hook",
  debug: { present: cell("debug", "present"), absent: cell("debug", "absent") },
  edit: { present: cell("edit", "present"), absent: cell("edit", "absent") },
};
writeFileSync(join(OUT, "episodes.json"), JSON.stringify(rows, null, 1));
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
