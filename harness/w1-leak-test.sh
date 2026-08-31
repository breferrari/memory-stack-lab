#!/bin/bash
# W1 binary: does contaminated content reach the remote?
#   baseline  — the hook as shipped (filename guardrail only)
#   sanitized — the same hook with the W1 content scan gating the push
set -u
LAB="$(cd "$(dirname "$0")/.." && pwd)"
MODE=$1; WORK="$LAB/runs/w1-$MODE"
rm -rf "$WORK"; mkdir -p "$WORK/shim"
printf '#!/bin/bash\necho "${FAKE_HOST:-dev}"\n' > "$WORK/shim/hostname"; chmod +x "$WORK/shim/hostname"
export PATH="$WORK/shim:$PATH"

HOOK="$WORK/hook.sh"; cp "$LAB/upstream/mcs-shared/hooks/memories_autopush.sh" "$HOOK"
if [ "$MODE" = sanitized ]; then
  # gate the push on a content scan of every pending memory; fail closed
  python3 - "$HOOK" "$LAB/harness/sanitize.sh" <<'PY'
import io,sys
p,san = sys.argv[1], sys.argv[2]
s = io.open(p, encoding='utf-8', newline='').read()
anchor = 'if ! pull_err='
gate = f'''# --- W1: write-time content sanitization (fail closed, per-file quarantine) ---
# Blocking the whole push on one bad file loses clean work and gets the gate
# switched off. Quarantine the offending file, let the rest through.
_q="$memories_dir/../memories-quarantine"; _blocked=0
for _f in "$memories_dir"/memories/*.md; do
  [ -e "$_f" ] || continue
  if ! "{san}" "$_f" >/dev/null 2>&1; then
    mkdir -p "$_q"
    git -C "$memories_dir" rm --cached -q "memories/$(basename "$_f")" >/dev/null 2>&1
    mv "$_f" "$_q/" 2>/dev/null
    echo "Shared memories: QUARANTINED $(basename "$_f") - carries content that must not leave this machine."
    echo "  held at: memories-quarantine/$(basename "$_f")"
    _blocked=$((_blocked+1))
  fi
done
if [ "$_blocked" -gt 0 ]; then
  git -C "$memories_dir" add -A memories/ >/dev/null 2>&1
  git -C "$memories_dir" commit -q --amend --no-edit >/dev/null 2>&1
fi
'''
i = s.index(anchor)
io.open(p,'w',encoding='utf-8',newline='').write(s[:i] + gate + s[i:])
PY
  grep -q 'W1: write-time content sanitization' "$HOOK" || { echo "FATAL: W1 gate not applied"; exit 1; }
fi

git init -q --bare "$WORK/team.git"; git -C "$WORK/team.git" symbolic-ref HEAD refs/heads/main
git clone -q "$WORK/team.git" "$WORK/seed" 2>/dev/null
mkdir -p "$WORK/seed/memories"; echo seed > "$WORK/seed/memories/learning_seed_base.md"
git -C "$WORK/seed" config user.name s; git -C "$WORK/seed" config user.email s@s
git -C "$WORK/seed" add -A >/dev/null 2>&1; git -C "$WORK/seed" commit -qm seed >/dev/null
git -C "$WORK/seed" push -q -u origin HEAD:refs/heads/main

d="$WORK/eng"; mkdir -p "$d/.claude/hooks/shared-memories"
cp "$HOOK" "$d/.claude/hooks/shared-memories/memories_autopush.sh"
git clone -q "$WORK/team.git" "$d/.claude/.memories-repo" 2>/dev/null
git -C "$d/.claude/.memories-repo" config user.name eng
git -C "$d/.claude/.memories-repo" config user.email eng@corp

# a memory with a PERFECTLY CONVENTIONAL filename and contaminated content
cp "$LAB/runs/w1/fixtures/learning_dirty_incident.md" "$d/.claude/.memories-repo/memories/"
cp "$LAB/runs/w1/fixtures/learning_clean_backoff.md"  "$d/.claude/.memories-repo/memories/"
( cd "$d" && FAKE_HOST=eng ./.claude/hooks/shared-memories/memories_autopush.sh <<< '{"hook_event_name":"Stop"}' 2>&1 | sed 's/^/    /' )

echo "  --- files on remote ---"
git -C "$WORK/team.git" ls-tree -r --name-only main -- memories/ | sed 's/^/    /'
if git -C "$WORK/team.git" grep -qi 'sk-live\|@company.example\|\.internal' main -- memories/ 2>/dev/null; then
  echo "  RESULT: contaminated content REACHED THE REMOTE"
else
  echo "  RESULT: contaminated content did NOT reach the remote"
fi
