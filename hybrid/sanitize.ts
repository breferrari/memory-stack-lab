/**
 * W1 content sanitization as a module, so the write path can gate on it
 * in-process rather than shelling out per file.
 *
 * FAILS CLOSED: any internal error is a block. A sanitizer that fails open is
 * decoration — the one time it breaks is the one time it mattered.
 *
 * Ported from harness/sanitize.sh; the deny-list is the set of shapes that
 * actually leaked in the recorded incident, not a general PII detector.
 */

export interface Finding {
	readonly rule: string;
	readonly match: string;
}

interface Rule {
	readonly id: string;
	readonly re: RegExp;
}

const RULES: readonly Rule[] = [
	{ id: "UUID", re: /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g },
	{ id: "HOME-PATH", re: /(?:\/home\/[a-zA-Z0-9._-]+|\/Users\/[a-zA-Z0-9._-]+|[A-Z]:\\Users\\[a-zA-Z0-9._-]+)/g },
	{ id: "EMAIL", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
	// TICKET is DISABLED BY DEFAULT and must be configured with the org's real
	// project keys. See `configure()` — measured at a 44% false-positive rate on
	// ordinary engineering prose when left as a generic `[A-Z]{2,10}-[0-9]+`,
	// because that is also the shape of UTF-8, HTTP-429, RFC-6749 and ISO-8601.
	// A ticket key is org-specific knowledge, not a universal pattern.
	{
		id: "CREDENTIAL",
		re: /(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._-]{20,})/g,
	},
	{ id: "PRIVATE-KEY", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
	{ id: "INTERNAL-HOST", re: /\b[a-zA-Z0-9-]+\.(?:internal|corp|intranet|local)\b/g },
	{ id: "PRIVATE-IP", re: /\b(?:10\.[0-9]{1,3}|192\.168|172\.(?:1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3}\b/g },
];

/**
 * Standards and protocol identifiers that share a ticket key's shape. Used only
 * when TICKET is enabled, to keep a configured key list from re-introducing the
 * false positives that made the generic rule unusable.
 */
const STANDARD_PREFIXES = new Set([
	"UTF", "HTTP", "HTTPS", "RFC", "ISO", "SHA", "MD", "AES", "RSA", "TLS", "SSL",
	"HTML", "CSS", "ES", "PEP", "JSR", "CVE", "UTC", "GMT", "IPV", "OAUTH", "SAML",
]);

let ticketKeys: readonly string[] = [];

/** Supply the org's real ticket prefixes, e.g. ["PAY","IDEN"]. Empty disables the rule. */
export function configure(opts: { ticketKeys?: readonly string[] }): void {
	ticketKeys = (opts.ticketKeys ?? []).map((k) => k.toUpperCase()).filter((k) => !STANDARD_PREFIXES.has(k));
}

/**
 * Shannon entropy in bits per character.
 *
 * Length alone does not separate a secret from an identifier:
 * `user_subscription_billing_period_start_utc` is 42 chars and was blocked by a
 * pure length rule. A credential is high-entropy AND character-class-diverse; a
 * long identifier is neither.
 */
export function entropyBits(s: string): number {
	if (!s) return 0;
	const freq = new Map<string, number>();
	for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
	let h = 0;
	for (const n of freq.values()) {
		const p = n / s.length;
		h -= p * Math.log2(p);
	}
	return h;
}

/** How many character classes the string draws on: lower, upper, digit, symbol. */
function classCount(s: string): number {
	return [/[a-z]/, /[A-Z]/, /[0-9]/, /[+/=_-]/].filter((r) => r.test(s)).length;
}

/**
 * A high-entropy run that looks like a credential rather than an identifier.
 *
 * Requires length, real entropy, and at least three character classes. A
 * snake_case column name has one or two classes and low entropy; a base64 secret
 * has three or four and high entropy.
 */
const ENTROPY_CANDIDATE = /\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g;

function highEntropyFindings(text: string): Finding[] {
	const out: Finding[] = [];
	for (const m of text.matchAll(ENTROPY_CANDIDATE)) {
		const tok = m[0];
		// An identifier: lowercase words joined by separators, no case mixing.
		if (/^[a-z0-9]+(?:[_-][a-z0-9]+)+$/.test(tok)) continue;
		if (classCount(tok) < 3) continue;
		if (entropyBits(tok) < 3.5) continue;
		out.push({ rule: "HIGH-ENTROPY", match: tok });
	}
	return out;
}

function ticketFindings(text: string): Finding[] {
	if (ticketKeys.length === 0) return [];
	const out: Finding[] = [];
	const re = new RegExp(String.raw`\b(${ticketKeys.join("|")})-[0-9]{1,6}\b`, "g");
	for (const m of text.matchAll(re)) out.push({ rule: "TICKET", match: m[0] });
	return out;
}

/**
 * Scan text for shapes that must not leave the machine.
 *
 * Returns findings rather than throwing, so the caller decides between refusing
 * the write and quarantining the file. Throwing inside a rule is caught and
 * converted to a synthetic finding — an unevaluable rule blocks, it never passes.
 */
export function scan(text: unknown): Finding[] {
	const s = String(text ?? "");
	const found: Finding[] = [];
	for (const rule of RULES) {
		try {
			for (const m of s.matchAll(rule.re)) {
				found.push({ rule: rule.id, match: m[0] });
				if (found.length > 50) return found;
			}
		} catch {
			found.push({ rule: `${rule.id}:UNEVALUABLE`, match: "" });
		}
	}
	try {
		found.push(...highEntropyFindings(s), ...ticketFindings(s));
	} catch {
		found.push({ rule: "DERIVED:UNEVALUABLE", match: "" });
	}
	return found;
}

export function isClean(text: unknown): boolean {
	try {
		return scan(text).length === 0;
	} catch {
		return false; // fail closed
	}
}
