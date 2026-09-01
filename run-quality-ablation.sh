#!/usr/bin/env bash
# Does corpus quality change what retrieval can do?
#
# Every arm this project has published so far varied something in the RETRIEVAL
# stack - expansion, reranking, filter order - against one fixed corpus. This
# varies the corpus and holds retrieval fixed, which is the axis that turned out
# to matter most and the one never measured.
#
# The control is not another world. It is the SAME world: the same 143 incidents
# across the same 8 services, the same memory ids, and the same queries, which
# were generated from the incidents and never from the memories and so are
# identical for both arms. The gold mapping is therefore identical too. The only
# difference is how much was written for each memory.
#
# The thin arm reproduces the distribution this project believed was real while
# it was publishing numbers: median 75 words against a measured 503. That is a
# LENGTH ablation and is named as one. It does not reproduce the original
# templated fixture, which differed in several ways at once; conflating the two
# would move more than one variable and attribute the result to whichever is
# easiest to describe.
#
# Measured limitation, stated because it bounds the result rather than
# invalidating it: the thin arm lands ABOVE its sampled targets. A 12-memory
# pilot targeting a median of 75 words produced 108, because the model has a
# floor of roughly 50 to 60 words for this prompt and the top-up loop only ever
# adds. Forcing it lower would mean changing the prompt, which is a second
# variable. So the arms differ by about 5x in length rather than 7x, and the
# effect this measures is a LOWER BOUND on the gap to the original fixture.
#
# Run after run-realistic.sh, on an idle machine.
set -uo pipefail
cd "$(dirname "$0")"
export VESTIGE_PLUGIN="${VESTIGE_PLUGIN:-$(cd .. && pwd)/vestige}"
R=runs/rich
A=runs/quality-ablation
mkdir -p "$A"
cool () { for _ in $(seq 1 40); do L=$(cut -d' ' -f1 /proc/loadavg); awk -v l="$L" 'BEGIN{exit !(l<0.7)}' && return 0; sleep 15; done; }

for f in "$R/world.json" "$R/q-symptom.tsv" "$R/corpus/_map.json"; do
  [ -e "$f" ] || { echo "missing $f - run run-realistic.sh first"; exit 1; }
done

# 1 - the thin arm, from the same world, differing only in target length
node harness/gen-rich-corpus.mjs "$R/world.json" "$A/corpus-thin" haiku \
  --reference reference/thin-fixture.json > "$A/corpus-thin-summary.json" 2>>"$A/corpus.err"
echo "STAGE thin corpus: $(ls "$A/corpus-thin"/*.md 2>/dev/null | wc -l) memories"

# 2 - profile both arms. The gate is NOT applied to the thin arm: it is supposed
#     to fail it. Failing it is the premise of the experiment, so record the
#     measurement rather than the verdict.
node harness/profile-corpus.mjs "$A/corpus-thin" --name "thin arm" > "$A/profile-thin.json"
node harness/profile-corpus.mjs "$R/corpus"      --name "realistic arm" > "$A/profile-rich.json"
echo "STAGE profiled both arms"

# 3 - write the thin corpus through the real plugin, same as the realistic one
node --experimental-strip-types hybrid/gen-hybrid-corpus.ts "$A/corpus-thin" "$A/pool-thin" 0 > "$A/write-thin.json" 2>>"$A/bench.err"
N=$(ls "$A/pool-thin"/*.md 2>/dev/null | wc -l)

# 4 - the same queries, the same registers, retrieval held fixed at the default arm
for REG in symptom identifier short; do
  cool
  echo "STAGE ablation register=$REG load=$(cut -d' ' -f1 /proc/loadavg)"
  unset VESTIGE_RERANK VESTIGE_QUERY_SHAPE
  node hybrid/bench-e2e.mjs "$A/pool-thin" "$A/hits-thin-$REG" "$R/q-$REG.tsv" > "$A/e2e-thin-$REG.json" 2>>"$A/bench.err"
  node harness/score.mjs "$A/hits-thin-$REG" "$A/pool-thin" "thin-$REG" 5 "$N" > "$A/score-thin-$REG.json" 2>>"$A/bench.err"
  node harness/analyse-stratum.mjs "$A/hits-thin-$REG" "$A/pool-thin" "$R/q-$REG.tsv" > "$A/analysis-thin-$REG.json" 2>>"$A/bench.err"
done
echo ABLATION-DONE
