#!/usr/bin/env node
/**
 * Mean across repetitions, with the spread beside it.
 *
 * A single run is an anecdote and a min-max range headlines the worst run,
 * which is as skewed as headlining the best. What a reader needs is the mean,
 * the number of runs it averages, and enough spread to see whether the mean
 * means anything.
 *
 *   node harness/aggregate.mjs <dir> [...more dirs]
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const stat = (v) => {
	const n = v.length;
	const mean = v.reduce((a, b) => a + b, 0) / n;
	const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
	return { n, mean, sd, min: Math.min(...v), max: Math.max(...v) };
};
const r3 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(3) : v]));

for (const dir of process.argv.slice(2)) {
	const files = readdirSync(dir);
	const arms = new Map();
	for (const f of files) {
		const m = f.match(/^score-(.+?)-(\d+)\.json$/);
		if (!m) continue;
		const [, arm] = m;
		const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
		const e = (() => { try { return JSON.parse(readFileSync(join(dir, `e2e-${arm}-${m[2]}.json`), "utf8")); } catch { return null; } })();
		if (!arms.has(arm)) arms.set(arm, []);
		arms.get(arm).push({ s, e });
	}
	if (!arms.size) { console.error(`${dir}: no score-<arm>-<n>.json files`); continue; }

	const out = { dir: basename(dir), arms: {} };
	for (const [arm, runs] of [...arms].sort()) {
		const pick = (f) => runs.map(f).filter((x) => typeof x === "number" && Number.isFinite(x));
		const quality = {
			found_at_5: r3(stat(pick((r) => r.s.target_found_in_topk))),
			rank_1: r3(stat(pick((r) => r.s.target_at_rank1))),
			mrr: r3(stat(pick((r) => r.s.mrr))),
			foreign_in_top5: r3(stat(pick((r) => r.s.mean_foreign_in_topk))),
		};
		const lat = pick((r) => r.e?.latency_ms?.steady_state_mean).length
			? {
				first_query_per_project_ms: r3(stat(pick((r) => r.e.latency_ms.first_query_per_project_mean))),
				steady_state_ms: r3(stat(pick((r) => r.e.latency_ms.steady_state_mean))),
				p50_ms: r3(stat(pick((r) => r.e.latency_ms.p50))),
				ambient_load_before: r3(stat(pick((r) => r.e.load_ambient_before?.[0]))),
			}
			: null;
		out.arms[arm] = { runs: runs.length, quality, latency: lat };
	}
	// Push race: mean landed-of-N per (writers, mode) across repetitions.
	const race = new Map();
	for (const f of files) {
		const m = f.match(/^race-(\d+)-(single|retry)-(\d+)\.json$/);
		if (!m) continue;
		let j; try { j = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
		const key = `${m[1]}w-${m[2]}`;
		if (!race.has(key)) race.set(key, []);
		race.get(key).push(j);
	}
	if (race.size) {
		out.push_race = {};
		for (const [key, runs] of [...race].sort()) {
			const landed = runs.map((r) => r.landed);
			const writers = runs[0].writers;
			out.push_race[key] = { runs: runs.length, writers, landed: r3(stat(landed)), landed_fraction: +(stat(landed).mean / writers).toFixed(3) };
		}
	}
	console.log(JSON.stringify(out, null, 1));
}
