#!/usr/bin/env node
/**
 * Session logs — the EPISODIC tier the hybrid does not have.
 *
 * These are the distractor class the literature warns about: they mention the
 * same topics a durable lesson covers, in passing, while teaching nothing. They
 * are also more recent and more verbose than the lesson, which is exactly why
 * they are claimed to outrank it.
 *
 * Deliberately realistic rather than adversarial — this is what a session log
 * actually looks like, not a crafted attack on the ranker.
 */
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SEMANTIC = process.argv[2];          // the lesson corpus, to learn projects+topics from
const OUT = process.argv[3];
const PER_PROJECT = Number(process.argv[4] ?? 8);

let seed = 20260901;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a) => a[Math.floor(rnd() * a.length)];

const map = JSON.parse(readFileSync(join(SEMANTIC, "_map.json"), "utf8"));
const byProject = {};
for (const v of Object.values(map)) (byProject[v.project] ??= new Set()).add(v.topic);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const VERBS = ["Worked on", "Debugged", "Paired on", "Reviewed", "Investigated", "Shipped"];
const AREAS = ["the checkout flow", "the ingest job", "the settings screen", "the nightly build", "the on-call rota", "the staging cutover"];
const CHORES = ["rebased onto main", "updated the changelog", "bumped a dependency", "cleaned up a stale branch", "answered a support ticket", "sat in planning"];

const episodicMap = {};
let n = 0;
for (const [project, topicSet] of Object.entries(byProject)) {
  const topics = [...topicSet];
  for (let i = 0; i < PER_PROJECT; i++) {
    // each log brushes past two or three real topics without teaching them
    const touched = [pick(topics), pick(topics), pick(topics)];
    const day = String(1 + Math.floor(rnd() * 28)).padStart(2, "0");
    const date = `2026-08-${day}`;
    const id = `${project}__session-${date}-${i}`;
    const body = `---
date: ${date}
kind: session
scope: project
projects: ["${project}"]
---

# Session ${date} — ${project}

**Applies to:** ${project}

${pick(VERBS)} ${pick(AREAS)}. Touched ${touched[0]} and ${touched[1]} while chasing a flaky failure, and skimmed the ${touched[2]} config on the way past. Nothing conclusive.

## What happened

- ${pick(CHORES)}
- looked at ${touched[0]} again, still not sure it is the cause
- left a TODO near the ${touched[1]} path
- ${pick(CHORES)}

## Notes

Mentioned ${touched[0]} in standup. Will pick ${touched[1]} back up tomorrow.
`;
    writeFileSync(join(OUT, `${id}.md`), body);
    // topic 'session' never matches a query topic, so these are known-but-irrelevant
    episodicMap[id] = { project, topic: "session" };
    n++;
  }
}
writeFileSync(join(OUT, "_map.json"), JSON.stringify(episodicMap, null, 1));
console.log(JSON.stringify({ projects: Object.keys(byProject).length, per_project: PER_PROJECT, session_logs: n }));
