#!/usr/bin/env node
// Per-project filtered views for a scope-aware V4 filter.
// A filter MUST admit scope:general memories (they claim to apply everywhere),
// so an over-claimed `general` reaches every project THROUGH the filter.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const SRC = process.argv[2], OUT = process.argv[3];
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const docs = readdirSync(SRC).filter(f => f.endsWith('.md')).map(f => {
  const b = readFileSync(join(SRC, f), 'utf8');
  return { f, b, scope: (b.match(/^scope: (\w+)/m) || [])[1], proj: f.split('__')[0] };
});
const projects = [...new Set(docs.map(d => d.proj))];
let total = 0;
for (const p of projects) {
  mkdirSync(join(OUT, p), { recursive: true });
  const view = docs.filter(d => d.proj === p || d.scope === 'general');
  for (const d of view) writeFileSync(join(OUT, p, d.f), d.b);
  total += view.length;
}
console.log(JSON.stringify({ src: SRC, projects: projects.length,
  general_docs: docs.filter(d => d.scope === 'general').length,
  mean_docs_per_project_view: +(total / projects.length).toFixed(1) }));
