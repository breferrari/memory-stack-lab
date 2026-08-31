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
cp "$UP/mcs-shared/hooks/memories_autopush.sh" "$HOOK"
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
echo "done -> $WORK"
