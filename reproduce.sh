#!/usr/bin/env bash
# Regenerate every headline number in RESULTS.md from a clean state.
#
# This exists because the corpus these benchmarks ran against lived only in
# /tmp, and the invocation lived only in a terminal scrollback. Both were gone
# within a day. A benchmark nobody can re-run is a claim, not a measurement.
#
#   ./reproduce.sh [outdir]      default: runs/<date>
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-runs/$(date +%F)}"
PLUGIN="${VESTIGE_PLUGIN:-$(cd .. && pwd)/vestige}"
export VESTIGE_PLUGIN
[ -d "$PLUGIN" ] || { echo "no plugin checkout at $PLUGIN (set VESTIGE_PLUGIN)"; exit 1; }

# Latency is load-sensitive and this machine has lied about it before: the same
# push race read 21/845 under load and 330-371/845 idle. Refuse rather than
# publish a number the machine wrote.
LOAD=$(awk '{print int($1)}' /proc/loadavg 2>/dev/null || echo 0)
if [ "$LOAD" -ge 3 ] && [ "${FORCE_UNDER_LOAD:-0}" != "1" ]; then
  echo "load average ${LOAD} is too high for a latency number; FORCE_UNDER_LOAD=1 to override"; exit 1
fi

mkdir -p "$OUT"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

echo "== seeded corpus (deterministic) =="
node harness/gen-corpus.mjs "$WORK/corpus" rich > "$OUT/corpus.json"

for OC in 0 0.24; do
  TAG=$(echo "$OC" | tr -d '.')
  echo "== pool through the real write path, overclaim=$OC =="
  node --experimental-strip-types hybrid/gen-hybrid-corpus.ts "$WORK/corpus" "$WORK/pool$TAG" "$OC" > "$OUT/write-$TAG.json"
  echo "== end to end through the plugin's own API =="
  node hybrid/bench-e2e.mjs "$WORK/pool$TAG" "$WORK/hits$TAG" harness/queries.tsv > "$OUT/e2e-$TAG.json"
  node harness/score.mjs "$WORK/hits$TAG" "$WORK/pool$TAG" "vestige-overclaim-$OC" 5 64 > "$OUT/score-$TAG.json"
done

echo "== written to $OUT =="
grep -hE '"(target_at_rank1|target_found_in_topk|mrr|mean_foreign_in_topk)"' "$OUT"/score-*.json
