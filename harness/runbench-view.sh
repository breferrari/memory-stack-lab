#!/bin/bash
# query each caller's own view index
LAB=$1; VIEWIDX=$2; OUT=$3; Q=$4
mkdir -p "$OUT"
while IFS=$'\t' read -r proj topic doc <&3; do
  [ -n "$proj" ] || continue
  doc="${doc%$'\r'}"
  printf '%s' "${doc//%%/$'\n'}" > "/tmp/qv.$$"
  ( cd "$LAB/runs/scale/$VIEWIDX/$proj" && qmd query "$(cat "/tmp/qv.$$")" -n 5 -C 200 --format files </dev/null 2>/dev/null ) \
    | grep -oE "qmd://$proj/[^ :,]+[.]md" > "$OUT/${proj}__${topic}.txt"
done 3< "$Q"
rm -f "/tmp/qv.$$"
