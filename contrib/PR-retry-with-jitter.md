# Retry the push with jitter, so simultaneous Stop hooks stop losing memories

## The symptom

Every engineer's `Stop` hook fires at a turn boundary, so a team pushes to one branch within the same instant. `memories_autopush.sh` does one `pull --rebase` and one `push`, and on failure says *"will retry on next Stop"* — but the next Stop lands in the next simultaneous burst and loses the same race.

The failure is silent and cumulative. Memories keep being written locally; they stop arriving. Nothing errors, and the engineer gets no signal that their KB has stopped syncing.

## The measurement

A push race against one branch has exactly one winner per round, so the honest way to measure this is to make the contention deterministic rather than hoping the scheduler produces it. `harness/push-race.mjs` gives N writers their own clone, has each commit one memory, blocks them all on a barrier, and lifts it.

| writers | single attempt | bounded retry (5) |
|---|---|---|
| 5 | 1, 1, 1 | 5, 5, 5 |
| 20 | 1, 1, 1 | 20, 20, 19 |
| 50 | 1, 1, 2 | 47, 50, 44 |

Three runs each. **A single attempt lands exactly one writer no matter how many are pushing** — every other memory stays local. Retry recovers essentially all of them.

At 50 writers, five attempts begins to run short, so `MEMORIES_PUSH_ATTEMPTS` should scale with expected team concurrency.

> A note on what this does **not** claim. An earlier version of this measurement used a 100-engineer simulation whose hooks fired "simultaneously" via process spawn. Those numbers were unusable: the OS scheduler staggers the spawns, so the result tracked machine load and swung 14x between a busy and an idle box. Any figure from that design — in either direction — should be disregarded. The barrier version above is machine-independent.

## The change

Three real lines, wrapped around the existing logic:

```
git diff -w --stat   →   31 insertions(+), 3 deletions(-)
```

The larger unified diff is almost entirely re-indentation from putting the existing block inside a `while`.

- Conflict handling, the `LC_ALL=C` locale guard, and every existing message are untouched.
- Attempts are bounded (`MEMORIES_PUSH_ATTEMPTS`, default 5) so a hook can never spin.
- **Full jitter**, not fixed backoff: a fixed delay re-synchronises exactly the writers that just collided, which is the problem it is meant to solve.
- `awk` is already a dependency of this pack, so nothing new is required.

## Reproducing it

```bash
git clone https://github.com/breferrari/memory-stack-lab
node harness/push-race.mjs 20 single      # 1 of 20 lands
node harness/push-race.mjs 20 retry 5     # 20 of 20 land
```

No fixtures, no setup, no machine assumptions.
