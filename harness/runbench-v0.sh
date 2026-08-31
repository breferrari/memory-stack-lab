#!/bin/bash
# V0: MCS as shipped — docs-mcp-server + Ollama nomic-embed-text over the flat pool.
# Emits the SAME artifact as every other rung: one file per query,
# `<project>__<topic>.txt`, document ids one per line in rank order.
#
# Interface difference, declared not hidden: qmd takes a structured lex/vec
# document; docs-mcp-server takes one plain string. MODE selects which text V0
# receives — `vec` (the natural-language question, what an agent would actually
# ask) or `both` (lex keywords + question, the most information qmd also gets).
LAB=$1; OUT=$2; Q=$3; MODE=${4:-vec}
export OPENAI_API_KEY=ollama
export OPENAI_API_BASE=http://localhost:11434/v1
export DOCS_MCP_EMBEDDING_MODEL="openai:nomic-embed-text"
BIN="$LAB/tools/node_modules/.bin/docs-mcp-server"
mkdir -p "$OUT"; i=0
while IFS=$'\t' read -r proj topic doc <&3; do
  [ -n "$proj" ] || continue
  doc="${doc%$'\r'}"; i=$((i+1))
  lex=$(printf '%s' "$doc" | sed 's/%%.*//; s/^lex: //')
  vec=$(printf '%s' "$doc" | sed 's/.*%%//; s/^vec: //')
  case "$MODE" in
    vec)  qtext="$vec" ;;
    both) qtext="$lex $vec" ;;
  esac
  "$BIN" search pool "$qtext" --store-path "$LAB/runs/v0-store" \
      --telemetry false --output json </dev/null 2>/dev/null \
    | python3 -c "
import json,sys,os
try: d=json.load(sys.stdin)
except Exception: d=[]
for r in d[:5]:
    print(os.path.basename(r.get('url','')).removesuffix('.md'))
" > "$OUT/${proj}__${topic}.txt"
done 3< "$Q"
echo "V0 ran $i queries (mode=$MODE) -> $OUT"
