#!/bin/bash
# Scope-aware V4 filter: each query goes to the asking project's view index,
# which contains its own memories PLUS every memory declaring scope: general.
LAB=$1; VIEW=$2; OUT=$3; Q=$4
mkdir -p "$OUT"; i=0
while IFS=$'\t' read -r proj topic doc <&3; do
  [ -n "$proj" ] || continue
  doc="${doc%$'\r'}"; i=$((i+1))
  printf '%s' "${doc//%%/$'\n'}" > "/tmp/qdocsv.$$"
  ( cd "$LAB/runs/scale/$VIEW-idx/$proj" && qmd query "$(cat "/tmp/qdocsv.$$")" -n 5 -C 200 --format files </dev/null 2>/dev/null ) \
    | grep -oE "qmd://$proj/[^ :,]+[.]md" > "$OUT/${proj}__${topic}.txt"
done 3< "$Q"
rm -f "/tmp/qdocsv.$$"
echo "done $VIEW ($i queries)"
