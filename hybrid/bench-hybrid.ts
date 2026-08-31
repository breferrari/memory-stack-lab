/**
 * Materialise each caller's visible view via the hybrid's own read path, so the
 * benchmark measures the shipped filter rather than a re-implementation.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readPool, materializeView } from "./memory.ts";

const POOL = process.argv[2];
const OUTROOT = process.argv[3];
const entries = readPool(POOL);
const projects = [...new Set(entries.flatMap((e) => e.facets.projects))].sort();

rmSync(OUTROOT, { recursive: true, force: true });
const sizes: Record<string, number> = {};
for (const p of projects) {
	const n = materializeView(entries, { project: p, platforms: [] }, join(OUTROOT, p));
	sizes[p] = n;
	// carry the id->{project,topic} map into each view so the shared scorer works
	if (existsSync(join(POOL, "_map.json"))) writeFileSync(join(OUTROOT, p, "_map.json"), readFileSync(join(POOL, "_map.json"), "utf8"));
}
const vals = Object.values(sizes);
console.log(JSON.stringify({
	pool_docs: entries.length,
	projects: projects.length,
	mean_view_size: +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1),
	max_view_size: Math.max(...vals),
}, null, 2));
