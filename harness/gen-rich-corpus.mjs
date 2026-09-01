#!/usr/bin/env node
/**
 * Write the world's memories, in chronological order, each aware of what came
 * before it in its own repository.
 *
 *   node harness/gen-rich-corpus.mjs <world.json> <out-dir> [model]
 *
 * Measured against 413 real memories from a working vault, the templated corpus
 * this replaces was 3.4x poorer in distinct vocabulary per document and carried
 * 0.1 concrete specifics per memory against 5.8 — no identifiers, no error
 * codes, no numbers with units. Those are what an embedder grips and what a
 * symptom query collides with, so a fixture without them measures a task nobody
 * has: telling two interchangeable paragraphs apart.
 *
 * Order matters here. Memories are written oldest-first, and each one is shown
 * the titles of earlier memories in its own repo so it can reference them the
 * way a real note does — and, where the world says so, correct one outright.
 * That produces genuine near-duplicates: related, and distinguishable. The
 * previous fixture's siblings were neither.
 *
 * Length is drawn from the real distribution rather than a flat range: mostly
 * short, sometimes long, because the long ones are where the detail lives.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const [WORLD, OUT, MODEL = "haiku"] = process.argv.slice(2);
if (!WORLD || !OUT) { console.error("usage: gen-rich-corpus.mjs <world.json> <out-dir> [model]"); process.exit(1); }
mkdirSync(OUT, { recursive: true });

const world = JSON.parse(readFileSync(WORLD, "utf8"));
const incidents = new Map(world.incidents.map((i) => [i.id, i]));

let rs = 424242;
const rnd = () => (rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
/**
 * Drawn to match the real vault: median 61, p10 30, p90 266, long tail.
 * The first version centred far too high — median 150 — which is how a fixture
 * ends up easier to search than production.
 */
const targetWords = () => {
  const r = rnd();
  if (r < 0.35) return 25 + Math.floor(rnd() * 30);   // the one-liner that is still a lesson
  if (r < 0.75) return 55 + Math.floor(rnd() * 55);   // the ordinary note
  if (r < 0.93) return 110 + Math.floor(rnd() * 120); // the detailed one
  return 240 + Math.floor(rnd() * 260);               // the rare long write-up
};

const ask = (prompt) => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = execFileSync("claude", ["-p", "--model", MODEL], { input: prompt, encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024 }).trim();
      if (out.length > 60) return out;
    } catch { /* retry once */ }
  }
  return "";
};

const titleOf = (m) => `${m.topic} on ${m.project} (${m.incident})`;
const written = new Map();
const map = {};
let done = 0, skipped = 0;

for (const m of world.memories) {
  const file = `${m.id}.md`;
  if (existsSync(join(OUT, file))) { map[m.id] = { project: m.project, topic: m.topic, incident: m.incident }; done++; continue; }
  const inc = incidents.get(m.incident);
  const priors = m.references.map((r) => written.get(r)).filter(Boolean);
  const words = targetWords();

  const priorBlock = priors.length
    ? `\nEarlier notes in this same repository, which you may refer to by name if it is natural:\n${priors.map((p) => `- "${p.title}" — ${p.gist}`).join("\n")}`
    : "";
  const supersedeBlock = m.supersedes && written.get(m.supersedes)
    ? `\nThis note CORRECTS the earlier one titled "${written.get(m.supersedes).title}". Say what that note got wrong and why, without repeating it in full.`
    : "";
  const counterpart = m.counterpart.length
    ? `\nThe same incident is also being written up by the ${m.counterpart.join(" and ")} team. Write it from ${m.project}'s side only — ${m.perspective} — and mention the other service by name where the boundary matters.`
    : "";

  const body = ask(
`You keep an engineering notebook for ${m.project} (${m.role}, ${m.stack}). Write ONE entry, in plain prose, as the engineer who worked it.

What happened, on day ${m.day}: ${inc.symptom}. ${m.artefact} is central to it. The signal that showed it was ${m.signal}, around ${m.magnitude}. ${m.lib} and the ${m.configKey} setting are both involved.${counterpart}${priorBlock}${supersedeBlock}

Rules:
- About ${words} words. Plain paragraphs. No title, no headings, no bullet lists, no markdown.
- Say what was true, why, and what to do instead. Concrete over general.
- Name ${m.artefact} and ${m.signal}. Mention ${m.configKey} or ${m.lib} only if the sentence needs it. Do not pile on further identifiers — write it the way a tired engineer would, not as a reference page.
- Never describe this as a memory, a lesson, or a note. Just write the thing.`);

  if (!body) { skipped++; process.stderr.write(`  ${m.id}: empty after retry\n`); continue; }

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
  if (done % 10 === 0) process.stderr.write(`  ${done}/${world.memories.length}\n`);
}

writeFileSync(join(OUT, "_map.json"), JSON.stringify(map, null, 1));
console.log(JSON.stringify({ written: done, skipped, out: OUT, model: MODEL }, null, 1));
