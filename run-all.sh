#!/usr/bin/env bash
# Every remaining bench, serially, on an idle machine. Serial is not a style
# choice: two timing benches at once measure each other.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${1:-runs/full-$(date +%F)}"
export VESTIGE_PLUGIN="${VESTIGE_PLUGIN:-$(cd .. && pwd)/vestige}"
mkdir -p "$OUT"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

cool () { for _ in $(seq 1 40); do L=$(cut -d' ' -f1 /proc/loadavg); awk -v l="$L" 'BEGIN{exit !(l<0.7)}' && return; sleep 15; done; }
step () { echo "== $1 =="; cool; }

node harness/gen-corpus.mjs "$WORK/corpus" rich > "$OUT/corpus.json" 2>&1
node --experimental-strip-types hybrid/gen-hybrid-corpus.ts "$WORK/corpus" "$WORK/pool" 0 > "$OUT/write.json" 2>&1

step "reranker on vs off"
node hybrid/bench-rerank.mjs "$WORK/corpus" harness/queries.tsv > "$OUT/rerank.json" 2>"$OUT/rerank.err"

step "MCS qmd branch, both arms"
node hybrid/bench-vs-mcs.mjs "$WORK/pool" harness/queries.tsv "$WORK/vs" > "$OUT/vs-mcs.json" 2>"$OUT/vs-mcs.err"

step "scale: 40 projects"
node hybrid/bench-scale.mjs 40 20 > "$OUT/scale-40.json" 2>"$OUT/scale-40.err"

step "scale: 180 projects (never completed before)"
node hybrid/bench-scale.mjs 180 20 > "$OUT/scale-180.json" 2>"$OUT/scale-180.err"

step "push race: single attempt vs bounded retry"
for n in 5 10 20; do
  node harness/push-race.mjs "$n" single  > "$OUT/race-$n-single.json" 2>/dev/null
  cool
  node harness/push-race.mjs "$n" retry 5 > "$OUT/race-$n-retry.json"  2>/dev/null
  cool
done

date +%s > "$OUT/.DONE"
echo "== ALL DONE -> $OUT =="
