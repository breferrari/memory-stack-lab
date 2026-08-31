#!/usr/bin/env node
/**
 * What must never reach a public repository.
 *
 * Three of these shipped for real before this existed: a machine-specific
 * absolute path defaulted in three benchmark scripts, and agent-session
 * artifacts in commit messages and PR bodies on a public repo — where a
 * squashed commit stays reachable by SHA even after a force-push.
 *
 * A rule enforced by remembering is the one that already failed, so this runs
 * in CI. Every finding names the file, the line and the reason.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RULES = [
	{ name: "local absolute path", re: /(^|[^\w])(\/home\/[a-z][\w.-]*|\/Users\/[A-Za-z][\w.-]*|[A-Z]:\\Users\\)/, why: "machine-specific and meaningless to every other reader; resolve relative to the file or take an env var" },
	{ name: "agent session URL", re: /claude\.ai\/code\/session_/, why: "an agent-session artifact; these are permanent once pushed" },
	{ name: "session trailer", re: /^Claude-Session:/m, why: "an agent-session artifact; Co-Authored-By is the one that belongs" },
];
// A rule that flags its own statement of the rule is a rule nobody keeps.
const SELF = "harness/check-hygiene.mjs";

/**
 * The first run of this guard produced three findings and all three were
 * fixtures — `/home/exampleuser`, `/Users/x` — which is exactly what a
 * leak-detection corpus is MADE of. A scanner that cannot tell a planted
 * example from a real path fails on the repository it was written to protect,
 * and gets switched off. Two escapes, both explicit:
 *   - a placeholder home directory, which no real machine has
 *   - an inline `hygiene-ok` marker, for a line that declares itself
 */
const PLACEHOLDER = /^\/(?:home|Users)\/(?:example[\w-]*|user|users|someone|you|me|x|foo|bar|test|dummy|placeholder)\b/i;
const EXEMPT = /hygiene-ok/;

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean).filter((f) => f !== SELF);
const findings = [];
for (const f of files) {
	let text;
	try { text = readFileSync(f, "utf8"); } catch { continue; }
	if (text.includes("\0")) continue;
	text.split("\n").forEach((line, i) => {
		if (EXEMPT.test(line)) return;
		for (const r of RULES) {
			const m = line.match(r.re);
			if (!m) continue;
			if (r.name === "local absolute path" && PLACEHOLDER.test(m[2].replace(/\\/g, "/"))) continue;
			findings.push(`${f}:${i + 1}  ${r.name} — ${r.why}\n    ${line.trim().slice(0, 120)}`);
		}
	});
}

if (findings.length) {
	console.error(`${findings.length} hygiene violation(s):\n\n${findings.join("\n\n")}`);
	process.exit(1);
}
console.log(`ok    ${files.length} tracked files carry no local paths or session artifacts`);
