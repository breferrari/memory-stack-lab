import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync as rd, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
const readdirSync = (p: string, o?: unknown) => (existsSync(p) ? rd(p, o as never) : []);
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, poolName, readPool, visibleTo, ALLOWED_POOL_NAME } from "./memory.ts";
import { scan, configure } from "./sanitize.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "hybrid-"));
const pool = (d: string) => join(d, "memories");
const BODY = "A retried request must carry an idempotency key, or the second attempt applies the same change twice and the ledger double-counts it.";
const ok = (over: Record<string, unknown> = {}) => ({
	title: "Retries need an idempotency key",
	body: BODY,
	confidence: "verified",
	verification: "checked against the ledger service",
	scope: "project",
	projects: ["payments-service"],
	...over,
});

describe("happy path", () => {
	test("captures, namespaces by project, and passes its own guardrail", () => {
		const d = tmp();
		const r = capture(pool(d), ok(), { origin: "payments-service" });
		assert.equal(r.ok, true, r.errors.join("; "));
		assert.match(r.rel!, /^payments-service__/);
		assert.ok(ALLOWED_POOL_NAME.test(r.rel!), `guardrail rejected its own output: ${r.rel}`);
		const md = readFileSync(join(pool(d), r.rel!), "utf8");
		assert.match(md, /scope: project/);
		assert.match(md, /projects: \["payments-service"\]/);
	});
});

describe("scope narrowing is the filter's precondition", () => {
	test("general + named projects is downgraded, and the claim is preserved for audit", () => {
		const d = tmp();
		const r = capture(pool(d), ok({ scope: "general", projects: ["payments-service"] }), { origin: "payments-service" });
		assert.equal(r.ok, true);
		assert.equal(r.value!.scope, "project");
		assert.equal(r.value!.downgraded_from, "general");
		assert.match(readFileSync(join(pool(d), r.rel!), "utf8"), /claimed_scope: general/);
	});

	test("general naming nothing STANDS - the tier stays reachable", () => {
		const d = tmp();
		const r = capture(pool(d), ok({ scope: "general", projects: [], generality: "applies to any retried mutation" }), { origin: "payments-service" });
		assert.equal(r.ok, true);
		assert.equal(r.value!.scope, "general");
		assert.match(r.rel!, /^_general__/);
	});

	test("a memory that would reach nobody is refused, not widened", () => {
		const d = tmp();
		const r = capture(pool(d), ok({ scope: "project", projects: [] }), { origin: null });
		assert.equal(r.ok, false);
		assert.match(r.errors.join(" "), /reach nobody/);
	});
});

describe("the epistemic contract survives the port", () => {
	test("a transcript is rejected outright", () => {
		const d = tmp();
		const r = capture(pool(d), ok({ body: "user: hi\nassistant: hello\nuser: fix it\nassistant: done\nuser: thanks" }), { origin: "x" });
		assert.equal(r.ok, false);
		assert.match(r.errors.join(" "), /transcript/);
	});

	test("a recurrence claim is flagged and confidence is capped", () => {
		const d = tmp();
		const r = capture(pool(d), ok({ body: `${BODY} This always fails every time under load.` }), { origin: "payments-service" });
		assert.equal(r.ok, true);
		assert.equal(r.value!.confidence, "inferred");
		assert.equal(r.value!.claimed_confidence, "verified");
	});
});

