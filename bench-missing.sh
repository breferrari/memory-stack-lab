#!/usr/bin/env bash
# Re-run only the phases that failed in the main chain: rerank (wrong input
# shape) and scale (search became async and this bench was never updated).
set -uo pipefail
cd "$(dirname "$0")"
OUT="${1:?out dir}"; REPS="${REPS:-3}"
export VESTIGE_PLUGIN="${VESTIGE_PLUGIN:-$(cd .. && pwd)/vestige}"
mkdir -p "$OUT"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
cool () { for _ in $(seq 1 40); do L=$(cut -d' ' -f1 /proc/loadavg); awk -v l="$L" 'BEGIN{exit !(l<0.7)}' && return 0; sleep 15; done; }
say  () { echo "[$(date +%H:%M:%S)] $*"; }

say "seeded corpus"
node harness/gen-corpus.mjs "$WORK/corpus" rich > "$OUT/corpus.json" 2>&1

for i in $(seq 1 "$REPS"); do
  cool; say "rerank run=$i/$REPS"
  node hybrid/bench-rerank.mjs "$WORK/corpus" harness/queries.tsv > "$OUT/rerank-$i.json" 2>"$OUT/rerank-$i.err"
done

for n in 40 180; do
  cool; say "scale projects=$n"
  node hybrid/bench-scale.mjs "$n" 20 > "$OUT/scale-$n.json" 2>"$OUT/scale-$n.err"
done

date +%s > "$OUT/.DONE-MISSING"
say "MISSING PHASES DONE"
