#!/usr/bin/env node
/**
 * Does the per-caller view survive organisation scale?
 *
 * The architecture materialises a view of exactly what a caller may see and
 * indexes that. At 16 projects a view is ~11 documents and the cost is
 * invisible. The open question is what happens at 180 projects and thousands of
 * memories: view materialisation is O(visible), index rebuild is O(visible),
 * and both sit on the READ path. If they scale with the whole store rather than
 * with what one caller can see, the design does not hold.
 *
 *   node bench-scale.mjs <projects> <memories-per-project>
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const PROJECTS = Number(process.argv[2] ?? 180);
const PER = Number(process.argv[3] ?? 20);
const PLUGIN = process.env.VESTIGE_PLUGIN ?? "/home/brenno/Dev/vestige";

const HOME = mkdtempSync(join(tmpdir(), "scale-home-"));
process.env.VESTIGE_HOME = HOME;
process.env.VESTIGE_NO_UPDATE = "1";
const { remember, search, recall } = await import(pathToFileURL(join(PLUGIN, "core/lib/vestige.ts")).href);

const TOPICS = ["retries", "caching", "auth", "pagination", "migrations", "ratelimit", "observability", "timezones"];
const root = mkdtempSync(join(tmpdir(), "scale-repos-"));

const t0 = Date.now();
let written = 0;
const repos = [];
for (let p = 0; p < PROJECTS; p++) {
	const name = `svc-${String(p).padStart(3, "0")}`;
	const d = join(root, name);
	mkdirSync(d, { recursive: true });
	execFileSync("git", ["init", "-q", d]);
	repos.push({ name, dir: d });
	for (let m = 0; m < PER; m++) {
		const topic = TOPICS[m % TOPICS.length];
		const r = remember({
			title: `${topic} handling in this service, note ${m}`,
			body: `In ${name}, ${topic} needs care: a retried mutation must carry an idempotency key or the ledger double counts the second attempt. Variant ${m}.`,
			confidence: "inferred", scope: "project", projects: [name],
		}, { cwd: d });
		if (r.ok) written++;
	}
}
const tWrite = Date.now() - t0;

// cold: first search in a repo builds its view and index
const cold = [];
const warm = [];
const sample = [repos[0], repos[Math.floor(PROJECTS / 2)], repos[PROJECTS - 1]];
for (const r of sample) {
	let t = Date.now();
	const first = search("idempotency key for a retried mutation", { cwd: r.dir, limit: 5 });
	cold.push({ ms: Date.now() - t, engine: first.engine, hits: first.hits.length });
	t = Date.now();
	const second = search("how do we handle rate limiting here", { cwd: r.dir, limit: 5 });
	warm.push({ ms: Date.now() - t, engine: second.engine, hits: second.hits.length });
}

// what does one caller actually see? this is the number the design depends on
const visible = recall({ cwd: sample[1].dir, limit: 100000 }).length;

console.log(JSON.stringify({
	projects: PROJECTS, per_project: PER, memories_written: written,
	write_ms_total: tWrite, write_ms_each: +(tWrite / written).toFixed(1),
	visible_to_one_caller: visible,
	cold_search: cold, warm_search: warm,
}, null, 2));
rmSync(root, { recursive: true, force: true });
rmSync(HOME, { recursive: true, force: true });
