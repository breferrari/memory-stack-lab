#!/usr/bin/env bash
# The paraphrase stratum, kept: hits preserved, plus the reranking arm that was
# never run where it should help — gold in the shortlist but not first.
set -uo pipefail
cd "$(dirname "$0")"
export VESTIGE_PLUGIN="${VESTIGE_PLUGIN:-$(cd .. && pwd)/vestige}"
OUT="${1:-runs/paraphrase-deep}"; mkdir -p "$OUT"
W="$OUT/work"; mkdir -p "$W"
cool () { for _ in $(seq 1 40); do L=$(cut -d' ' -f1 /proc/loadavg); awk -v l="$L" 'BEGIN{exit !(l<0.7)}' && return 0; sleep 15; done; }

node harness/gen-corpus.mjs "$W/corpus" rich >/dev/null 2>&1
node --experimental-strip-types hybrid/gen-hybrid-corpus.ts "$W/corpus" "$W/pool" 0 >/dev/null 2>&1
node harness/gen-paraphrase-queries.mjs "$W/pool" "$W/hard.tsv" > "$OUT/fixture.json"

for ARM in typed rerank; do
  cool
  echo "[$(date +%H:%M:%S)] paraphrase arm=$ARM load=$(cut -d' ' -f1 /proc/loadavg)"
  if [ "$ARM" = "rerank" ]; then export VESTIGE_RERANK=1; else unset VESTIGE_RERANK; fi
  node hybrid/bench-e2e.mjs "$W/pool" "$W/hits-$ARM" "$W/hard-B.tsv" > "$OUT/e2e-$ARM.json" 2>"$OUT/e2e-$ARM.err"
  node harness/score.mjs "$W/hits-$ARM" "$W/pool" "para-$ARM" 5 183 > "$OUT/score-$ARM.json" 2>>"$OUT/e2e-$ARM.err"
  node harness/analyse-stratum.mjs "$W/hits-$ARM" "$W/pool" "$W/hard-B.tsv" > "$OUT/analysis-$ARM.json" 2>>"$OUT/e2e-$ARM.err"
done
echo PARAPHRASE-DEEP-DONE
