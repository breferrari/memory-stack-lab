#!/usr/bin/env node
/**
 * Does bounded retry recover pushes that a single attempt loses?
 *
 * The org-matrix version of this question cannot answer it. Its contention is
 * EMERGENT — 100 hooks fire and the OS scheduler decides how many actually
 * collide — so the result tracks machine load, swings 14x between a busy box
 * and an idle one, and consecutive arms contaminate each other through a load
 * average that lags a minute behind. Three attempts at controlling that failed.
 *
 * So contention is made DETERMINISTIC here instead. N writers each commit, then
 * block on a barrier, then all attempt `pull --rebase; push` the moment it
 * lifts. Exactly one can win each round of a push race against one branch, so
 * the number of losers is a property of N, not of the machine. The question is
 * only ever: do the losers recover?
 *
 *   node push-race.mjs <writers> <mode: single|retry> [attempts]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRITERS = Number(process.argv[2] ?? 20);
const MODE = process.argv[3] === "retry" ? "retry" : "single";
const ATTEMPTS = Number(process.argv[4] ?? 5);

const root = mkdtempSync(join(tmpdir(), "race-"));
const bare = join(root, "team.git");
execFileSync("git", ["init", "-q", "--bare", bare]);
execFileSync("git", ["-C", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
const seed = join(root, "seed");
execFileSync("git", ["clone", "-q", bare, seed]);
mkdirSync(join(seed, "memories"), { recursive: true });
writeFileSync(join(seed, "memories", "seed.md"), "seed\n");
for (const [k, v] of [["user.name", "s"], ["user.email", "s@s"]]) execFileSync("git", ["-C", seed, "config", k, v]);
execFileSync("git", ["-C", seed, "add", "-A"]);
execFileSync("git", ["-C", seed, "commit", "-qm", "seed"]);
execFileSync("git", ["-C", seed, "push", "-q", "-u", "origin", "HEAD"]);

// Each writer: its own clone, one memory committed, then wait for the barrier.
const dirs = [];
for (let i = 0; i < WRITERS; i++) {
  const d = join(root, `w${i}`);
  execFileSync("git", ["clone", "-q", bare, d]);
  for (const [k, v] of [["user.name", `w${i}`], ["user.email", `w${i}@x`]]) execFileSync("git", ["-C", d, "config", k, v]);
  writeFileSync(join(d, "memories", `w${i}.md`), `memory from writer ${i}\n`);
  execFileSync("git", ["-C", d, "add", "-A"]);
  execFileSync("git", ["-C", d, "commit", "-qm", `w${i}`]);
  dirs.push(d);
}

const barrier = join(root, "GO");
const worker = join(root, "worker.mjs");
writeFileSync(worker, `
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
const [dir, mode, attempts] = process.argv.slice(2);
const git = (a) => { try { execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" }); return true; } catch { return false; } };
// Spin on the barrier so every writer leaves at the same instant, rather than
// whenever the scheduler happens to wake it.
while (!existsSync(${JSON.stringify(barrier)})) {}
let ok = false;
for (let i = 0; i < (mode === "retry" ? Number(attempts) : 1); i++) {
  if (git(["pull", "--rebase", "--autostash", "-q"]) && git(["push", "-q", "-u", "origin", "HEAD"])) { ok = true; break; }
  if (mode !== "retry") break;
  const cap = Math.min(2000, 50 * 2 ** (i + 1));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.random() * cap);
}
process.exit(ok ? 0 : 1);
`);

const procs = dirs.map((d) => spawnSync === null ? null : null);
const { spawn } = await import("node:child_process");
const running = dirs.map((d) => spawn(process.execPath, [worker, d, MODE, String(ATTEMPTS)], { stdio: "ignore" }));
// let every worker reach the barrier before lifting it
await new Promise((r) => setTimeout(r, 400));
writeFileSync(barrier, "go");
const codes = await Promise.all(running.map((p) => new Promise((r) => p.on("exit", r))));

const landed = execFileSync("git", ["-C", bare, "ls-tree", "-r", "--name-only", "main", "--", "memories/"], { encoding: "utf8" })
  .split("\n").filter((l) => /w\d+\.md$/.test(l)).length;

console.log(JSON.stringify({
  writers: WRITERS, mode: MODE, attempts: MODE === "retry" ? ATTEMPTS : 1,
  landed, lost: WRITERS - landed,
  workers_reporting_success: codes.filter((c) => c === 0).length,
}));
rmSync(root, { recursive: true, force: true });
