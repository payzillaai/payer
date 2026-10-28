// The payer's MCP wire over stdio: one JSON-RPC line in, one line out, ONE tool. Shared by the payer's servers (server.ts is the small-wallet one).
import type { Answer } from "./payer.ts";

export interface Tool { readonly name: string; readonly [k: string]: unknown }
/** What the wire serves: the tool, what paying with it does, and the fixed words when paying throws (never the error text, and no claim that nothing was signed). */
export interface Served { tool: Tool; pay(args: Record<string, unknown>): Promise<Answer>; errorWords: string }

const result = (a: Answer): Record<string, unknown> => ({ content: [{ type: "text", text: JSON.stringify(a) }], structuredContent: a, isError: a.outcome !== "settled" });
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;

/** One JSON-RPC message in, the answer out (null for a notification). */
export async function handle(msg: unknown, s: Served): Promise<Record<string, unknown> | null> {
  const m = obj(msg);
  if (m["id"] === undefined) return null;
  const ok = (r: unknown) => ({ jsonrpc: "2.0", id: m["id"], result: r });
  const params = obj(m["params"]);
  switch (m["method"]) {
    case "initialize": return ok({ protocolVersion: typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "payzilla-payer", version: "1" } });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: [s.tool] });
    case "tools/call": {
      if (params["name"] !== s.tool.name) return { jsonrpc: "2.0", id: m["id"], error: { code: -32602, message: "unknown tool" } };
      try { return ok(result(await s.pay(obj(params["arguments"])))); }
      catch { return ok(result({ outcome: "unknown", reason: s.errorWords })); }
    }
    default: return { jsonrpc: "2.0", id: m["id"], error: { code: -32601, message: "method not found" } };
  }
}

export const MAX_LINE = 65_536;
/** One input line in, the answer line out (null = nothing to send). Malformed JSON gets -32700, an oversized line -32600. */
export async function onLine(line: string, s: Served): Promise<string | null> {
  if (line.length > MAX_LINE) return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "request too large" } });
  let msg: unknown; try { msg = JSON.parse(line); } catch { return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  const out = await handle(msg, s);
  return out ? JSON.stringify(out) : null;
}

/** Serve stdin to stdout, one call at a time in this process (the marker file is the lock across processes); a failed line never stops the next one. */
export async function serveStdio(s: Served): Promise<void> {
  const { createInterface } = await import("node:readline");
  let chain = Promise.resolve();
  createInterface({ input: process.stdin }).on("line", (line) => {
    chain = chain.then(async () => { const out = await onLine(line, s); if (out) process.stdout.write(`${out}\n`); }).catch(() => { /* next line */ });
  });
}
