#!/usr/bin/env node
/**
 * What a caller searches as the store grows.
 *
 *   node harness/bench-view-growth.mjs <out.json>
 *
 * The retrieval curve measured how quality falls with the number of documents
 * in the index. This measures the other half: how that number grows as an
 * organisation adds projects, under each design.
 *
 *   one shared pool     the caller searches everything. Linear in store size.
 *   per-project index   the caller searches what its own project wrote.
 *   declared reach      the caller searches its own memories plus the ones that
 *                       say they reach it — so it grows with what is SHARED,
 *                       not with how many projects exist.
 *
 * No embedding and no retrieval here: view size is a property of the write
 * contract and the visibility rule, so it is counted rather than scored.
 * Composing it with the retrieval curve is what says where each design ends up,
 * and that composition is stated as a projection rather than a measurement.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const OUT = process.argv[2];
const PLUGIN = process.env.VESTIGE_PLUGIN ?? resolve("..", "vestige");
process.env.VESTIGE_NO_UPDATE = "1";
delete process.env.CLAUDE_PROJECT_DIR;
const { remember, recall } = await import(pathToFileURL(join(PLUGIN, "core/lib/vestige.ts")).href);

const PER_PROJECT = 20;
const SHARED_RATE = 0.31; // what this corpus actually carries
const rows = [];

for (const N of [2, 4, 8, 16, 32, 64]) {
	process.env.VESTIGE_HOME = mkdtempSync(join(tmpdir(), "vh-grow-"));
	const root = mkdtempSync(join(tmpdir(), "grow-"));
	const names = Array.from({ length: N }, (_, i) => `svc-${String(i).padStart(3, "0")}`);
	const repoOf = {};
	for (const s of names) { const d = join(root, s); mkdirSync(d, { recursive: true }); execFileSync("git", ["init", "-q", d]); repoOf[s] = d; }
	let seed = 4242; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	let total = 0, shared = 0;
	for (const s of names) {
		for (let i = 0; i < PER_PROJECT; i++) {
			const isShared = rnd() < SHARED_RATE;
			const r = remember({
				title: `A fault in ${isShared ? "a shared client" : s} number ${i}`,
				body: `An incident on ${s}. ${isShared ? "It is a defect in a library every service imports, so the lesson applies to all of them." : "It is specific to this service's own configuration."} The body is long enough to clear the minimum the write contract enforces, and carries a plausible amount of detail so nothing is refused for being too short.`,
				confidence: "inferred", scope: "project", projects: isShared ? names : [s],
			}, { cwd: repoOf[s] });
			if (r.ok) { total++; if (isShared) shared++; }
		}
	}
	const view = recall({ cwd: repoOf[names[0]], limit: 100000 }).length;
	rows.push({ projects: N, memories_in_store: total, declared_shared: shared, caller_view_declared_reach: view, caller_view_shared_pool: total, caller_view_per_project_index: PER_PROJECT });
	process.stderr.write(`  ${N} projects: store ${total}, reach view ${view}, shared pool ${total}\n`);
	rmSync(root, { recursive: true, force: true });
}

const out = {
	per_project_memories: PER_PROJECT, share_rate: SHARED_RATE, rows,
	reading: "A shared pool's view is the whole store and grows with every project added. A per-project index is flat and cannot see anything another project wrote. Declared reach grows only with what is genuinely shared, so it sits between them and its slope is set by the store's sharing rate rather than by how many projects exist.",
	caveat: "View SIZE is counted here, not retrieval quality. Composing it with the measured quality-versus-view-size curve is a projection, and is labelled as one.",
};
if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