describe("W1 - contaminated content never reaches the pool", () => {
	test("a leak is quarantined outside the git-tracked pool", () => {
		const d = tmp();
		const r = capture(pool(d), ok({ body: `${BODY} Repro at /home/bferrari/dump.json on auth-db-03.internal, ticket PAY-4471.` }), { origin: "payments-service" });
		assert.equal(r.ok, false);
		assert.equal(r.quarantined, true);
		// TICKET is opt-in, so PAY-4471 is NOT among these by default — that is the
		// recalibration, not a gap: a generic [A-Z]{2,10}-[0-9]+ also matches UTF-8,
		// HTTP-429, RFC-6749 and ISO-8601, measured at 4 false positives in 9.
		const rules = new Set(r.findings.map((f) => f.rule));
		assert.ok(rules.has("HOME-PATH") && rules.has("INTERNAL-HOST"), JSON.stringify(r.findings));
		assert.ok(!rules.has("TICKET"), "TICKET must stay off until the org configures its keys");
		// The pool directory is never even created on a quarantined write — there
		// is nothing to commit, so there is nothing to make.
		assert.equal(readdirSync(pool(d), { withFileTypes: true }).length, 0, "pool must be empty");
		assert.equal(readdirSync(join(d, "memories-quarantine")).length, 1);
	});

	test("a clean memory still lands beside a quarantined one", () => {
		const d = tmp();
		capture(pool(d), ok({ title: "Dirty one", body: `${BODY} token sk-liveAbcdEfghIjklMnopQrstUvwxYz0123456789` }), { origin: "payments-service" });
		const good = capture(pool(d), ok({ title: "Clean one" }), { origin: "payments-service" });
		assert.equal(good.ok, true);
		assert.equal(readdirSync(pool(d)).length, 1);
	});
});

