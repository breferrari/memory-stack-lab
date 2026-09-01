#!/usr/bin/env bash
# Every benchmark, repeated, serially, on an idle machine.
#
# Three rules encoded here, each learned by breaking it:
#   - REPEAT. One run is an anecdote; the same fixture varies by a query.
#   - SERIAL, with a cooldown. Two timing benches at once measure each other,
#     and without a cooldown a run records the previous run's decaying load.
#   - NEVER EDIT THIS FILE WHILE IT RUNS. Bash reads a script by byte offset as
#     it executes, so an edit mid-run shifts every offset after it and execution
#     resumes inside a token. That killed the previous chain at line 27.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${1:-runs/all-$(date +%F)}"
REPS="${REPS:-3}"
export VESTIGE_PLUGIN="${VESTIGE_PLUGIN:-$(cd .. && pwd)/vestige}"
mkdir -p "$OUT"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

cool () { for _ in $(seq 1 40); do L=$(cut -d' ' -f1 /proc/loadavg); awk -v l="$L" 'BEGIN{exit !(l<0.7)}' && return 0; sleep 15; done; }
say  () { echo "[$(date +%H:%M:%S)] $*"; }

say "seeded corpus"
node harness/gen-corpus.mjs "$WORK/corpus" rich > "$OUT/corpus.json" 2>&1

for OC in 0 0.24; do
  TAG=$(echo "$OC" | tr -d '.')
  say "pool overclaim=$OC"
  node --experimental-strip-types hybrid/gen-hybrid-corpus.ts "$WORK/corpus" "$WORK/pool$TAG" "$OC" > "$OUT/write-$TAG.json" 2>&1
  for i in $(seq 1 "$REPS"); do
    cool; say "e2e arm=$OC run=$i/$REPS load=$(cut -d' ' -f1 /proc/loadavg)"
    node hybrid/bench-e2e.mjs "$WORK/pool$TAG" "$WORK/hits" harness/queries.tsv > "$OUT/e2e-$TAG-$i.json" 2>"$OUT/e2e-$TAG-$i.err"
    node harness/score.mjs "$WORK/hits" "$WORK/pool$TAG" "oc$OC" 5 64 > "$OUT/score-$TAG-$i.json" 2>>"$OUT/e2e-$TAG-$i.err"
  done
done

for i in $(seq 1 "$REPS"); do
  cool; say "rerank run=$i/$REPS"
  node hybrid/bench-rerank.mjs "$WORK/corpus" harness/queries.tsv > "$OUT/rerank-$i.json" 2>"$OUT/rerank-$i.err"
done

for i in $(seq 1 "$REPS"); do
  cool; say "vs-mcs run=$i/$REPS"
  node hybrid/bench-vs-mcs.mjs "$WORK/pool0" harness/queries.tsv "$WORK/vs$i" > "$OUT/vs-mcs-$i.json" 2>"$OUT/vs-mcs-$i.err"
done

for n in 40 180; do
  cool; say "scale projects=$n"
  node hybrid/bench-scale.mjs "$n" 20 > "$OUT/scale-$n.json" 2>"$OUT/scale-$n.err"
done

for n in 5 10 20; do
  for mode in single retry; do
    for i in $(seq 1 "$REPS"); do
      cool; say "push race writers=$n mode=$mode run=$i/$REPS"
      node harness/push-race.mjs "$n" "$mode" 5 > "$OUT/race-$n-$mode-$i.json" 2>"$OUT/race-$n-$mode-$i.err"
    done
  done
done

date +%s > "$OUT/.DONE"
say "ALL DONE -> $OUT"
