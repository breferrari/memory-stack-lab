/**
 * A minimal MCP client for qmd, so a benchmark can send ANY sub-query shape.
 *
 * The plugin's own session helper hardcodes `lex` + `vec`, which is the shape
 * under test — a sweep cannot run through the thing it is trying to vary.
 * Protocol handling is the same line-delimited JSON-RPC over stdio.
 */
import { spawn } from "node:child_process";

export function startQmd(index, cwd, cmd, argv) {
	const proc = spawn(cmd, [...argv, "--index", index, "mcp"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
	const s = { proc, buffer: "", nextId: 1, pending: new Map(), ready: false };
	proc.stdout.setEncoding("utf8");
	proc.stdout.on("data", (chunk) => {
		s.buffer += chunk;
		let nl;
		while ((nl = s.buffer.indexOf("\n")) >= 0) {
			const line = s.buffer.slice(0, nl).trim();
			s.buffer = s.buffer.slice(nl + 1);
			if (!line) continue;
			let msg; try { msg = JSON.parse(line); } catch { continue; }
			if (typeof msg.id !== "number") continue;
			const w = s.pending.get(msg.id);
			if (!w) continue;
			s.pending.delete(msg.id);
			clearTimeout(w.timer);
			msg.error ? w.reject(new Error(msg.error.message ?? "qmd error")) : w.resolve(msg.result);
		}
	});
	proc.stderr.resume();
	proc.unref?.();
	return s;
}

export function send(s, method, params, timeoutMs = 60_000) {
	const id = s.nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { s.pending.delete(id); reject(new Error("timeout")); }, timeoutMs);
		s.pending.set(id, { resolve, reject, timer });
		s.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

export async function initialize(s) {
	await send(s, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lab", version: "0" } });
	s.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	s.ready = true;
}

/** Returns document names in rank order. */
export async function query(s, args) {
	const r = await send(s, "tools/call", { name: "query", arguments: args }, 120_000);
	const structured = r?.structuredContent?.results;
	if (Array.isArray(structured)) return structured.map((x) => String(x.file ?? "").split("/").pop()).filter(Boolean);
	const text = r?.content?.find?.((c) => c?.type === "text")?.text;
	if (!text) return [];
	try {
		const j = JSON.parse(text);
		return (j.results ?? []).map((x) => String(x.file ?? "").split("/").pop()).filter(Boolean);
	} catch { return []; }
}

export const stop = (s) => { try { s.proc.kill(); } catch { /* already gone */ } };
