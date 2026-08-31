# memory-stack-lab

A reproducible harness for measuring how an agent memory stack behaves at organisation scale, and the benchmark suite behind [Vestige](https://github.com/breferrari/vestige).

Built to answer one question honestly: **which change is actually responsible for which improvement.** Earlier work established that a shared memory pool had problems but could not attribute them — the write-path findings ran one system, the retrieval findings substituted a different engine, and the proposed fix was validated in isolation.

## What is here

| | |
|---|---|
| `harness/` | seeded corpus generators, the 64-query fixture, the org-scale write matrix, the shared scorer |
| `hybrid/` | the end-to-end benchmark against the plugin's own API |

Everything is **seeded**: a rerun reproduces byte-identical corpora. `runs/`, `upstream/` and `tools/` are gitignored and regenerable.

## The method

Each rung changes **exactly one thing** against a fixed corpus and a fixed query set, so every delta is attributable.

- **Corpus** — 183 memories across 16 projects. Each body carries a domain-specific realisation of a shared topic, which is what makes retrieval quality meaningful; remove that property and every measurement flatters the system.
- **Queries** — 64, phrased as an engineer inside a project and **never naming the project**, because a real session does not name the repository it is already in. This property is load-bearing; do not "improve" the fixture by adding project names.
- **Write path** — 100 engineers, 12 rounds, 845 writes, all turn-boundary hooks firing simultaneously.

## Things this harness learned the hard way

Each of these produced plausible numbers that were wrong.

- **Measure the ceiling before the mechanism.** Filename collisions had already destroyed the answer for 61% of queries, capping a *perfect* retriever at precision@5 = 0.078. Raw precision was identical before and after the fix, so reading it without the ceiling inverts the conclusion.
- **Verify the swept variable actually moved.** A CLI that silently ignores an unknown flag turns a six-point sweep into the same measurement six times — and a non-deterministic pipeline dresses it up as a converging curve.
- **A tie between two broken configurations says nothing about the component.** Two retrieval engines scored identically on an unscoped pool, which was read as "the engine does not matter". On a properly filtered view the difference is 0.094 against 0.984.
- **Benchmark the product, not the architecture.** Every retrieval number here was once produced by indexes the *harness* built. The plugin was not building any, so its real-world number was 0.094 while the bench reported 0.984.
- **Score empty results.** A scorer that skips queries returning nothing excludes exactly the cases where retrieval failed hardest.

## Running it

```bash
node --experimental-strip-types harness/gen-corpus.mjs runs/scale/pool flat
node harness/ceiling.mjs runs/scale/pool harness/queries.tsv 5
./harness/runbench.sh <index-dir> <collection> runs/res harness/queries.tsv
node harness/score.mjs runs/res <corpus> <label> 5 64
```

Requires Node 22+, `git`, `jq`, and [qmd](https://github.com/tobi/qmd) for retrieval experiments.

> The write matrix spawns 100 concurrent processes per round. It is heavy — check load before and after, and do not leave it unattended.
