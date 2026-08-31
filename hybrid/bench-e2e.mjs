#!/usr/bin/env node
/**
 * End-to-end through the PLUGIN's own API — not the harness.
 *
 * Every retrieval number before this came from indexes the harness built and
 * queried directly. That measures the architecture and not the product, and the
 * difference was not academic: the plugin never built an index at all, so
 * `search` silently fell back to facet ordering. This bench writes with
 * `remember`, reads with `search`, and lets the plugin do its own indexing.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN = process.env.VESTIGE_PLUGIN ?? resolve(process.cwd(), "..", "vestige");
const SRC = process.argv[2];                       // the 183-memory corpus
const OUT = process.argv[3];                       // artifact dir for the scorer
const QUERIES = process.argv[4];

const HOME = mkdtempSync(join(tmpdir(), "vh-e2e-"));
process.env.VESTIGE_HOME = HOME;
process.env.VESTIGE_NO_UPDATE = "1";

const { remember, search } = await import(pathToFileURL(join(PLUGIN, "core/lib/vestige.ts")).href);

// ── build one real git repo per project ───────────────────────────────────
const srcMap = JSON.parse(readFileSync(join(SRC, "_map.json"), "utf8"));
const projects = [...new Set(Object.values(srcMap).map((v) => v.project))].sort();
const root = mkdtempSync(join(tmpdir(), "e2e-repos-"));
const repoOf = {};
for (const p of projects) {
	const d = join(root, p);
	mkdirSync(d, { recursive: true });
	execFileSync("git", ["init", "-q", d]);
	repoOf[p] = d;
}

// ── write every memory through the real capture path ──────────────────────
const idMap = {};
let landed = 0, refused = 0;
for (const [id, meta] of Object.entries(srcMap)) {
	const md = readFileSync(join(SRC, `${id}.md`), "utf8");
	const title = (md.match(/^# (.+)$/m) ?? [])[1] ?? id;
	const body = md.slice(md.indexOf("## Problem") >= 0 ? md.indexOf("## Problem") : md.indexOf("\n\n"))
		.replace(/^## Problem\s*/, "").replace(/\n## /g, "\n\n").trim();
	const r = remember(
		{ title, body, confidence: "inferred", scope: "project", projects: [meta.project] },
		{ cwd: repoOf[meta.project] },
	);
	if (r.ok) { landed++; idMap[r.rel.replace(/\.md$/, "")] = meta; }
	else refused++;
}
writeFileSync(join(HOME, "_map.json"), JSON.stringify(idMap, null, 1));

// ── read every query through the real search path ─────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let qmdRuns = 0, facetRuns = 0;
for (const line of readFileSync(QUERIES, "utf8").split("\n").filter(Boolean)) {
	const [proj, topic, doc] = line.split("\t");
	// the fixture is a structured lex/vec document; the plugin takes one string
	const q = doc.replace(/%%/g, " ").replace(/\b(lex|vec):\s*/g, "");
	const r = search(q, { cwd: repoOf[proj], limit: 5 });
	r.engine === "qmd" ? qmdRuns++ : facetRuns++;
	writeFileSync(join(OUT, `${proj}__${topic}.txt`), r.hits.map((h) => h.name).join("\n"));
}

console.log(JSON.stringify({
	projects: projects.length, memories_written: landed, refused,
	queries_served_by_qmd: qmdRuns, queries_fallen_back_to_facets: facetRuns,
	map: join(HOME, "_map.json"), home: HOME,
}, null, 2));
