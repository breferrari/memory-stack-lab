#!/bin/bash
# ./runbench.sh <index-dir> <collection> <out-dir> <queries.tsv>
# queries.tsv: project<TAB>topic<TAB>lex: ...%%vec: ...
# %% is the line separator: qmd's structured-query parser rejects a query
# line containing a newline, and the fixture must stay one record per line.
IDX=$1; COLL=$2; OUT=$3; Q=$4
mkdir -p "$OUT"; i=0
while IFS=$'\t' read -r proj topic doc <&3; do
  [ -n "$proj" ] || continue
  doc="${doc%$'\r'}"
  i=$((i+1))
  printf '%s' "${doc//%%/$'\n'}" > "/tmp/qdoc.$$"
  ( cd "$IDX" && qmd query "$(cat "/tmp/qdoc.$$")" --limit 5 </dev/null 2>/dev/null ) | grep -oE "qmd://$COLL/[^ :]+[.]md" > "$OUT/${proj}__${topic}.txt"
done 3< "$Q"
rm -f "/tmp/qdoc.$$"
echo "ran $i queries -> $OUT ($(find "$OUT" -size +0 | wc -l) non-empty)"
