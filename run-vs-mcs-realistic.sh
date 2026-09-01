#!/usr/bin/env bash
# The other stack, on the SAME corpus and the SAME queries.
#
# The published comparison — 0.984 for the qmd branch against 0.979 here — was
# measured on the thin fixture. Replacing our figure with the realistic one and
# leaving theirs untouched would be a comparison where only one side got harder.
# That is not modesty, it is the same broken-comparison error aimed at
# ourselves, and it would be indefensible if anyone checked.
#
# So: same pool, same three registers, same scorer, both arms of their design.
set -uo pipefail
cd "$(dirname "$0")"
export VESTIGE_PLUGIN="${VESTIGE_PLUGIN:-$(cd .. && pwd)/vestige}"
R=runs/rich
M=runs/vs-mcs-realistic
mkdir -p "$M"
cool () { for _ in $(seq 1 40); do L=$(cut -d' ' -f1 /proc/loadavg); awk -v l="$L" 'BEGIN{exit !(l<0.7)}' && return 0; sleep 15; done; }

for f in "$R/pool/_map.json" "$R/q-symptom.tsv"; do
  [ -e "$f" ] || { echo "missing $f — run run-realistic.sh first"; exit 1; }
done

# The shipped stack first, since it builds a store the later registers reuse.
# Ollama has to be serving nomic-embed-text for this arm; if it is not, the arm
# logs and the qmd arms still run.
for REG in symptom identifier short; do
  cool
  echo "STAGE mcs-shipped register=$REG load=$(cut -d' ' -f1 /proc/loadavg)"
  if node harness/bench-mcs-shipped.mjs "$R/pool" "$R/q-$REG.tsv" "$REG" "$M/$REG/mcs-shipped" > "$M/mcs-shipped-$REG.json" 2>>"$M/err"; then
    node harness/score.mjs "$M/$REG/mcs-shipped" "$R/pool" "mcs-shipped-$REG" 5 "$(grep -c . "$R/q-$REG.tsv")" > "$M/score-mcs-shipped-$REG.json" 2>>"$M/err"
    node harness/analyse-stratum.mjs "$M/$REG/mcs-shipped" "$R/pool" "$R/q-$REG.tsv" --world "$R/world.json" > "$M/analysis-mcs-shipped-$REG.json" 2>>"$M/err"
  else
    echo "  mcs-shipped $REG FAILED (is ollama serving nomic-embed-text?) — continuing"
  fi
done

for REG in symptom identifier short; do
  cool
  echo "STAGE vs-mcs register=$REG load=$(cut -d' ' -f1 /proc/loadavg)"
  node hybrid/bench-vs-mcs.mjs "$R/pool" "$R/q-$REG.tsv" "$M/$REG" > "$M/vs-mcs-$REG.json" 2>>"$M/err"
  for ARM in mcs-perproject mcs-shared; do
    [ -d "$M/$REG/$ARM" ] || continue
    node harness/score.mjs "$M/$REG/$ARM" "$R/pool" "$ARM-$REG" 5 "$(grep -c . "$R/q-$REG.tsv")" > "$M/score-$ARM-$REG.json" 2>>"$M/err"
    node harness/analyse-stratum.mjs "$M/$REG/$ARM" "$R/pool" "$R/q-$REG.tsv" --world "$R/world.json" > "$M/analysis-$ARM-$REG.json" 2>>"$M/err"
  done
done
echo VS-MCS-DONE
