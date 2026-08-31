#!/bin/bash
# W2: the org matrix against the hook patched with BOUNDED RETRY + JITTER
# around `pull --rebase; push`.
#
#   ./matrix-run-w2.sh <plan.json> <mode: flat|ns> <workdir> [attempts]
#
# Identical to matrix-run.sh in every other respect — same plan, same
# engineers, same rounds — so the delta is attributable to the retry alone.
# The shipped hook does ONE pull and ONE push and then says "will retry on next
# Stop"; under simultaneous writers almost every push loses the race.
set -u
PLAN=$1; MODE=$2; WORK=$3; ATTEMPTS=${4:-5}
LAB="$(cd "$(dirname "$0")/.." && pwd)"
UP="$LAB/upstream"

rm -rf "$WORK"; mkdir -p "$WORK/shim"
printf '#!/bin/bash\necho "${FAKE_HOST:-dev}"\n' > "$WORK/shim/hostname"
chmod +x "$WORK/shim/hostname"
export PATH="$WORK/shim:$PATH"

HOOK="$WORK/hook.sh"
cp "$UP/mcs-shared/hooks/memories_autopush.sh" "$HOOK"
if [ "$MODE" = ns ]; then
  python3 - "$HOOK" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8', newline='').read()
old = "allowed_pattern='^memories/(learning|decision)_[a-zA-Z0-9_-]+\\.md$'"
new = "allowed_pattern='^memories/[a-zA-Z0-9-]+__(learning|decision)_[a-zA-Z0-9_-]+\\.md$'"
assert old in s, "guardrail line not found - upstream hook changed"
io.open(p, 'w', encoding='utf-8', newline='').write(s.replace(old, new))
PY
fi

if [ "${HYBRID:-0}" = 1 ]; then
  python3 /tmp/apply_w1_gate.py "$HOOK" "$LAB/plugin/vestige/hooks/scan-batch.mjs"
  grep -q 'W1: content gate' "$HOOK" || { echo "FATAL: W1 gate did not apply"; exit 1; }
fi

# --- the W2 patch: replace the single-shot tail with a bounded retry loop ---
python3 - "$HOOK" "$ATTEMPTS" <<'PY'
import io, sys, re
p, attempts = sys.argv[1], int(sys.argv[2])
s = io.open(p, encoding='utf-8', newline='').read()
marker = 'if ! pull_err=$(LC_ALL=C git -C "$memories_dir" pull --rebase --autostash --quiet 2>&1); then'
i = s.index(marker)
retry = '''attempt=0
while [ "$attempt" -lt %d ]; do
  attempt=$((attempt+1))
  if ! pull_err=$(LC_ALL=C git -C "$memories_dir" pull --rebase --autostash --quiet 2>&1); then
    if printf '%%s' "$pull_err" | grep -qi 'conflict'; then
      git -C "$memories_dir" rebase --abort >/dev/null 2>&1
      echo "Shared memories: auto-push paused - rebase conflict. Resolve manually."
      exit 0
    fi
  else
    if push_err=$(git -C "$memories_dir" push --quiet 2>&1); then
      exit 0
    fi
  fi
  # full jitter: sleep in [0, base*2^attempt), base 50ms, capped at 2s
  cap=$(( 50 * (1 << attempt) )); [ "$cap" -gt 2000 ] && cap=2000
  sleep "$(awk -v c="$cap" 'BEGIN{srand();printf "%%.3f", (rand()*c)/1000}')"
done
echo "Shared memories: auto-push failed after %d attempts. Will retry on next Stop."
exit 0
''' % (attempts, attempts)
io.open(p, 'w', encoding='utf-8', newline='').write(s[:i] + retry)
print(f"W2 patch applied: {attempts} attempts, full jitter", file=sys.stderr)
PY
grep -q 'while \[ "$attempt"' "$HOOK" || { echo "FATAL: W2 patch did not apply"; exit 1; }

git init -q --bare "$WORK/team.git"
git -C "$WORK/team.git" symbolic-ref HEAD refs/heads/main
git clone -q "$WORK/team.git" "$WORK/seed" 2>/dev/null
mkdir -p "$WORK/seed/memories"; echo seed > "$WORK/seed/memories/learning_seed_base.md"
git -C "$WORK/seed" config user.name s; git -C "$WORK/seed" config user.email s@s
git -C "$WORK/seed" add -A >/dev/null 2>&1; git -C "$WORK/seed" commit -qm seed >/dev/null
git -C "$WORK/seed" push -q -u origin HEAD:refs/heads/main

mapfile -t ENGS < <(jq -r '.engineers[].id' "$PLAN" | tr -d '\015')
ROUNDS=$(jq -r '.rounds' "$PLAN" | tr -d '\015')
for e in "${ENGS[@]}"; do
  d="$WORK/$e"; mkdir -p "$d/.claude/hooks/shared-memories"
  cp "$HOOK" "$d/.claude/hooks/shared-memories/memories_autopush.sh"
  git clone -q "$WORK/team.git" "$d/.claude/.memories-repo" 2>/dev/null
  git -C "$d/.claude/.memories-repo" config user.name "$e"
  git -C "$d/.claude/.memories-repo" config user.email "$e@corp"
done
echo "provisioned ${#ENGS[@]} engineers, mode=$MODE, rounds=$ROUNDS, retry=$ATTEMPTS"

: > "$WORK/rounds.tsv"
for r in $(seq 1 "$ROUNDS"); do
  jq -r --argjson r "$r" --arg m "$MODE" \
    '.plan[] | select(.round == $r) | [.eng, .[$m], (.body | gsub("\n"; "%%"))] | @tsv' \
    "$PLAN" | tr -d '\015' > "$WORK/round.$r.tsv"
  written=0
  while IFS=$'\t' read -r eng fn body <&3; do
    [ -n "$eng" ] || continue
    dir="$WORK/$eng/.claude/.memories-repo/memories"
    [ -d "$dir" ] || continue
    printf '%s' "${body//%%/$'\n'}" > "$dir/$fn"; written=$((written+1))
  done 3< "$WORK/round.$r.tsv"
  for e in "${ENGS[@]}"; do
    ( cd "$WORK/$e" && FAKE_HOST="$e" \
        ./.claude/hooks/shared-memories/memories_autopush.sh <<< '{"hook_event_name":"Stop"}' \
        >> "$WORK/$e.log" 2>&1 ) &
  done
  wait
  for e in "${ENGS[@]}"; do
    ( git -C "$WORK/$e/.claude/.memories-repo" pull --rebase --autostash -q >/dev/null 2>&1 ) &
  done
  wait
  landed=$(git -C "$WORK/team.git" ls-tree -r --name-only main -- memories/ 2>/dev/null | wc -l)
  stalled=0
  for e in "${ENGS[@]}"; do
    up=$(git -C "$WORK/$e/.claude/.memories-repo" rev-list '@{u}..HEAD' --count 2>/dev/null || echo 0)
    [ "${up:-0}" -gt 0 ] && stalled=$((stalled+1))
  done
  printf '%d\t%d\t%d\t%d\n' "$r" "$written" "$landed" "$stalled" >> "$WORK/rounds.tsv"
  printf '  round %2d/%s  wrote: %-4s on remote: %-5s stalled: %s\n' "$r" "$ROUNDS" "$written" "$landed" "$stalled"
done
echo "done -> $WORK"
