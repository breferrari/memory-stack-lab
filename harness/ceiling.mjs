#!/usr/bin/env node
// How many documents owned by the asking project, on the asked topic, actually
// EXIST in a corpus variant. precision@K cannot exceed min(ceiling,K)/K.
// Separates survival (did the memory live?) from retrieval (was it found?).
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
const CORPUS = process.argv[2], Q = process.argv[3], K = Number(process.argv[4] || 5);
const docs = [];
for (const f of readdirSync(CORPUS).filter(f => f.endsWith('.md'))) {
  const b = readFileSync(join(CORPUS, f), 'utf8');
  const o = b.match(/\*\*Applies to:\*\*\s*([a-z0-9-]+)/i);
  docs.push({ id: f.replace(/\.md$/, ''), owner: o && o[1] });
}
const queries = readFileSync(Q, 'utf8').split('\n').filter(Boolean)
  .map(l => { const [proj, topic] = l.split('\t'); return { proj, topic }; });
let tot = 0, zero = 0;
for (const q of queries) {
  // topic is encoded in the document id: `..._<topic>_<specific>`
  const c = docs.filter(d => d.owner === q.proj && d.id.includes(`_${q.topic}_`)).length;
  tot += Math.min(c, K); if (c === 0) zero++;
}
console.log(JSON.stringify({
  corpus: basename(CORPUS), docs: docs.length, queries: queries.length,
  max_precision_at_k: +(tot / (queries.length * K)).toFixed(3),
  queries_with_no_own_doc_in_corpus: +(zero / queries.length).toFixed(3),
}, null, 2));
