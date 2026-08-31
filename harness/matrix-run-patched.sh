#!/bin/bash
# Org-matrix simulation against the REAL memories_autopush.sh.
#
#   ./matrix-run.sh <plan.json> <mode: flat|ns> <workdir>
#
# Each round: every engineer with a planned write for that round writes it,
# then ALL of them fire their Stop hook in parallel (a turn boundary), then
# everyone pulls (a session start). Per-round metrics land in rounds.tsv as
#   round <TAB> files-written <TAB> files-on-remote <TAB> stalled-engineers
#
# Windows note: jq and python both write CRLF to stdout here. A stray CR makes
# every derived path invalid *silently* - mkdir happily creates "eng001<CR>",
# and every later write into "eng001/..." then fails with no useful error.
# Everything read from a tool's stdout is passed through `tr -d '\015'`.
set -u
PLAN=$1; MODE=$2; WORK=$3
LAB="$(cd "$(dirname "$0")/.." && pwd)"
UP="$LAB/upstream"


# ── Load guard ────────────────────────────────────────────────────────────
# This experiment measures how simultaneous the scheduler let N processes be,
# so a run on a busy machine measures the machine. Three runs in one session
# were contaminated by the operator's own work despite the operator knowing
# this, which is why the check is here and not in a comment.
#
# MAX_LOAD is a 1-minute load average. Override deliberately with MAX_LOAD=,
# never by ignoring the warning.
_maxload="${MAX_LOAD:-2.0}"
_l1=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)
if awk -v a="$_l1" -v b="$_maxload" 'BEGIN{exit !(a>b)}'; then
  echo "REFUSING: load average is $_l1, above MAX_LOAD=$_maxload." >&2
  echo "  A contention result taken now measures this machine, not the system under test." >&2
  echo "  Wait for the machine to settle, or set MAX_LOAD explicitly to accept a contaminated run." >&2
  exit 3
fi

rm -rf "$WORK"; mkdir -p "$WORK/shim"
printf '#!/bin/bash\necho "${FAKE_HOST:-dev}"\n' > "$WORK/shim/hostname"
chmod +x "$WORK/shim/hostname"
# PATH entries must be POSIX-style; Git Bash cannot resolve a "C:/..." PATH
# element, so the hostname shim would silently never be found.
SHIM="$WORK/shim"
command -v cygpath >/dev/null 2>&1 && SHIM="$(cygpath -u "$WORK/shim")"
export PATH="$SHIM:$PATH"

# The hook under test. For `ns` mode the guardrail regex must admit a project
# prefix - that is the entire difference between the two runs.
HOOK="$WORK/hook.sh"
cp "${PATCHED_HOOK:-$UP/mcs-shared/hooks/memories_autopush.sh}" "$HOOK"
if [ "$MODE" = ns ]; then
  python - "$HOOK" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8', newline='').read()
old = "allowed_pattern='^memories/(learning|decision)_[a-zA-Z0-9_-]+\\.md$'"
new = "allowed_pattern='^memories/[a-zA-Z0-9-]+__(learning|decision)_[a-zA-Z0-9_-]+\\.md$'"
assert old in s, "guardrail line not found - upstream hook changed"
io.open(p, 'w', encoding='utf-8', newline='').write(s.replace(old, new))
PY
  grep -q '__(learning' "$HOOK" || { echo "FATAL: ns guardrail patch did not apply"; exit 1; }
fi

git init -q --bare "$WORK/team.git"
git -C "$WORK/team.git" symbolic-ref HEAD refs/heads/main
git clone -q "$WORK/team.git" "$WORK/seed" 2>/dev/null
mkdir -p "$WORK/seed/memories"; echo seed > "$WORK/seed/memories/learning_seed_base.md"
git -C "$WORK/seed" config user.name s
git -C "$WORK/seed" config user.email s@s
git -C "$WORK/seed" add -A >/dev/null 2>&1
git -C "$WORK/seed" commit -qm seed >/dev/null
git -C "$WORK/seed" push -q -u origin HEAD:refs/heads/main

mapfile -t ENGS < <(jq -r '.engineers[].id' "$PLAN" | tr -d '\015')
ROUNDS=$(jq -r '.rounds' "$PLAN" | tr -d '\015')

