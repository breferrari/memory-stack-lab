#!/bin/bash
# V4b: post-filter over the ONE shared index.
# NOTE: qmd 2.8.3 returns at most 20 results in every mode tested
# (-n N, --format files|json, --all --min-score 0). DEPTH above 20 is
# therefore unreachable, and that ceiling is the finding, not a workaround:
# a post-filter can only ever see the engine's global top-20.
# Use -n (NOT --limit: --limit is silently accepted and ignored).
LAB=$1; OUT=$2; Q=$3; DEPTH=$4
mkdir -p "$OUT"; i=0
while IFS=$'\t' read -r proj topic doc <&3; do
  [ -n "$proj" ] || continue
  doc="${doc%$'\r'}"; i=$((i+1))
  printf '%s' "${doc//%%/$'\n'}" > "/tmp/qdoc4b.$$"
  ( cd "$LAB/runs/scale/ns-idx" && qmd query "$(cat "/tmp/qdoc4b.$$")" -n "$DEPTH" -C 200 --format files </dev/null 2>/dev/null ) \
    | grep -oE "qmd://ns/[^ :,]+[.]md" \
    | grep -E "qmd://ns/${proj}__" | head -5 > "$OUT/${proj}__${topic}.txt"
done 3< "$Q"
rm -f "/tmp/qdoc4b.$$"
echo "done depth=$DEPTH"
