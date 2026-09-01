#!/usr/bin/env bash
# Does query expansion earn its cost? Three strata, scored separately.
#
# A single mean over these would report neither effect: expansion is expected to
# help where the query is worded unlike the document (B) and to hurt where the
# query IS an identifier the document already contains (C). Averaging a help and
# a harm produces a number describing no workload anyone has.
set -uo pipefail
cd "$(dirname "$0")"
export VESTIGE_PLUGIN="${VESTIGE_PLUGIN:-$(cd .. && pwd)/vestige}"
OUT="${1:-runs/strata}"; mkdir -p "$OUT"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
cool () { for _ in $(seq 1 40); do L=$(cut -d' ' -f1 /proc/loadavg); awk -v l="$L" 'BEGIN{exit !(l<0.7)}' && return 0; sleep 15; done; }

node harness/gen-corpus.mjs "$W/corpus" rich >/dev/null 2>&1
node --experimental-strip-types hybrid/gen-hybrid-corpus.ts "$W/corpus" "$W/pool" 0 >/dev/null 2>&1
node harness/gen-paraphrase-queries.mjs "$W/pool" "$W/hard.tsv" > "$OUT/fixture.json"

for ST in B C D; do
  for SHAPE in typed expand; do
    cool
    echo "[$(date +%H:%M:%S)] stratum=$ST shape=$SHAPE load=$(cut -d' ' -f1 /proc/loadavg)"
    VESTIGE_QUERY_SHAPE=$SHAPE node hybrid/bench-e2e.mjs "$W/pool" "$W/hits" "$W/hard-$ST.tsv" > "$OUT/e2e-$ST-$SHAPE.json" 2>"$OUT/e2e-$ST-$SHAPE.err"
    node harness/score.mjs "$W/hits" "$W/pool" "$ST-$SHAPE" 5 183 > "$OUT/score-$ST-$SHAPE.json" 2>>"$OUT/e2e-$ST-$SHAPE.err"
  done
done
echo STRATA-DONE
