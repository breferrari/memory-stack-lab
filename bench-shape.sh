#!/usr/bin/env bash
# A/B the query shape Vestige sends to qmd: SDK auto-expansion (lex/vec/hyde,
# where hyde is model output) against explicit typed sub-queries.
#
# Same corpus, same queries, same machine, alternating arms so a drift in
# machine state cannot land entirely on one of them.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${1:?out dir}"; REPS="${REPS:-3}"
export VESTIGE_PLUGIN="${VESTIGE_PLUGIN:-$(cd .. && pwd)/vestige}"
mkdir -p "$OUT"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
cool () { for _ in $(seq 1 40); do L=$(cut -d' ' -f1 /proc/loadavg); awk -v l="$L" 'BEGIN{exit !(l<0.7)}' && return 0; sleep 15; done; }

node harness/gen-corpus.mjs "$WORK/corpus" rich >/dev/null 2>&1
node --experimental-strip-types hybrid/gen-hybrid-corpus.ts "$WORK/corpus" "$WORK/pool" 0 >/dev/null 2>&1

for i in $(seq 1 "$REPS"); do
  for SHAPE in expand typed; do
    cool
    echo "[$(date +%H:%M:%S)] shape=$SHAPE run=$i/$REPS load=$(cut -d' ' -f1 /proc/loadavg)"
    VESTIGE_QUERY_SHAPE=$SHAPE node hybrid/bench-e2e.mjs "$WORK/pool" "$WORK/hits" harness/queries.tsv > "$OUT/e2e-$SHAPE-$i.json" 2>"$OUT/e2e-$SHAPE-$i.err"
    node harness/score.mjs "$WORK/hits" "$WORK/pool" "$SHAPE" 5 64 > "$OUT/score-$SHAPE-$i.json" 2>>"$OUT/e2e-$SHAPE-$i.err"
  done
done
date +%s > "$OUT/.DONE"
echo "SHAPE AB DONE -> $OUT"
