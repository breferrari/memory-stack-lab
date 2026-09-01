#!/usr/bin/env bash
# The realistic-corpus pipeline, end to end.
#
# Stages gate each other: nothing is benchmarked on a corpus that has not passed
# the realism check, because the entire reason for this run is that every number
# published so far came from a fixture too thin to tell its own documents apart.
set -uo pipefail
cd "$(dirname "$0")"
export VESTIGE_PLUGIN="${VESTIGE_PLUGIN:-$(cd .. && pwd)/vestige}"
R=runs/rich
cool () { for _ in $(seq 1 40); do L=$(cut -d' ' -f1 /proc/loadavg); awk -v l="$L" 'BEGIN{exit !(l<0.7)}' && return 0; sleep 15; done; }

# 0 — the corpus-to-score contract. Cheap, no search engine, and it covers the
#     three format assumptions that once turned a changed generator into an empty
#     pool, a corpus of topic "unknown", and gold resolved to the wrong document,
#     all of which produced numbers rather than errors.
if ! node harness/test-chain.mjs; then
  echo "STAGE chain contract FAILED — not generating a corpus the scorers cannot read"; exit 1
fi
echo "STAGE chain contract holds"

# 1 — corpus (resumable: existing files are kept)
node harness/gen-rich-corpus.mjs "$R/world.json" "$R/corpus" haiku > "$R/corpus-summary.json" 2>>"$R/corpus.err"
echo "STAGE corpus done: $(ls "$R/corpus"/*.md 2>/dev/null | wc -l) memories"

# 2 — the gate. A thin corpus stops the run rather than producing a number.
if ! node harness/verify-corpus.mjs "$R/corpus" --world "$R/world.json" > "$R/realism.json"; then
  echo "STAGE gate FAILED — corpus too thin, not benchmarking"; cat "$R/realism.json"; exit 1
fi
echo "STAGE gate passed"

# 3 — queries, written from incidents and never from the memories
node harness/gen-world-queries.mjs "$R/world.json" "$R/q" haiku > "$R/queries-summary.json" 2>>"$R/queries.err"
echo "STAGE queries done"

# 4 — write the corpus through the real plugin, then benchmark every register
node --experimental-strip-types hybrid/gen-hybrid-corpus.ts "$R/corpus" "$R/pool" 0 > "$R/write.json" 2>>"$R/bench.err"
POOL_N=$(ls "$R/pool"/*.md 2>/dev/null | wc -l)
echo "STAGE pool: $POOL_N memories"
for REG in symptom identifier short; do
  for ARM in typed expand rerank; do
    cool
    echo "STAGE bench register=$REG arm=$ARM load=$(cut -d' ' -f1 /proc/loadavg)"
    if [ "$ARM" = "rerank" ]; then export VESTIGE_RERANK=1; else unset VESTIGE_RERANK; fi
    if [ "$ARM" = "expand" ]; then export VESTIGE_QUERY_SHAPE=expand; else unset VESTIGE_QUERY_SHAPE; fi
    node hybrid/bench-e2e.mjs "$R/pool" "$R/hits-$REG-$ARM" "$R/q-$REG.tsv" > "$R/e2e-$REG-$ARM.json" 2>>"$R/bench.err"
    node harness/score.mjs "$R/hits-$REG-$ARM" "$R/pool" "$REG-$ARM" 5 "$(grep -c . "$R/q-$REG.tsv")" > "$R/score-$REG-$ARM.json" 2>>"$R/bench.err"
    node harness/analyse-stratum.mjs "$R/hits-$REG-$ARM" "$R/pool" "$R/q-$REG.tsv" --world "$R/world.json" > "$R/analysis-$REG-$ARM.json" 2>>"$R/bench.err"
  done
done
# 5 — can it decline? Every other query in this suite has an answer in the store,
#     so nothing here could ever be punished for answering when it should not.
echo "STAGE abstention"
node harness/bench-abstention.mjs "$R/pool" "$R/abstention.json" >/dev/null 2>>"$R/bench.err"

echo REALISTIC-DONE
