#!/bin/bash
# W1: write-time content sanitization for shared memories. FAILS CLOSED.
#
# The shipped hook guards the FILENAME (allowed_pattern) and never inspects
# content. This scans the body before staging and blocks the push if the memory
# carries anything that should not leave the machine.
#
# Fails closed by construction: any internal error, unreadable file, or unknown
# state exits 1 (blocked). A sanitizer that fails open is decoration — the one
# time it breaks is the one time it mattered.
set -uo pipefail
trap 'echo "sanitize: internal error at line $LINENO — BLOCKING (fail closed)" >&2; exit 1' ERR

f=${1:-}
[ -n "$f" ] || { echo "sanitize: no file given — BLOCKING" >&2; exit 1; }
[ -r "$f" ] || { echo "sanitize: cannot read '$f' — BLOCKING" >&2; exit 1; }

findings=0
report() { echo "  [$1] $2"; findings=$((findings+1)); }

scan() { # <label> <extended-regex>
  local hits
  hits=$(grep -nEo "$2" "$f" 2>/dev/null | head -3 || true)
  [ -n "$hits" ] && while IFS= read -r h; do report "$1" "$h"; done <<< "$hits"
  return 0
}

# The shapes that actually leaked in the recorded incident.
scan UUID          '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
scan HOME-PATH     '(/home/[a-zA-Z0-9._-]+|/Users/[a-zA-Z0-9._-]+|[A-Z]:\\Users\\[a-zA-Z0-9._-]+)'
scan EMAIL         '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
scan TICKET        '\b[A-Z]{2,10}-[0-9]{1,6}\b'
scan CREDENTIAL    '(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer [A-Za-z0-9._-]{20,})'
scan PRIVATE-KEY   '-----BEGIN [A-Z ]*PRIVATE KEY-----'
scan INTERNAL-HOST '\b[a-zA-Z0-9-]+\.(internal|corp|intranet|local)\b'
scan PRIVATE-IP    '\b(10\.[0-9]{1,3}|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3}\b'
# long high-entropy run: >=32 chars of base64/hex alphabet with no spaces
scan HIGH-ENTROPY  '\b[A-Za-z0-9+/_-]{32,}={0,2}\b'

if [ "$findings" -gt 0 ]; then
  echo "sanitize: BLOCKED '$f' — $findings finding(s) above must not leave this machine" >&2
  exit 1
fi
exit 0
