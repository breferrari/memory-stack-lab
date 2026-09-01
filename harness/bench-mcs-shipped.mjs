#!/usr/bin/env node
/**
 * MCS as shipped, before the qmd backend: docs-mcp-server over a flat pool,
 * embedding through Ollama's nomic-embed-text.
 *
 *   node harness/bench-mcs-shipped.mjs <pool> <q-REGISTER.tsv> <label> <out-dir>
 *
 * The record compares this stack before and after qmd. Both of those rows were
 * measured on the retired fixture, so quoting either beside a number from the
 * realistic corpus would be a comparison where one side changed — which is the
 * error this whole re-run exists to stop making, and it is no more acceptable
 * pointed at someone else's work than at our own.
 *
 * One shared store, because that is what the shipped pack produces: memories go
 * in one directory and retrieval has no notion of which project is asking.
 *
 * Declared rather than hidden: this runs docs-mcp-server 3.1.0 and whatever
 * nomic-embed-text Ollama currently serves, which are not necessarily the
 * versions the original row was taken with — that environment no longer exists
 * on this machine. It is the current shipped behaviour, which is what a user
 * installing it today would get.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const [POOL, QUERIES, LABEL, OUT] = process.argv.slice(2);
if (!POOL || !QUERIES || !OUT) { console.error("usage: bench-mcs-shipped.mjs <pool> <q.tsv> <label> <out-dir>"); process.exit(1); }
const BIN = resolve("tools/node_modules/.bin/docs-mcp-server");
if (!existsSync(BIN)) { console.error(`docs-mcp-server not installed at ${BIN}`); process.exit(1); }
const STORE = resolve("runs/mcs-shipped-store");
const env = { ...process.env, OPENAI_API_KEY: "ollama", OPENAI_API_BASE: "http://127.0.0.1:11434/v1", DOCS_MCP_EMBEDDING_MODEL: "openai:nomic-embed-text" };

// 3.1.0 refuses to index a local directory outside its configured roots — a
// security policy the version this row was first measured with did not have.
// Declared here rather than worked around silently: the allowed root is the
// lab's runs/ directory and nothing else.
const CONFIG = resolve("runs/mcs-shipped-config.json");
writeFileSync(CONFIG, JSON.stringify({ scraper: { security: { fileAccess: { allowedRoots: [resolve("runs")] } } } }, null, 1));
const run = (args, timeout = 600_000) => execFileSync(BIN, [...args, "--config", CONFIG], { env, encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 });

// Build the store once and reuse it across registers; scraping 183 documents
// through an embedding model is the expensive part and the queries do not
// change it.
// Build once, reuse across registers. The guard used to also require the store
// DIRECTORY to be absent, which mkdirSync had just created — so a second
// register skipped the build and every query failed with "library not found".
if (!existsSync(join(STORE, "documents.db"))) {
	process.stderr.write("  building the shipped store (one shared pool)\n");
	mkdirSync(STORE, { recursive: true });
	// Only the memories. Without this it also indexes _map.json and
	// _queries.json, putting two documents in the store that are not memories.
	const out = run(["scrape", "pool", `file://${resolve(POOL)}`, "--store-path", STORE, "--include-pattern", "*.md", "--telemetry", "false"], 3_600_000);
	const n = (out.match(/scraped\s+(\d+)\s+pages/i) ?? [])[1];
	process.stderr.write(`  indexed ${n ?? "?"} documents\n`);
	if (Number(n) < 100) { console.error(`the shipped store indexed only ${n} documents — refusing to score a vacuous run`); process.exit(1); }
}

mkdirSync(OUT, { recursive: true });
const queries = readFileSync(QUERIES, "utf8").split("\n").filter(Boolean).map((l) => {
	const [project, key, doc] = l.split("\t");
	// docs-mcp-server takes ONE plain string where qmd takes a structured
	// document. It is given the natural-language half, which is what an agent
	// would actually type — stated because it is an interface difference, not a
	// handicap chosen for it.
	const vec = (doc.split("%%")[1] ?? doc).replace(/^vec:\s*/, "").replace(/^lex:\s*/, "");
	return { project, key, vec };
});

let ms = 0, empty = 0;
for (const q of queries) {
	const t = Date.now();
	let hits = [];
	try {
		const out = run(["search", "pool", q.vec, "--store-path", STORE, "--telemetry", "false", "--output", "json"]);
		const j = JSON.parse(out.slice(out.indexOf("[") >= 0 ? out.indexOf("[") : 0) || "[]");
		hits = (Array.isArray(j) ? j : j.results ?? []).slice(0, 5)
			// The url comes back PERCENT-ENCODED. 94 of this pool's 183 documents
			// carry a `(2)` suffix with a space in it, so more than half of every
			// hit list resolved to a name no document has — scored as junk, and
			// reported as their system returning nonsense. It was the parser.
			.map((r) => basename(decodeURIComponent(String(r.url ?? r.path ?? ""))).replace(/\.md$/, "")).filter(Boolean);
	} catch { /* a failed query is an empty result, counted */ }
	ms += Date.now() - t;
	if (!hits.length) empty++;
	writeFileSync(join(OUT, `${q.project}__${q.key}.txt`), hits.join("\n"));
}
writeFileSync(join(OUT, "_queries.json"), JSON.stringify(queries.map((q) => ({ artifact: `${q.project}__${q.key}.txt`, project: q.project, key: q.key })), null, 1));
console.log(JSON.stringify({ arm: "mcs-shipped", register: LABEL, queries: queries.length, returned_nothing: empty, mean_ms: Math.round(ms / queries.length), store: STORE }, null, 1));
