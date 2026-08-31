#!/usr/bin/env node
// Facet-only ranking: no query relevance at all. Specificity, then recency.
// This is what "qmd is optional" actually means in practice — so measure it
// against a view big enough for ranking to matter.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
const VIEWS = process.argv[2], OUT = process.argv[3], Q = process.argv[4];
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
for (const line of readFileSync(Q, "utf8").split("\n").filter(Boolean)) {
  const [proj] = line.split("\t");
  const topic = line.split("\t")[1];
  let files = [];
  try { files = readdirSync(join(VIEWS, proj)).filter((f) => f.endsWith(".md")); } catch {}
  // every doc in a project view has identical specificity (all name this project),
  // so the tiebreak is recency — newest first, exactly as the facet ranker does.
  const dated = files.map((f) => {
    const m = readFileSync(join(VIEWS, proj, f), "utf8").match(/^date: (\S+)/m);
    return { f, d: m ? m[1] : "0000-00-00" };
  }).sort((a, b) => b.d.localeCompare(a.d));
  writeFileSync(join(OUT, `${proj}__${topic}.txt`), dated.slice(0, 5).map((x) => `qmd://${proj}/${x.f}`).join("\n"));
}
