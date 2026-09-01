#!/usr/bin/env node
/**
 * Write the world's memories, in chronological order, each aware of what came
 * before it in its own repository.
 *
 *   node harness/gen-rich-corpus.mjs <world.json> <out-dir> [model] [--reference <profile.json>]
 *
 * Length is not left to the model. A model asked for "about 500 words" returns
 * 180 and reports 500, because counting its own output is the one thing it
 * cannot do. So the target is sampled from the reference corpus's decile table,
 * the draft is COUNTED here, and a short one is continued until it lands. The
 * loop is what makes the number true; the number in the prompt is only a steer.
 *
 * The reference is a real store of MCP captures: median 503 words, p10 318,
 * p90 684, 14.1 concrete specifics per memory. An earlier version of this file
 * targeted a median of 61 and called the result realistic, because the profile
 * it was calibrated against had counted index-note bullets rather than whole
 * memories. Everything downstream of that — including a judgement that the
 * corpus was "too rich" — was backwards. Hence reference/vault-memories.json,
 * committed, regenerable, and carrying its own n.
 *
 * Order matters. Memories are written oldest-first, and each is shown the
 * titles of earlier ones in its own repo so it can reference them the way a
 * real note does — and, where the world says so, correct one outright. That
 * produces genuine near-duplicates: related, and distinguishable.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { countWords, sampleWords } from "./lib/measure.mjs";

const args = process.argv.slice(2);
const refFlag = args.indexOf("--reference");
const REF = refFlag > 0 ? args[refFlag + 1] : "reference/vault-memories.json";
const [WORLD, OUT, MODEL = "haiku"] = args.filter((_, i) => refFlag < 0 || (i !== refFlag && i !== refFlag + 1));
if (!WORLD || !OUT) { console.error("usage: gen-rich-corpus.mjs <world.json> <out-dir> [model] [--reference <profile.json>]"); process.exit(1); }
mkdirSync(OUT, { recursive: true });

const world = JSON.parse(readFileSync(WORLD, "utf8"));
const profile = JSON.parse(readFileSync(REF, "utf8"));
// Validate the reference rather than trusting it. A profile whose deciles are
// not finite numbers yields a one-word target for every memory, and the run
// completes.
if (!Array.isArray(profile.word_deciles) || profile.word_deciles.length !== 11 || !profile.word_deciles.every((d) => Number.isFinite(d) && d > 0)) {
	console.error(`reference ${REF} has no usable decile table`); process.exit(1);
}
const incidents = new Map(world.incidents.map((i) => [i.id, i]));

let rs = 424242;
const rnd = () => (rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const ask = (prompt) => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = execFileSync("claude", ["-p", "--model", MODEL], { input: prompt, encoding: "utf8", timeout: 240000, maxBuffer: 8 * 1024 * 1024 }).trim();
      if (out.length > 60) return out;
    } catch { /* retry once */ }
  }
  return "";
};

/**
 * Generate, count, continue. Two top-ups at most: past that the entry is padding
 * itself and a short memory is more honest than a bloated one. Over-length is
 * left alone — the reference has a tail, and trimming to a target would erase it.
 */
const TOP_UPS = 2;
const writeToLength = (first, target, context) => {
  let body = ask(first);
  if (!body) return "";
  for (let i = 0; i < TOP_UPS; i++) {
    const have = countWords(body);
    if (have >= target * 0.8) break;
    const more = ask(
`${context}

Here is the entry so far:

${body}

Continue it for roughly ${target - have} more words. Do not repeat anything above, do not summarise it, do not add a heading or a sign-off. Pick up where it stops and keep going: what else was tried, what it cost, what someone hitting this next should check first. Return ONLY the continuation.`);
    if (!more) break;
    body = `${body}\n\n${more}`;
  }
  return body;
};

const titleOf = (m) => `${m.topic} on ${m.project} (${m.incident})`;
const written = new Map();
const map = {};
let done = 0, skipped = 0, short = 0;
const lengths = [];

