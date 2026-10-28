// The MCP client calls of the Payzilla payers: one JSON-RPC call over HTTP, a tool call, and the paid answer read as fixed words.
// Nothing the service says is trusted beyond a JSON-RPC result; a refusal is a FIXED text.
// @ts-expect-error plain node module (no types)
import { Refusal } from "./x402-client.mjs";

export type Fetcher = { fetch(u: string, i: RequestInit): Promise<Response> };
const refuse = (t: string, code = 1): never => { throw new Refusal(t, code); };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/, B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, TOOL = /^[a-z][a-z_]{0,39}$/;
const KNOWN_ERRORS: Record<string, string> = { not_sent: "NOT SENT", closed: "NOT CONFIRMED (the service is switched off)", not_payable: "NOT CONFIRMED (the listing is not payable)", requirement_gone: "NOT CONFIRMED (the terms are no longer open)", cap_reached: "NOT CONFIRMED (the daily limit is reached)", bad_payment: "NOT CONFIRMED (the payment was not accepted as given)", in_progress: "NOT CONFIRMED (still being processed)", rate_limited: "NOT CONFIRMED (too many requests)", unavailable: "NOT CONFIRMED (the service could not finish)", list_unavailable: "NOT CONFIRMED (the listing cannot be read)", seller_unreachable: "NOT SENT", seller_invalid: "NOT SENT" };
const MAX_BODY = 65536;
export const safeText = (v: unknown): string => (typeof v === "string" && /^[A-Za-z0-9 .,'()-]{1,60}$/.test(v) ? v : "(not shown)");

/** One JSON-RPC call. The answer is JSON or one server-sent event; nothing else is trusted. Returns the `result` object or refuses with a fixed text. */
export async function rpc(io: Fetcher, c: { mcpUrl: string }, id: number, method: string, params: unknown, timeoutMs: number, fresh = false): Promise<Record<string, unknown>> {
  let res: Response;
  try { res = await io.fetch(c.mcpUrl, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(fresh ? { connection: "close" } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(timeoutMs) }); }
  catch { return refuse(`no answer from the service for ${method} (timeout or network). Nothing was signed.`); }
  if (res.status !== 200) refuse(res.status >= 300 && res.status < 400 ? "the service answered with a redirect; this script never follows one. Nothing was signed." : `the service answered HTTP ${res.status}, not 200; the body is not trusted. Nothing was signed.`);   // on the paid call a refusal here is reported as outcome unknown
  let text: string;
  try { text = await readCapped(res); } catch { return refuse(`the answer to ${method} could not be read. Nothing was signed.`); }
  let msg: unknown = null;
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  try {
    if (ct.startsWith("text/event-stream")) { const found = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l) as unknown; } catch { return null; } }).find((m) => isObj(m) && m["id"] === id); msg = found ?? null; }   // the data line that answers THIS call (a notification may come first)
    else msg = JSON.parse(text);
  } catch { /* handled below */ }
  if (!isObj(msg) || msg["jsonrpc"] !== "2.0" || msg["id"] !== id) return refuse(`the answer to ${method} is not a JSON-RPC answer for this call (HTTP ${res.status}). Nothing was signed.`);
  if (!isObj(msg["result"])) return refuse(`the service refused ${method}. Nothing was signed.`);
  return msg["result"];
}
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader(); if (!reader) return "";
  const chunks: Uint8Array[] = []; let n = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > MAX_BODY) { void reader.cancel(); throw new Error("too large"); } chunks.push(value); }
  return Buffer.concat(chunks).toString("utf8");
}
/** `fresh` (the paid call): a NEW connection ("connection: close"), so fetch cannot replay the request on a broken reused socket: one payment, never a retry. */
export const callTool = (io: Fetcher, c: { mcpUrl: string; timeoutMs: number }, id: number, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>, timeoutMs = c.timeoutMs, fresh = false) => rpc(io, c, id, "tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) }, timeoutMs, fresh);

/** What a paid call answered, as fixed words only. */
export interface Outcome { word: "settled" | "unknown" | "not sent" | "not confirmed"; signature?: string; pending?: string; reference?: string; note?: string }
export function readPaidAnswer(r: Record<string, unknown>, c: { network: string }): Outcome {
  const meta = isObj(r["_meta"]) ? (r["_meta"] as Record<string, unknown>)["x402/payment-response"] : undefined;
  if (r["isError"] !== true && isObj(meta) && meta["success"] === true && typeof meta["transaction"] === "string" && SIG.test(meta["transaction"]) && meta["network"] === c.network) return { word: "settled", signature: meta["transaction"] };
  const sc = isObj(r["structuredContent"]) ? (r["structuredContent"] as Record<string, unknown>) : {};
  const code = typeof sc["error"] === "string" ? sc["error"] : "";
  if (r["isError"] === true && code === "outcome_unknown") {
    const ref = typeof sc["reference"] === "string" && UUID.test(sc["reference"]) ? sc["reference"] : undefined;
    const pend = typeof sc["pendingTransaction"] === "string" && SIG.test(sc["pendingTransaction"]) ? sc["pendingTransaction"] : undefined;
    return { word: "unknown", ...(ref ? { reference: ref } : {}), ...(pend ? { pending: pend } : {}) };
  }
  if (r["isError"] === true && Object.hasOwn(KNOWN_ERRORS, code)) { const w = KNOWN_ERRORS[code]!; return { word: w.startsWith("NOT SENT") ? "not sent" : "not confirmed", note: w }; }
  return { word: "unknown" };   // anything not understood is unknown, never success
}
