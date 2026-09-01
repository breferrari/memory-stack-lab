#!/usr/bin/env node
/**
 * Race N writers against a REAL shared-memories autopush hook.
 *
 *   node push-race-hook.mjs <writers> <path/to/memories_autopush.sh> [env=VALUE ...]
 *
 * The sibling push-race.mjs measures the PATTERN — one attempt against bounded
 * retry — in a few lines of JS. That is enough to characterise the behaviour and
 * not enough to say anything about somebody's actual script, so this runs the
 * script itself, in the layout it expects:
 *
 *   <project>/.claude/hooks/shared-memories/memories_autopush.sh   (anchors on its own path)
 *   <project>/.claude/.memories-repo/                              (the sparse checkout)
 *   <project>/.claude/.memories-repo/memories/                     (the cone)
 *
 * Contention is barrier-synchronised rather than emergent: every writer prepares
 * fully, blocks on one file, and is released together. Spawning N hooks and
 * hoping they collide measures the OS scheduler instead — on this machine that
 * design swung 14x between a busy and an idle box, in both directions.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const WRITERS = Number(process.argv[2] ?? 10);
const HOOK = resolve(process.argv[3] ?? "");
const EXTRA_ENV = Object.fromEntries(process.argv.slice(4).filter((a) => a.includes("=")).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
if (!HOOK || !existsSync(HOOK)) { console.error("usage: push-race-hook.mjs <writers> <memories_autopush.sh> [ENV=VALUE ...]"); process.exit(1); }

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const root = mkdtempSync(join(tmpdir(), "hookrace-"));
const remote = join(root, "remote.git");

mkdirSync(remote, { recursive: true });
git(root, "init", "-q", "--bare", remote);
// A bare repo's HEAD defaults to master. Push main into it and every clone
// checks out nothing ("remote HEAD refers to nonexistent ref"), which presents
// later as an empty working tree rather than as a setup error.
git(remote, "symbolic-ref", "HEAD", "refs/heads/main");

// Seed the remote so clones have a branch to track.
const seed = join(root, "seed");
mkdirSync(join(seed, "memories"), { recursive: true });
git(root, "init", "-q", "-b", "main", seed);
git(seed, "config", "user.email", "seed@example.invalid");
git(seed, "config", "user.name", "seed");
writeFileSync(join(seed, "memories", "seed.md"), "# seed\n");
git(seed, "add", "-A"); git(seed, "commit", "-qm", "seed"); git(seed, "remote", "add", "origin", remote); git(seed, "push", "-q", "-u", "origin", "main");

const barrier = join(root, "GO");
const projects = [];
for (let i = 0; i < WRITERS; i++) {
	const proj = join(root, `proj-${String(i).padStart(3, "0")}`);
	const hookDir = join(proj, ".claude", "hooks", "shared-memories");
	mkdirSync(hookDir, { recursive: true });
	copyFileSync(HOOK, join(hookDir, "memories_autopush.sh"));
	execFileSync("chmod", ["+x", join(hookDir, "memories_autopush.sh")]);

	const store = join(proj, ".claude", ".memories-repo");
	git(root, "clone", "-q", remote, store);
	git(store, "config", "user.email", `eng${i}@example.invalid`);
	git(store, "config", "user.name", `eng${i}`);
	// One memory per writer, named the way the pack's guardrail expects.
	writeFileSync(join(store, "memories", `learning_retry_eng${i}.md`), `# Retry lesson from eng${i}\n\nWhat was learned.\n`);
	projects.push(proj);
}

// Each writer: block on the barrier, then run the hook exactly as Stop would.
const worker = join(root, "worker.mjs");
writeFileSync(worker, `
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [proj, barrier] = process.argv.slice(2);
while (!existsSync(barrier)) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
const hook = proj + "/.claude/hooks/shared-memories/memories_autopush.sh";
spawnSync("bash", [hook], { input: JSON.stringify({ cwd: proj, hook_event_name: "Stop" }), encoding: "utf8", env: process.env, stdio: ["pipe", "pipe", "pipe"] });
`);

const { spawn } = await import("node:child_process");
const running = projects.map((p) => spawn(process.execPath, [worker, p, barrier], { stdio: "ignore", env: { ...process.env, ...EXTRA_ENV } }));

// Let every writer reach the barrier before lifting it. Without this the first
// spawned worker can finish before the last one has started, which is the
// emergent design this harness exists to avoid.
await new Promise((r) => setTimeout(r, 750));
writeFileSync(barrier, "go\n");
await Promise.all(running.map((c) => new Promise((r) => c.on("exit", r))));

// Count what actually reached the remote.
const landed = git(remote, "ls-tree", "--name-only", "-r", "main")
	.split("\n")
	.filter((f) => f.startsWith("memories/") && f !== "memories/seed.md").length;

console.log(JSON.stringify({
	writers: WRITERS,
	hook: HOOK,
	env: EXTRA_ENV,
	landed,
	lost: WRITERS - landed,
	note: landed === WRITERS ? "all writers landed" : `${WRITERS - landed} memories exist only on their author's machine`,
}, null, 1));

rmSync(root, { recursive: true, force: true });
