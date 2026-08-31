#!/bin/bash
# Simulates N engineers ending a turn at the same moment, each with one new
# memory, all running the real memories_autopush.sh against one shared branch.
# Every filename is unique — this measures PUSH CONTENTION only, not collisions.
set -u
N=${1:-25}
LAB="$(cd "$(dirname "$0")/.." && pwd)"
UP="$LAB/upstream"
SB="$LAB/runs/conc-$N"
rm -rf "$SB"; mkdir -p "$SB/shim"
printf '#!/bin/bash\necho "${FAKE_HOST:-dev}"\n' > "$SB/shim/hostname"; chmod +x "$SB/shim/hostname"
export PATH="$SB/shim:$PATH"

git init -q --bare "$SB/team.git"; git -C "$SB/team.git" symbolic-ref HEAD refs/heads/main

# seed
git clone -q "file://$SB/team.git" "$SB/seed" 2>/dev/null
mkdir -p "$SB/seed/memories"; echo seed > "$SB/seed/memories/learning_seed_base.md"
git -C "$SB/seed" config user.name s; git -C "$SB/seed" config user.email s@s
git -C "$SB/seed" add -A >/dev/null; git -C "$SB/seed" commit -qm seed
git -C "$SB/seed" push -q -u origin HEAD:refs/heads/main

# provision N engineer clones
for i in $(seq 1 "$N"); do
  d="$SB/eng$i"
  mkdir -p "$d/.claude/hooks/shared-memories"
  cp "$UP/mcs-shared/hooks/memories_autopush.sh" "$d/.claude/hooks/shared-memories/"
  git clone -q "file://$SB/team.git" "$d/.claude/.memories-repo" 2>/dev/null
  git -C "$d/.claude/.memories-repo" config user.name "eng$i"
  git -C "$d/.claude/.memories-repo" config user.email "eng$i@corp"
  printf '# Memory from engineer %s\n\n**Applies to:** service-%s\n\nUnique content %s.\n' \
    "$i" "$i" "$i" > "$d/.claude/.memories-repo/memories/learning_topic${i}_detail.md"
done

# all Stop hooks fire at once
start=$(date +%s%N)
for i in $(seq 1 "$N"); do
  (
    cd "$SB/eng$i" && FAKE_HOST="eng$i" \
      ./.claude/hooks/shared-memories/memories_autopush.sh <<< '{"hook_event_name":"Stop"}' \
      > "$SB/eng$i.out" 2>&1
  ) &
done
wait
end=$(date +%s%N)

landed=$(git -C "$SB/team.git" ls-tree -r --name-only main -- memories/ | grep -c 'learning_topic')
stalled=0; retry=0
for i in $(seq 1 "$N"); do
  up=$(git -C "$SB/eng$i/.claude/.memories-repo" rev-list '@{u}..HEAD' --count 2>/dev/null || echo 0)
  [ "$up" -gt 0 ] && stalled=$((stalled+1))
  grep -q 'retry on next Stop' "$SB/eng$i.out" 2>/dev/null && retry=$((retry+1))
done

printf '{"writers":%d,"landed_first_pass":%d,"unpushed_after":%d,"told_to_retry_later":%d,"wall_ms":%d}\n' \
  "$N" "$landed" "$stalled" "$retry" "$(( (end-start)/1000000 ))"
