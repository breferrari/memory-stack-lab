#!/bin/bash
# runbench with extra qmd flags appended (e.g. --no-rerank).
IDX=$1; COLL=$2; OUT=$3; Q=$4; shift 4
mkdir -p "$OUT"; i=0
while IFS=$'\t' read -r proj topic doc <&3; do
  [ -n "$proj" ] || continue
  doc="${doc%$'\r'}"; i=$((i+1))
  printf '%s' "${doc//%%/$'\n'}" > "/tmp/qdocf.$$"
  ( cd "$IDX" && qmd query "$(cat "/tmp/qdocf.$$")" -n 5 "$@" </dev/null 2>/dev/null ) \
    | grep -oE "qmd://$COLL/[^ :,]+[.]md" > "$OUT/${proj}__${topic}.txt"
done 3< "$Q"
rm -f "/tmp/qdocf.$$"
echo "ran $i queries -> $OUT"