describe("turning it upside down", () => {
	test("a path-traversal title cannot escape the pool", () => {
		const d = tmp();
		const r = capture(pool(d), ok({ title: "../../../etc/passwd owned" }), { origin: "payments-service" });
		assert.equal(r.ok, true);
		assert.ok(!r.rel!.includes("/") && !r.rel!.includes("\\"), `escaped: ${r.rel}`);
		assert.ok(readdirSync(pool(d)).length === 1);
	});

	test("wikilink terminators in a title cannot forge a link or a heading", () => {
		const d = tmp();
		const r = capture(pool(d), ok({ title: "Flag #7 and [[Some Note]] landed" }), { origin: "payments-service" });
		assert.equal(r.ok, true);
		assert.ok(!/[#[\]|]/.test(r.rel!), `terminator survived: ${r.rel}`);
	});

	test("a Windows-reserved title is rewritten rather than corrupting the file", () => {
		const d = tmp();
		const r = capture(pool(d), ok({ title: "CON" }), { origin: "payments-service" });
		assert.equal(r.ok, true);
		assert.match(r.rel!, /_CON/);
	});

	test("same project, same title, twice - the second must not clobber the first", () => {
		const d = tmp();
		const a = capture(pool(d), ok({ body: `${BODY} First.` }), { origin: "payments-service" });
		const b = capture(pool(d), ok({ body: `${BODY} Second.` }), { origin: "payments-service" });
		assert.equal(a.ok && b.ok, true);
		assert.notEqual(a.rel, b.rel);
		assert.equal(readdirSync(pool(d)).length, 2, "MCS silently overwrites here; the hybrid must not");
		const bodies = readdirSync(pool(d)).map((f) => readFileSync(join(pool(d), f), "utf8"));
		assert.ok(bodies.some((x) => x.includes("First.")) && bodies.some((x) => x.includes("Second.")));
	});

	test("a body under the floor is refused", () => {
		const d = tmp();
		assert.equal(capture(pool(d), ok({ body: "yes" }), { origin: "x" }).ok, false);
	});

	test("an emoji-only title still lands, under a digest stem, with the title preserved", () => {
		const d = tmp();
		const r = capture(pool(d), ok({ title: "🔥🔥🔥" }), { origin: "payments-service" });
		assert.equal(r.ok, true, `a memory must never be lost to its own title: ${r.errors.join("; ")}`);
		assert.match(r.rel!, /^payments-service__memory-[0-9a-f]{12}\.md$/);
		assert.ok(ALLOWED_POOL_NAME.test(r.rel!));
		// the title survives where a reader and a wikilink can still find it
		assert.match(readFileSync(join(pool(d), r.rel!), "utf8"), /🔥🔥🔥/);
	});

	test("a CJK title lands too, rather than being refused", () => {
		const d = tmp();
		const r = capture(pool(d), ok({ title: "再試行には冪等キーが必要" }), { origin: "payments-service" });
		assert.equal(r.ok, true, r.errors.join("; "));
		assert.ok(ALLOWED_POOL_NAME.test(r.rel!));
	});

	test("a configured org ticket key is caught, and standards prefixes still are not", () => {
		configure({ ticketKeys: ["PAY", "IDEN"] });
		assert.ok(scan("debugging PAY-4471 on the ledger").some((f) => f.rule === "TICKET"));
		assert.equal(scan("decode as UTF-8 first, then hash").length, 0);
		// a standards prefix supplied as an org key is ignored rather than trusted
		configure({ ticketKeys: ["UTF"] });
		assert.equal(scan("decode as UTF-8 first, then hash").length, 0);
		configure({ ticketKeys: [] });
	});

	test("entropy, not length, separates a secret from an identifier", () => {
		assert.equal(scan("column user_subscription_billing_period_start_utc is generated").length, 0);
		assert.ok(scan("key ghp_AbcdEfghIjklMnopQrstUvwxYz0123456789").length > 0);
	});

	test("the scanner blocks when a rule cannot be evaluated (fail closed)", () => {
		// scan() is total; a thrown rule becomes a finding rather than a pass.
		assert.equal(scan("clean text with nothing in it").length, 0);
		assert.ok(scan("id 550e8400-e29b-41d4-a716-446655440000").length > 0);
	});
});

describe("visibility - V4 generalized, default deny", () => {
	const build = () => {
		const d = tmp();
		mkdirSync(pool(d), { recursive: true });
		capture(pool(d), ok({ title: "Project one", projects: ["payments-service"] }), { origin: "payments-service" });
		capture(pool(d), ok({ title: "Two projects", projects: ["payments-service", "ledger-service"] }), { origin: "payments-service" });
		capture(pool(d), ok({ title: "Everywhere", scope: "general", projects: [], generality: "reaches all" }), { origin: "payments-service" });
		capture(pool(d), ok({ title: "Ios thing", scope: "platform", projects: [], platforms: ["ios"] }), { origin: "mobile-ios" });
		writeFileSync(join(pool(d), "broken__garbage.md"), "no frontmatter at all");
		return d;
	};

	test("a project caller sees its own, its shared, and general - not the ios one", () => {
		const entries = readPool(pool(build()));
		const vis = visibleTo(entries, { project: "payments-service", platforms: [] }).map((e) => e.name);
		assert.equal(vis.some((n) => n.includes("Project-one") || n.includes("Project one")), true);
		assert.equal(vis.some((n) => n.startsWith("_general__")), true);
		assert.equal(vis.some((n) => n.startsWith("_platform__")), false);
	});

	test("a platform caller sees the platform memory; a foreign project does not", () => {
		const entries = readPool(pool(build()));
		const ios = visibleTo(entries, { project: "mobile-ios", platforms: ["ios"] }).map((e) => e.name);
		const web = visibleTo(entries, { project: "web-app", platforms: ["web"] }).map((e) => e.name);
		assert.equal(ios.some((n) => n.startsWith("_platform__")), true);
		assert.equal(web.some((n) => n.startsWith("_platform__")), false);
	});

	test("a caller with no identity sees only general", () => {
		const entries = readPool(pool(build()));
		const vis = visibleTo(entries, { project: null, platforms: [] });
		assert.ok(vis.length > 0);
		assert.ok(vis.every((e) => e.facets.scope === "general"), "identity-less caller must not see scoped memories");
	});

	test("unparseable frontmatter is visible to nobody", () => {
		const entries = readPool(pool(build()));
		for (const caller of [{ project: "payments-service", platforms: [] }, { project: null, platforms: [] }]) {
			assert.equal(visibleTo(entries, caller).some((e) => e.name === "broken__garbage.md"), false);
		}
	});
});
