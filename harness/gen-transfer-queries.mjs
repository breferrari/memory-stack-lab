#!/usr/bin/env node
/**
 * Queries that can only be answered by a memory another repository wrote.
 *
 *   node harness/gen-transfer-queries.mjs <world.json> <q-symptom.tsv> <out.tsv>
 *
 * Every query in this suite so far was asked by the service that WROTE the
 * memory it was looking for. Under that shape a per-project index and a declared
 * reach model are indistinguishable, because the answer is always already in the
 * asker's own folder. It is why the scoped-versus-shared result measured index
 * cardinality and not reach.
 *
 * This asks the other question. For each memory whose declared reach covers
 * every service — a fault in a library they all import — the query is issued by
 * a service that did NOT write it. The gold is that memory.
 *
 *   declared reach          the memory is in the caller's view. Findable.
 *   one index per project   it lives in the author's index. NOT findable at all.
 *   one shared pool         findable, and competing with 182 other documents.
 *
 * The query TEXT is reused verbatim from the symptom register rather than
 * generated afresh: it is a description of a symptom, it contains no service
 * name, and rewriting it per asker would introduce a second variable. Stated
 * here because reuse is a choice and not an accident.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [WORLD, SYMPTOM, OUT] = process.argv.slice(2);
if (!WORLD || !SYMPTOM || !OUT) { console.error("usage: gen-transfer-queries.mjs <world.json> <q-symptom.tsv> <out.tsv>"); process.exit(1); }
const world = JSON.parse(readFileSync(WORLD, "utf8"));
const byId = new Map(world.memories.map((m) => [m.id, m]));

const queryFor = new Map();
for (const line of readFileSync(SYMPTOM, "utf8").split("\n").filter(Boolean)) {
	const [, key, doc] = line.split("\t");
	queryFor.set(key, doc);
}

const rows = [];
for (const m of world.memories) {
	if (!m.reaches || m.reaches.length < 2) continue;
	const doc = queryFor.get(m.id);
	if (!doc) continue;
	// A different service that this memory declares it reaches. Deterministic:
	// the first in the declared list that is not the author.
	const asker = m.reaches.find((r) => r !== m.project);
	if (!asker) continue;
	rows.push(`${asker}\t${m.id}\t${doc}`);
}
writeFileSync(OUT, `${rows.join("\n")}\n`);
console.log(JSON.stringify({
	transfer_queries: rows.length,
	of_memories_reaching_beyond_their_origin: world.memories.filter((m) => m.reaches?.length > 1).length,
	note: "Each query is asked by a service that did not write the memory it must find. A per-project index cannot answer these at all; that is the point.",
}, null, 1));
