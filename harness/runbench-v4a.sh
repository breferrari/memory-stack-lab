#!/bin/bash
# V4a: query-time project filter implemented as a per-project index.
# Each query goes to the asking project's OWN index only.
LAB=$1; OUT=$2; Q=$3
mkdir -p "$OUT"; i=0
while IFS=$'\t' read -r proj topic doc <&3; do
  [ -n "$proj" ] || continue
  doc="${doc%$'\r'}"; i=$((i+1))
  printf '%s' "${doc//%%/$'\n'}" > "/tmp/qdoc4a.$$"
  ( cd "$LAB/runs/scale/perproj-idx/$proj" && qmd query "$(cat "/tmp/qdoc4a.$$")" --limit 5 </dev/null 2>/dev/null ) \
    | grep -oE "qmd://$proj/[^ :]+[.]md" > "$OUT/${proj}__${topic}.txt"
done 3< "$Q"
rm -f "/tmp/qdoc4a.$$"
echo "ran $i queries -> $OUT"
