#!/usr/bin/env node
/**
 * Measure a corpus and emit its shape as JSON.
 *
 *   node harness/profile-corpus.mjs <dir> [--name <label>] > reference/x.json
 *
 * This exists so the reference is an artifact rather than a number remembered
 * from a shell that has since closed. The first reference used here was exactly
 * that, and it turned out to have counted the wrong unit — index-note bullets
 * instead of whole memories — which put its median at 61 words against a real
 * 503 and made every downstream judgement about "too rich" backwards.
 *
 * Only statistics are emitted. No document content leaves the source.
 */
import { bodiesIn, profileBodies } from "./lib/measure.mjs";
const dir = process.argv[2];
const i = process.argv.indexOf("--name");
if (!dir) { console.error("usage: profile-corpus.mjs <dir> [--name <label>]"); process.exit(1); }
console.log(JSON.stringify({ name: i > 0 ? process.argv[i + 1] : dir, ...profileBodies(bodiesIn(dir)) }, null, 1));
