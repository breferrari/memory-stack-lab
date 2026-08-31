#!/bin/bash
# Does retry help, and under what contention?
#
# The accidental version of this experiment - run it whenever, quote the number -
# is what produced a 13x error. Contention is the independent variable here, so
# it is CONTROLLED and REPORTED rather than inherited from whatever else the
# machine happened to be doing.
#
# Synthetic load is bounded busy-loops, killed on any exit path.
set -u
LAB="$(cd "$(dirname "$0")/.." && pwd)"
PLAN="$LAB/harness/plan-x.json"
OUT="$LAB/runs/sweep"
LOADS="${LOADS:-0 16 32}"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; PIDS=(); }
trap cleanup EXIT INT TERM

mkdir -p "$OUT"
printf 'load\tvariant\tlanded\tstalled\tload_before\n' > "$OUT/results.tsv"

for n in $LOADS; do
  cleanup
  for _ in $(seq 1 "$n"); do ( while :; do :; done ) & PIDS+=($!); done
  [ "$n" -gt 0 ] && sleep 20   # let the load average actually rise
  # This sweep generates its load ON PURPOSE, so the runners' load guard has to
  # be told that rather than tripped by it. Set just above the level applied, so
  # the guard still catches load this sweep did not create — the case it is for.
  export MAX_LOAD="$(awk -v n="$n" 'BEGIN{print n + 4}')"
  for variant in baseline patched; do
    d="$OUT/l${n}-$variant"
    if [ "$variant" = patched ]; then
      PATCHED_HOOK="${PATCHED_HOOK:-/tmp/patched-hook.sh}" "$LAB/harness/matrix-run-patched.sh" "$PLAN" flat "$d" >"$d.log" 2>&1 || echo "    runner exited $? — see $d.log"
    else
      "$LAB/harness/matrix-run.sh" "$PLAN" flat "$d" >"$d.log" 2>&1 || echo "    runner exited $? — see $d.log"
    fi
    landed=$(tail -1 "$d/rounds.tsv" 2>/dev/null | cut -f3)
    stalled=$(tail -1 "$d/rounds.tsv" 2>/dev/null | cut -f4)
    lb=$(grep '^load_before' "$d/conditions.tsv" 2>/dev/null | cut -f2 | cut -d' ' -f1)
    printf '%s\t%s\t%s\t%s\t%s\n' "$n" "$variant" "$landed" "$stalled" "$lb" >> "$OUT/results.tsv"
    echo "  load $n / $variant: landed $landed, stalled $stalled (load was $lb)"
  done
done
cleanup
echo "SWEEP COMPLETE"
column -t "$OUT/results.tsv"
