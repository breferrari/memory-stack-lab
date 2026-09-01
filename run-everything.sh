#!/usr/bin/env bash
# Every variant, in one sequence, on a machine nobody else is using.
#
#   ./run-everything.sh 2>&1 | tee runs/overnight.log
#
# Written to be run unattended, so three properties matter more than speed:
#
#   RESUMABLE   every stage skips work already on disk. Killing this and
#               restarting it costs the current stage, not the night.
#   ISOLATED    a failing stage logs and the next one still runs. One broken
#               arm must not cost the other eight.
#   HONEST      every stage waits for the machine to cool first, and the
#               conditions land in the artifacts rather than in someone's
#               memory of the evening.
#
# Order is deliberate. The main pipeline first because everything else scores
# against its pool and its queries. The other stack next, on the SAME corpus,
# because publishing our harder number beside their easier one would be a
# comparison where only one side changed. Then the ablation, which is the only
# arm that can attribute a difference to corpus quality at all. Variance and the
# entity swap last: they answer "can this number be quoted" and "is the fixture
# telling the query its answer", and neither is worth machine time until the
# numbers they qualify exist.
set -uo pipefail
cd "$(dirname "$0")"
export VESTIGE_PLUGIN="${VESTIGE_PLUGIN:-$(cd .. && pwd)/vestige}"
mkdir -p runs
STARTED=$(date +%s)

stage () {
  local name="$1"; shift
  echo ""
  echo "======== $name  [$(date +%H:%M)]  load $(cut -d' ' -f1 /proc/loadavg) ========"
  if "$@"; then echo "-------- $name OK"; else echo "-------- $name FAILED (exit $?) — continuing"; fi
}

# Wait out anything still running from earlier, rather than competing with it.
for _ in $(seq 1 240); do
  if pgrep -f 'run-realistic\.sh' >/dev/null 2>&1; then sleep 30; else break; fi
done

stage "1/7 realistic corpus, 3 registers x 3 arms" ./run-realistic.sh
stage "2/7 the other stack, same corpus and queries" ./run-vs-mcs-realistic.sh
stage "3/7 corpus-quality ablation, queries held fixed" ./run-quality-ablation.sh
stage "4/7 variance, typed" ./run-variance.sh symptom typed
stage "5/7 variance, expand (the stochastic arm)" ./run-variance.sh symptom expand
stage "6/7 entity swap, symptom (informative) and identifier (control)" bash -c '
  node harness/bench-entity-swap.mjs runs/rich/world.json runs/rich/corpus runs/rich/q-symptom.tsv symptom runs/rich/swap-symptom.json &&
  node harness/bench-entity-swap.mjs runs/rich/world.json runs/rich/corpus runs/rich/q-identifier.tsv identifier runs/rich/swap-identifier.json'
stage "7/7 report" bash -c 'node harness/report-realistic.mjs runs/rich > runs/rich/REPORT.md && head -40 runs/rich/REPORT.md'

echo ""
echo "======== ALL VARIANTS DONE in $(( ($(date +%s) - STARTED) / 60 )) min ========"
ls runs/rich/*.json runs/vs-mcs-realistic/*.json runs/quality-ablation/*.json runs/variance/*.json 2>/dev/null | wc -l | xargs echo "artifacts:"
