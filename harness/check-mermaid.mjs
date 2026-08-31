#!/usr/bin/env node
/**
 * Parse every mermaid block in a markdown file with the real mermaid parser.
 *
 * A broken diagram fails silently in Obsidian — it renders as an error box that
 * nobody notices in a long note — so grepping for syntax traps is not enough.
 *
 * Needs a DOM: mermaid's flowchart path calls DOMPurify.addHook, and without a
 * window the parse throws "DOMPurify.addHook is not a function" for EVERY
 * flowchart while sequence diagrams still pass. That looks exactly like three
 * broken diagrams and one good one. It is the harness failing, not the input —
 * check the error text before believing a failure.
 *
 *   node check-mermaid.mjs <file.md> [...]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

// deps live wherever the lab was set up; override with LAB_TOOLS
const require = createRequire(`${process.env.LAB_TOOLS ?? join(process.cwd(), "tools")}/`);
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const k of ["window", "document", "Element", "HTMLElement", "SVGElement", "Node", "DOMParser", "XMLSerializer"]) {
  try {
    Object.defineProperty(globalThis, k, { value: k === "window" ? dom.window : dom.window[k], configurable: true, writable: true });
  } catch { /* some globals are getter-only on newer Node; mermaid tolerates their absence */ }
}
const m = require("mermaid");
const mermaid = m.default ?? m;
mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });

let bad = 0, total = 0;
for (const file of process.argv.slice(2)) {
  const blocks = [...readFileSync(file, "utf8").matchAll(/```mermaid\n([\s\S]*?)\n```/g)].map((x) => x[1]);
  for (const [i, b] of blocks.entries()) {
    total++;
    try {
      await mermaid.parse(b);
      console.log(`OK    ${file} #${i + 1}  ${b.split("\n")[0]}`);
    } catch (e) {
      bad++;
      console.log(`FAIL  ${file} #${i + 1}  ${String(e?.message ?? e).split("\n")[0]}`);
    }
  }
}
console.log(bad ? `${bad} of ${total} INVALID` : `all ${total} diagrams parse`);
process.exit(bad ? 1 : 0);
