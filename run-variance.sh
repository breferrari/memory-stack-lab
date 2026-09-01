#!/usr/bin/env bash
# Three repeats of one arm, to put a spread on the headline.
#
# run-realistic.sh runs each register/arm once, which is enough to compare arms
# and not enough to quote a number. The distinction has mattered here before:
# query expansion scored rank-1 0.979 with sd 0.018 while typed sub-queries
# scored 1.000 with sd 0.000, and the second figure is the reason to prefer it.
# A single run cannot tell those apart.
#
# Runs after the main pipeline, on a quiet machine, on the default arm only.
set -uo pipefail
cd "$(dirname "$0")"
export VESTIGE_PLUGIN="${VESTIGE_PLUGIN:-$(cd .. && pwd)/vestige}"
R=runs/rich
V=runs/variance
mkdir -p "$V"
cool () { for _ in $(seq 1 40); do L=$(cut -d' ' -f1 /proc/loadavg); awk -v l="$L" 'BEGIN{exit !(l<0.7)}' && return 0; sleep 15; done; }

REG="${1:-symptom}"
for RUN in 1 2 3; do
  cool
  echo "STAGE variance register=$REG run=$RUN/3 load=$(cut -d' ' -f1 /proc/loadavg)"
  unset VESTIGE_RERANK VESTIGE_QUERY_SHAPE
  node hybrid/bench-e2e.mjs "$R/pool" "$V/hits-$REG-$RUN" "$R/q-$REG.tsv" > "$V/e2e-$REG-$RUN.json" 2>>"$V/err"
  node harness/analyse-stratum.mjs "$V/hits-$REG-$RUN" "$R/pool" "$R/q-$REG.tsv" --world "$R/world.json" > "$V/analysis-$REG-$RUN.json" 2>>"$V/err"
done

node -e '
const { readFileSync } = require("node:fs");
const reg = process.argv[1], v = process.argv[2];
const runs = [1,2,3].map((i) => JSON.parse(readFileSync(`${v}/analysis-${reg}-${i}.json`, "utf8")));
const stat = (k) => {
  const xs = runs.map((r) => r[k]).filter((x) => typeof x === "number");
  const m = xs.reduce((a,b)=>a+b,0)/xs.length;
  const sd = Math.sqrt(xs.reduce((a,b)=>a+(b-m)**2,0)/xs.length);
  return { runs: xs, mean: +m.toFixed(4), sd: +sd.toFixed(4) };
};
console.log(JSON.stringify({ register: reg, rank1: stat("rank1"), found_at_5: stat("found_at_5"), mrr: stat("mrr"),
  reading: "sd 0 means the arm is deterministic and the single-run number can be quoted as-is. Anything else has to be quoted with its spread." }, null, 1));
' "$REG" "$V" | tee "$V/summary-$REG.json"
echo VARIANCE-DONE
