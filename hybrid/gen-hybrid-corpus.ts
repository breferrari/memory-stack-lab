/**
 * Build the hybrid pool by pushing the SAME seeded 183-memory corpus through the
 * real hybrid write path, so the benchmark exercises the code rather than a
 * hand-made fixture.
 *
 *   overclaim=0    every memory correctly project-scoped
 *   overclaim=0.24 the same corpus with 24% claiming `general` — the rate that
 *                  collapsed the bare V4 filter from 0.984 to 0.391 rank-1
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture } from "./plugin.ts";

const SRC = process.argv[2];
const OUT = process.argv[3];
const OVERCLAIM = Number(process.argv[4] ?? 0);

rmSync(OUT, { recursive: true, force: true });
rmSync(join(OUT, "..", "memories-quarantine"), { recursive: true, force: true });

let seed = 20260831;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const files = readdirSync(SRC).filter((f) => f.endsWith(".md")).sort();
// id -> {project, topic}. The hybrid filename is `<project>__<title-slug>`, so
// the topic is no longer recoverable from the name the way the ladder's corpora
// allowed. Emitted explicitly so ONE scorer still serves every rung.
const map: Record<string, { project: string; topic: string; source: string }> = {};
let landed = 0, quarantined = 0, refused = 0, downgraded = 0;
const blockedBy: Record<string, number> = {};
const refusals: string[] = [];

for (const f of files) {
	const md = readFileSync(join(SRC, f), "utf8");
	const repo = (md.match(/\*\*Applies to:\*\*\s*([a-z0-9-]+)/) ?? [])[1]!;
	const title = (md.match(/^# (.+?)(?: — [a-z0-9-]+)?$/m) ?? [])[1] ?? f;
	// The substance, whichever corpus this is. The ladder's templated fixtures
	// opened with `## Problem`; the generated one is plain prose under an H1 and
	// an `**Applies to:**` line, and has no headings at all. Keying off `## Problem`
	// silently yielded a ONE-CHARACTER body on the generated corpus — indexOf
	// returns -1 and slice(-1) takes the last character — so every memory was
	// refused for falling under the 40-char minimum. Nothing errored; the pool was
	// simply empty. Take everything after the last structural line instead.
	//
	// Prose first, not a heading: OM derives the ~150-char description from the
	// body's first sentence, so a body starting with a heading yields a
	// description that literally begins with that heading.
	const marker = md.indexOf("## Problem");
	const body = (marker >= 0
		? md.slice(marker).replace(/^## Problem\s*/, "")
		: md.replace(/^---[\s\S]*?---\n/, "").replace(/^#[^\n]*\n/, "").replace(/^\*\*Applies to:\*\*[^\n]*\n/m, "")
	).replace(/\n## /g, "\n\n").trim();
	const over = rnd() < OVERCLAIM;

	const r = capture(OUT, {
		// the filename already namespaces by project; repeating it in the title
		// produced `payments-service__payments-service-Key-caches...`
		title,
		body,
		confidence: "inferred",
		scope: over ? "general" : "project",
		projects: [repo],
		...(over ? { generality: "claimed to apply across the org" } : {}),
	}, { origin: repo });

	if (r.ok) {
		landed++;
		// Frontmatter first: the generated corpus states its topic outright. The
		// filename patterns are the ladder's older corpora, kept so one scorer
		// still serves every rung. Without the frontmatter branch every generated
		// memory scored as topic "unknown", which no stage treats as an error.
		const topic = (md.match(/^topic:\s*(\S+)/m) ?? [])[1]
			?? (f.match(/_(?:learning|decision)_([a-z]+)_/) ?? f.match(/^[a-z0-9-]+__(?:learning|decision)_([a-z]+)_/) ?? [])[1]
			?? (f.match(/^[a-z0-9-]+__([a-z]+)__\d+\.md$/) ?? [])[1]
			?? "unknown";
		// `source` is the id this memory had in the world, which is what a query
		// names as its gold. The plugin renames the file on write, so without this
		// the only link back was (project, topic) - and a project has many memories
		// on one topic, so that pair identifies nothing.
		map[r.rel!.replace(/\.md$/, "")] = { project: repo, topic, source: f.replace(/\.md$/, "") };
		if (r.value?.downgraded_from) downgraded++;
	} else if (r.quarantined) {
		quarantined++;
		for (const fi of r.findings) blockedBy[fi.rule] = (blockedBy[fi.rule] ?? 0) + 1;
	} else {
		refused++;
		if (refusals.length < 3) refusals.push(`${f}: ${r.errors.join("; ")}`);
	}
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "_map.json"), JSON.stringify(map, null, 1));
console.log(JSON.stringify({
	source_docs: files.length, overclaim_rate: OVERCLAIM,
	landed, quarantined, refused, downgraded_by_rule: downgraded,
	quarantined_by_rule: blockedBy,
	sample_refusals: refusals,
}, null, 2));