for (const m of world.memories) {
  const file = `${m.id}.md`;
  // Resume, and REGISTER what is already there. Skipping straight to `continue`
  // left `written` holding only what this process generated, so on a resumed run
  // every memory already on disk was invisible: `priors` came back empty and the
  // supersede instruction vanished. The 27 corrections regenerated that way were
  // written with no instruction to correct anything, and the run reported
  // success. A resume path that silently drops context is worse than no resume.
  if (existsSync(join(OUT, file))) {
    const prev = readFileSync(join(OUT, file), "utf8");
    written.set(m.id, { title: titleOf(m), gist: prev.replace(/^---[\s\S]*?---\n/, "").replace(/^\s*#[^\n]*\n/, "").replace(/^\s*\*\*Applies to:\*\*[^\n]*\n/, "").trim().slice(0, 140).replace(/\s+/g, " ") });
    map[m.id] = { project: m.project, topic: m.topic, incident: m.incident };
    done++; continue;
  }
  const inc = incidents.get(m.incident);
  const priors = m.references.map((r) => written.get(r)).filter(Boolean);
  const target = sampleWords(profile.word_deciles, rnd);

  const priorBlock = priors.length
    ? `\nEarlier notes in this same repository, which you may refer to by name if it is natural:\n${priors.map((p) => `- "${p.title}" — ${p.gist}`).join("\n")}`
    : "";
  // The correcting note revisits the SAME incident, so it can say what the
  // earlier explanation got wrong about it. When it was allowed to be about a
  // different event, the model wrote up that event and bolted on two words of
  // correction language, which reads as a correction and is not one.
  // Loudly, because the failure this replaces was silent. A correction whose
  // predecessor is not in hand gets written as an ordinary note and the run
  // still succeeds — which is exactly what happened on the first resumed run.
  if (m.supersedes && !written.has(m.supersedes)) {
    console.error(`${m.id} corrects ${m.supersedes}, which is neither generated nor on disk — refusing to write it as an ordinary note`);
    process.exit(1);
  }
  const supersedeBlock = m.supersedes && written.get(m.supersedes)
    ? `\nYou are revisiting an incident you already wrote up, in the note titled "${written.get(m.supersedes).title}". THIS IS THE SAME EVENT, understood better. Open by saying what that earlier note concluded and why it was wrong — name the mechanism it blamed — then give the real one. Do not describe it as a new incident.`
    : "";
  const counterpart = m.counterpart.length
    ? `\nThe same incident is also being written up by the ${m.counterpart.join(" and ")} team. Write it from ${m.project}'s side only — ${m.perspective} — and mention the other service by name where the boundary matters.`
    : "";

  const context = `You keep an engineering notebook for ${m.project} (${m.role}, ${m.stack}). The entry is about: ${inc.symptom}, centred on ${m.artefact}, shown by ${m.signal} around ${m.magnitude}.`;

  const body = writeToLength(
`${context}

Write ONE entry, in plain prose, as the engineer who worked it.

What happened, on day ${m.day}: ${inc.symptom}. ${m.artefact} is central to it. The signal that showed it was ${m.signal}, around ${m.magnitude}. ${m.lib} and the ${m.configKey} setting are both involved.${counterpart}${priorBlock}${supersedeBlock}

Cover, in this order and without headings:
- what broke and how it presented, including what it looked like before anyone understood it
- why it happened — the actual mechanism, not a restatement of the symptom
- how it was confirmed: the specific thing measured or observed that made it certain rather than plausible
- what to do instead, and where else this shape shows up

Rules:
- Around ${target} words. Plain paragraphs, no headings, no bullet lists, no markdown.
- Name ${m.artefact} and ${m.signal}. Use ${m.configKey} and ${m.lib} where the sentence needs them. Concrete over general throughout: numbers with units, file and symbol names, what the log actually said.
- Never describe this as a memory, a lesson, or a note. Just write the thing.`,
    target, context);

  if (!body) { skipped++; process.stderr.write(`  ${m.id}: empty after retry\n`); continue; }
  const got = countWords(body);
  if (got < target * 0.8) short++;
  lengths.push(got);

  const fm = [
    "---", "scope: project", "projects:", `  - ${m.project}`,
    `topic: ${m.topic}`, `incident: ${m.incident}`, `day: ${m.day}`,
    ...(m.supersedes ? [`supersedes: ${m.supersedes}`] : []),
    ...(m.references.length ? [`related: [${m.references.map((r) => JSON.stringify(r)).join(", ")}]`] : []),
    "---", "",
  ].join("\n");
  writeFileSync(join(OUT, file), `${fm}# ${inc.symptom[0].toUpperCase()}${inc.symptom.slice(1)} — ${m.project}\n\n**Applies to:** ${m.project}\n\n${body}\n`);

  written.set(m.id, { title: titleOf(m), gist: body.slice(0, 140).replace(/\s+/g, " ") });
  map[m.id] = { project: m.project, topic: m.topic, incident: m.incident };
  done++;
  if (done % 10 === 0) {
    const med = [...lengths].sort((a, b) => a - b)[Math.floor(lengths.length / 2)] ?? 0;
    process.stderr.write(`  ${done}/${world.memories.length}  median so far ${med}w (target median ${profile.median_words})\n`);
  }
}

writeFileSync(join(OUT, "_map.json"), JSON.stringify(map, null, 1));
console.log(JSON.stringify({ written: done, skipped, still_short_after_top_ups: short, reference: profile.name, out: OUT, model: MODEL }, null, 1));
