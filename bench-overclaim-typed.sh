#!/usr/bin/env bash
# The over-claim arm under the typed query shape. The rest of the document is
# measured on the new default; leaving one row on the old one would compare two
# different systems in the same table.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${1:?out}"; mkdir -p "$OUT"
export VESTIGE_PLUGIN="${VESTIGE_PLUGIN:-$(cd .. && pwd)/vestige}"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
cool () { for _ in $(seq 1 40); do L=$(cut -d' ' -f1 /proc/loadavg); awk -v l="$L" 'BEGIN{exit !(l<0.7)}' && return 0; sleep 15; done; }
node harness/gen-corpus.mjs "$WORK/corpus" rich >/dev/null 2>&1
node --experimental-strip-types hybrid/gen-hybrid-corpus.ts "$WORK/corpus" "$WORK/pool" 0.24 >/dev/null 2>&1
for i in 1 2 3; do
  cool; echo "[$(date +%H:%M:%S)] overclaim typed run=$i/3 load=$(cut -d' ' -f1 /proc/loadavg)"
  node hybrid/bench-e2e.mjs "$WORK/pool" "$WORK/hits" harness/queries.tsv > "$OUT/e2e-oc-typed-$i.json" 2>"$OUT/e2e-oc-typed-$i.err"
  node harness/score.mjs "$WORK/hits" "$WORK/pool" "oc-typed" 5 64 > "$OUT/score-oc-typed-$i.json" 2>>"$OUT/e2e-oc-typed-$i.err"
done
date +%s > "$OUT/.DONE-OC"
echo "OVERCLAIM TYPED DONE"
