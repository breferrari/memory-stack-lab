#!/usr/bin/env node
/**
 * Can the system say "I have nothing for you"?
 *
 *   node harness/bench-abstention.mjs <pool> [out.json]
 *
 * Every query in every other experiment has a correct answer in the store, so
 * no arm can be punished for answering when it should not. That makes the whole
 * suite blind to the failure a user actually notices: asking something the store
 * has no memory of and receiving five confident, irrelevant memories.
 *
 * This asks questions no engineering store could answer — cooking, music,
 * eighteenth-century European history, and a gibberish token — and records what
 * comes back. The comparison that matters is against on-topic queries: if the
 * two are indistinguishable from the caller's side, then a reader downstream has
 * no signal either, and "relevant" is doing no work in the product.
 *
 * The mechanism is visible in the code and this measures its consequence: qmd is
 * invoked with `--format files`, so scores are discarded before the plugin sees
 * them, RecallHit carries no score, and the no-match branch returns whatever is
 * visible in facet order. There is nothing a threshold could be applied to.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const POOL = process.argv[2];
const OUT = process.argv[3];
if (!POOL) { console.error("usage: bench-abstention.mjs <pool> [out.json]"); process.exit(1); }
const PLUGIN = process.env.VESTIGE_PLUGIN ?? join(process.cwd(), "..", "vestige");
process.env.VESTIGE_NO_UPDATE = "1";
// Without an isolated home the caller also sees the developer's own personal
// store, whose memories are general-scope and visible to everyone. Three of them
// on this machine, and they turned up in the first version of this probe.
process.env.VESTIGE_HOME = mkdtempSync(join(tmpdir(), "vh-abstain-"));
delete process.env.CLAUDE_PROJECT_DIR;

const { remember, search } = await import(pathToFileURL(join(PLUGIN, "core/lib/vestige.ts")).href);

const map = JSON.parse(readFileSync(join(POOL, "_map.json"), "utf8"));
const projects = [...new Set(Object.values(map).map((m) => m.project))].sort();
const root = mkdtempSync(join(tmpdir(), "abstain-repos-"));
const repoOf = {};
for (const p of projects) {
	const d = join(root, p);
	mkdirSync(d, { recursive: true });
	execFileSync("git", ["init", "-q", d]);
	repoOf[p] = d;
}
let landed = 0;
for (const [id, meta] of Object.entries(map)) {
	const md = readFileSync(join(POOL, `${id}.md`), "utf8");
	const title = (md.match(/^# (.+)$/m) ?? [])[1] ?? id;
	const body = md.replace(/^---[\s\S]*?---\n/, "").replace(/^#[^\n]*\n/, "").replace(/^\*\*Applies to:\*\*[^\n]*\n/m, "").trim();
	if (remember({ title, body, confidence: "inferred", scope: "project", projects: [meta.project] }, { cwd: repoOf[meta.project] }).ok) landed++;
}

/** Nothing an engineering memory store could legitimately answer. */
const OFF_TOPIC = [
	"sourdough starter will not rise in a cold kitchen",
	"drop C tuning for a seven string guitar",
	"causes of the war of the spanish succession",
	"zzzqqxx nonexistent gibberish token 8827",
	"best time of year to visit the outer hebrides",
	"why does my basil keep wilting on the windowsill",
	"offside rule explained for someone who has never watched football",
	"how to remove a red wine stain from linen",
];

const probe = async (queries, label) => {
	const rows = [];
	for (const q of queries) {
		for (const p of projects) {
			const r = await search(q, { cwd: repoOf[p], limit: 5 });
			rows.push({ engine: r.engine, returned: r.hits.length, note: r.note ?? null });
		}
	}
	const n = rows.length;
	return {
		label, queries: n,
		returned_something: +(rows.filter((r) => r.returned > 0).length / n).toFixed(3),
		mean_returned: +(rows.reduce((s, r) => s + r.returned, 0) / n).toFixed(2),
		served_by_qmd: +(rows.filter((r) => r.engine === "qmd").length / n).toFixed(3),
		carried_any_caveat: +(rows.filter((r) => r.note).length / n).toFixed(3),
	};
};

// On-topic control, drawn from the memories themselves — deliberately the EASIEST
// possible queries, so that if the two arms still look identical, nothing the
// caller can observe separates a question the store answers from one it cannot.
const onTopic = Object.values(map).slice(0, OFF_TOPIC.length).map((m) => `${m.topic} problem in ${m.project}`);

const off = await probe(OFF_TOPIC, "off-topic — the store has no memory of these");
const on = await probe(onTopic, "on-topic — the store does hold an answer");
const result = {
	pool_memories: landed, projects: projects.length,
	arms: [off, on],
	distinguishable_by_the_caller:
		off.returned_something !== on.returned_something || off.carried_any_caveat !== on.carried_any_caveat || off.served_by_qmd !== on.served_by_qmd,
	// Stated because it changes what the result means: these queries are issued
	// WITH a project identity, so the question is "return five notes from
	// payments-api for a sourdough question", which is a harder refusal than an
	// unscoped one. The result is that it does exactly that.
	queries_were_scoped_to_a_project: true,
	reading: "If distinguishable_by_the_caller is false, an agent receiving these results cannot tell a question the store answers from one it has never heard of. qmd runs with --format files, so scores never reach the plugin and there is nothing for a threshold to read.",
};
const json = JSON.stringify(result, null, 1);
if (OUT) writeFileSync(OUT, json);
console.log(json);
