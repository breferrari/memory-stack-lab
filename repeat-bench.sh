#!/usr/bin/env bash
# Run the end-to-end bench N times per arm. One run is an anecdote: the same
# fixture scored 1.000 and 0.984 on consecutive runs, so a single number would
# have published whichever one happened to come first.
set -euo pipefail
cd "$(dirname "$0")"
N="${1:-3}"; OUT="${2:-runs/repeat-$(date +%F)}"
export VESTIGE_PLUGIN="${VESTIGE_PLUGIN:-$(cd .. && pwd)/vestige}"
mkdir -p "$OUT"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
node harness/gen-corpus.mjs "$WORK/corpus" rich >/dev/null
for OC in 0 0.24; do
  TAG=$(echo "$OC" | tr -d '.')
  node --experimental-strip-types hybrid/gen-hybrid-corpus.ts "$WORK/corpus" "$WORK/pool$TAG" "$OC" >/dev/null
  for i in $(seq 1 "$N"); do
    # Cool down before each timed run. Without this the "ambient" load a run
    # records is the PREVIOUS run's decaying load, so a clean machine reports
    # itself busy and every timing is taken on a warm one.
    for _ in $(seq 1 40); do
      L=$(cut -d' ' -f1 /proc/loadavg)
      awk -v l="$L" 'BEGIN{exit !(l<0.7)}' && break
      sleep 15
    done
    echo "== arm $OC run $i/$N (ambient load $(cut -d' ' -f1 /proc/loadavg)) =="
    node hybrid/bench-e2e.mjs "$WORK/pool$TAG" "$WORK/hits" harness/queries.tsv > "$OUT/e2e-$TAG-$i.json"
    node harness/score.mjs "$WORK/hits" "$WORK/pool$TAG" "oc$OC-run$i" 5 64 > "$OUT/score-$TAG-$i.json"
  done
done
echo "== $OUT =="