for e in "${ENGS[@]}"; do
  d="$WORK/$e"
  mkdir -p "$d/.claude/hooks/shared-memories"
  cp "$HOOK" "$d/.claude/hooks/shared-memories/memories_autopush.sh"
  git clone -q "$WORK/team.git" "$d/.claude/.memories-repo" 2>/dev/null
  git -C "$d/.claude/.memories-repo" config user.name "$e"
  git -C "$d/.claude/.memories-repo" config user.email "$e@corp"
done
echo "provisioned ${#ENGS[@]} engineers, mode=$MODE, rounds=$ROUNDS"

: > "$WORK/rounds.tsv"
# Record load with every run. This experiment measures how SIMULTANEOUS the
# scheduler let 100 processes be, so a result without its load average is not a
# result — the identical baseline swings 13x between a busy and an idle box.
# VESTIGE_LOADSTAMP marks that this runner records it.
_load_before=$(awk '{print $1" "$2" "$3}' /proc/loadavg 2>/dev/null || echo "unknown")
echo "load_before	$_load_before" > "$WORK/conditions.tsv"
echo "nproc	$(nproc 2>/dev/null || echo unknown)" >> "$WORK/conditions.tsv"
for r in $(seq 1 "$ROUNDS"); do
  jq -r --argjson r "$r" --arg m "$MODE" \
    '.plan[] | select(.round == $r) | [.eng, .[$m], (.body | gsub("\n"; "%%"))] | @tsv' \
    "$PLAN" | tr -d '\015' > "$WORK/round.$r.tsv"

  written=0
  while IFS=$'\t' read -r eng fn body <&3; do
    [ -n "$eng" ] || continue
    dir="$WORK/$eng/.claude/.memories-repo/memories"
    if [ ! -d "$dir" ]; then echo "MISSING checkout for [$eng]"; continue; fi
    printf '%s' "${body//%%/$'\n'}" > "$dir/$fn"
    written=$((written+1))
  done 3< "$WORK/round.$r.tsv"

  # turn boundary: every engineer's Stop hook fires at once
  for e in "${ENGS[@]}"; do
    ( cd "$WORK/$e" && FAKE_HOST="$e" \
        ./.claude/hooks/shared-memories/memories_autopush.sh <<< '{"hook_event_name":"Stop"}' \
        >> "$WORK/$e.log" 2>&1 ) &
  done
  wait

  # session start: everyone pulls
  for e in "${ENGS[@]}"; do
    ( git -C "$WORK/$e/.claude/.memories-repo" pull --rebase --autostash -q >/dev/null 2>&1 ) &
  done
  wait

  landed=$(git -C "$WORK/team.git" ls-tree -r --name-only main -- memories/ 2>/dev/null | wc -l)
  stalled=0
  for e in "${ENGS[@]}"; do
    up=$(git -C "$WORK/$e/.claude/.memories-repo" rev-list '@{u}..HEAD' --count 2>/dev/null || echo 0)
    if [ "${up:-0}" -gt 0 ]; then stalled=$((stalled+1)); fi
  done
  printf '%d\t%d\t%d\t%d\n' "$r" "$written" "$landed" "$stalled" >> "$WORK/rounds.tsv"
  printf '  round %2d/%s  wrote: %-4s on remote: %-5s stalled: %s\n' \
    "$r" "$ROUNDS" "$written" "$landed" "$stalled"
done
_load_after=$(awk '{print $1" "$2" "$3}' /proc/loadavg 2>/dev/null || echo "unknown")
echo "load_after	$_load_after" >> "$WORK/conditions.tsv"
echo "  conditions: load before [$_load_before] after [$_load_after] on $(nproc 2>/dev/null) cpus"
echo "  NOTE: contention results are only comparable at comparable load."

# Disqualify a run that got busy mid-flight. The end load matters as much as
# the start: a quiet machine that filled up halfway produces a number that
# looks clean and is not.
_lend=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)
if awk -v a="$_lend" -v b="$_maxload" 'BEGIN{exit !(a>b*4)}'; then
  echo "  WARNING: load rose to $_lend during this run (started $_l1)." >&2
  echo "  DISQUALIFIED: treat these numbers as contaminated." >&2
  echo "disqualified\tload rose from $_l1 to $_lend" >> "$WORK/conditions.tsv"
fi
echo "done -> $WORK"
