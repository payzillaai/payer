// The payer's one rule: an assistant (or a person) pays a verified Marketplace listing, up to a small cap, from a wallet this tool signs for.
// Above the cap, off the allow-list, past the repeat guard or while an earlier payment is open or unknown, it pays NOTHING and returns the listing's pay link for a human.
// The hard fence is the wallet side's own limit (its balance, and any policy of its signer). The marker and the repeat guard below are LOCAL safety nets against repeats and double pay: files on the same Mac,
// which anyone with a shell there (the assistant included) can delete. Nothing the service says is returned: only fixed words, the pinned label and validated values.
// @ts-expect-error plain node module (no types)
import { validateChallenge, USDC_MINT, NETWORK } from "./lib/x402-client.mjs";
import { readPaidAnswer } from "./lib/mcp-client.ts";

export const MCP_URL = "https://paywith.payzilla.ai/mcp", HOST = new URL(MCP_URL).host, RESOURCE = "mcp://tool/listing_pay";
export const payLink = (id: string): string => new URL(`/p/${id}`, MCP_URL).href;
/** A payment the service named but that is not final yet (larger payments, above 5 USDC, wait for finality): fixed words, the outcome stays unknown and the marker is kept. */
export const PENDING_WORDS = "the payment was sent and is waiting for final confirmation on the chain (payments above 5 USDC can take a minute or more): do NOT pay again; check the pending transaction before any new payment";
export const REPEAT_LIMIT = 3, REPEAT_WINDOW_MS = 3_600_000;   // at most 3 signing attempts per hour: a repeat guard, not a funding cap
/** Refused tries (the wallet said no; nothing sent) do not count above. After REFUSAL_LIMIT of them in an hour, one try a minute: an assistant looping on an empty wallet is slowed, a good payment waits at most a minute. */
export const REFUSAL_LIMIT = 10, REFUSAL_GAP_MS = 60_000;

/** One allow-listed listing: pinned in code, never taken from a request. `label` is what the answer names (never the seller's text). */
export interface Allowed { readonly listingId: string; readonly label: string; readonly payee: string; readonly maxMinor: bigint }
export interface Marker { state: "pending" | "unknown"; listingId: string; amountMinor: string; at: string; signature?: string; reference?: string }
/** The state on disk. `take` creates the marker EXCLUSIVELY (false if one exists, in this or another process): only its holder signs, writes attempts, updates or releases it. */
export interface Store { marker(): Marker | null; attempts(): number[]; take(m: Marker): boolean; update(m: Marker): void; release(): void; saveAttempts(a: number[]): void; refusals(): number[]; saveRefusals(a: number[]): void }
/** The wallet side (a Signer). Contract: `refused` means NOTHING was sent and no signature left the wallet side (the marker is released), and its reason is fixed words; a wallet that may have signed answers `unknown` or throws. */
export type SignOutcome = { kind: "signed"; payload: Record<string, unknown> } | { kind: "refused"; reason: string } | { kind: "unknown" };
export interface Signer { sign(accept: Record<string, unknown>, resource: unknown): Promise<SignOutcome> }
/** One MCP tool call; `fresh` = a new connection, for the paid call. Throws on anything but a JSON-RPC result. */
export type Call = (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>, fresh?: boolean) => Promise<Record<string, unknown>>;
/** `repeatLimit`: signing attempts per hour (default REPEAT_LIMIT). */
export interface Deps { allow: readonly Allowed[]; store: Store; signer: Signer; call: Call; now: () => number; enabled: () => boolean; repeatLimit?: number }

/** `pending`: a transaction the service named that is not final yet (outcome stays unknown). `warning`: fixed words about the wallet, never about the payment. */
export interface Answer { outcome: "settled" | "needs approval" | "blocked" | "refused" | "unknown"; reason?: string; listing?: string; amount?: string; transaction?: string; pending?: string; reference?: string; payLink?: string; warning?: string }
/** A promise that rejects after `ms`. */
export const within = <T>(ms: number, p: Promise<T>): Promise<T> => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout")), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const short = (a: string): string => `${a.slice(0, 4)}…${a.slice(-4)}`;
/** "0.01" -> 10000n (USDC, 6 decimals); anything else null. Pure. */
export function priceMinor(text: unknown): bigint | null {
  const m = typeof text === "string" ? /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(text) : null;
  return m ? BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0")) : null;
}
const usdc = (minor: bigint): string => `${minor / 1_000_000n}.${(minor % 1_000_000n).toString().padStart(6, "0").replace(/0{1,4}$/, "")}`;
/** Why the repeat guard says no, or null. A clock behind the last attempt is a no (a clock moved back must not reopen the window). Pure. */
export function repeatRefusal(attempts: readonly number[], now: number, limit: number = REPEAT_LIMIT): string | null {
  if (attempts.some((t) => t > now)) return "the clock is behind the last payment; a person can pay with the link";
  return attempts.filter((t) => now - t < REPEAT_WINDOW_MS).length >= limit ? `${limit} payments in the last hour already; a person can pay with the link` : null;
}

/** How long to wait before the next try after many refused ones, or null. Refusals dated after now (a clock moved back) are not counted: they never block a payment. Pure. */
export function refusalWait(refusals: readonly number[], now: number): number | null {
  const recent = refusals.filter((t) => t <= now && now - t < REPEAT_WINDOW_MS);
  if (recent.length < REFUSAL_LIMIT) return null;
  const wait = Math.max(...recent) + REFUSAL_GAP_MS - now;
  return wait > 0 ? wait : null;
}

export async function payListing(d: Deps, listingId: unknown): Promise<Answer> {
  if (typeof listingId !== "string" || !UUID.test(listingId)) return { outcome: "refused", reason: "listing_id must be a listing uuid" };
  const link = payLink(listingId);
  const human = (outcome: Answer["outcome"], reason: string, more: Partial<Answer> = {}): Answer => ({ outcome, reason, payLink: link, ...more });
  const BLOCKED = "a payment is open or its outcome is unknown; check the wallet and the chain before any new payment";
  if (!d.enabled()) return human("needs approval", "the payer tool is switched off; a person can pay with the link");
  if (d.store.marker()) return human("blocked", BLOCKED);
  const rule = d.allow.find((a) => a.listingId === listingId);
  if (!rule) return human("needs approval", "this listing is not on the payer tool's allow list");
  let refused: number[]; try { refused = d.store.refusals(); } catch { refused = []; }   // an unreadable record only loosens the slow-down
  const wait = refusalWait(refused, d.now());
  if (wait !== null) return human("refused", `${REFUSAL_LIMIT} tries were refused by the wallet in the last hour (is it empty?); try again in ${Math.ceil(wait / 1000)} s; nothing was sent`);

  const got = await d.call("marketplace_get_listing", { id: listingId });
  const l = isObj(got["structuredContent"]) ? (got["structuredContent"] as Record<string, unknown>)["listing"] : undefined;
  if (got["isError"] === true || !isObj(l) || l["id"] !== listingId) return human("refused", "the listing was not found");
  const price = priceMinor(l["priceUsdc"]);
  if (l["verified"] !== true || l["payable"] !== true || l["serviceHost"] !== HOST || l["network"] !== NETWORK || l["asset"] !== USDC_MINT || l["payToShort"] !== short(rule.payee) || price === null) return human("refused", "the listing does not match the allow list (verified, payable, host, network, token, payee)");
  const shown = { listing: rule.label, amount: usdc(price) };
  if (price > rule.maxMinor) return human("needs approval", `the price is above the ${usdc(rule.maxMinor)} USDC limit for paying by itself`, shown);
  const early = repeatRefusal(d.store.attempts(), d.now(), d.repeatLimit);
  if (early) return human("needs approval", early, shown);

  const terms = await d.call("listing_pay", { id: listingId });
  const pr = terms["structuredContent"];
  let accept: Record<string, unknown>;
  try {
    if (terms["isError"] !== true || !isObj(pr)) throw new Error("no terms");
    accept = validateChallenge(pr, { network: NETWORK, mint: USDC_MINT, expectedPayTo: rule.payee, capMinor: rule.maxMinor, url: RESOURCE }) as Record<string, unknown>;
    if (accept["amount"] !== price.toString()) throw new Error("amount differs from the listing");
  } catch { return human("refused", "the service's payment terms are not the allow-listed ones; nothing was signed", shown); }

  // The lock: only the process that creates the marker goes on. Under it the attempts are read AGAIN (another process may have paid since the first look).
  const at = d.now();
  const marker: Marker = { state: "pending", listingId, amountMinor: price.toString(), at: new Date(at).toISOString() };
  if (!d.store.take(marker)) return human("blocked", BLOCKED, shown);
  const attempts = d.store.attempts(); const late = repeatRefusal(attempts, at, d.repeatLimit);
  if (late) { d.store.release(); return human("needs approval", late, shown); }

  let s: SignOutcome;
  try { s = await d.signer.sign(accept, (pr as Record<string, unknown>)["resource"]); } catch { s = { kind: "unknown" }; }
  // A refusal sent nothing, so it does not count against the repeat guard (so refusals never lock payments out for an hour). Reason: fixed words of the Signer.
  if (s.kind === "refused") {
    try { d.store.saveRefusals([...d.store.refusals().filter((t) => t <= at && at - t < REPEAT_WINDOW_MS), at]); } catch { /* a refusal not recorded only loosens the slow-down */ }
    d.store.release();
    return human("refused", `the wallet refused to sign: ${s.reason}; nothing was sent`, shown);
  }
  const unknown = (reason: string, more: Partial<Marker> = {}, extra: Partial<Answer> = {}): Answer => {
    try { d.store.update({ ...marker, ...more, state: "unknown" }); } catch { /* the pending marker stays, which blocks just the same */ }
    return human("unknown", reason, { ...shown, ...(more.reference ? { reference: more.reference } : {}), ...extra });
  };
  // Signed or maybe signed: it counts. Still under the marker, so no other process wrote attempts since they were read.
  try { d.store.saveAttempts([...attempts.filter((t) => at - t < REPEAT_WINDOW_MS), at]); } catch { return unknown("the tool could not record this payment attempt; nothing was sent; check before any new payment"); }
  if (s.kind === "unknown") return unknown("the wallet may have signed; this tool sent nothing; check before any new payment");
  // From here a signature exists: any failure is an unknown outcome, the marker is kept.
  try {
    const paid = await d.call("listing_pay", { id: listingId }, { "x402/payment": s.payload }, true);
    const o = readPaidAnswer(paid, { network: NETWORK });
    if (o.word === "settled") { d.store.release(); return { outcome: "settled", ...shown, transaction: o.signature! }; }
    if (o.word === "unknown" && o.pending) return unknown(PENDING_WORDS, { signature: o.pending, ...(o.reference ? { reference: o.reference } : {}) }, { pending: o.pending });   // sent, not final: never refused, never paid again
    return unknown(o.word === "unknown" ? "the outcome is unknown; check the chain before any new payment" : "the service did not confirm the payment; check the wallet before any new payment",
      { ...(o.signature ? { signature: o.signature } : {}), ...(o.reference ? { reference: o.reference } : {}) });
  } catch { return unknown("no clear answer after signing; the payment may have been sent; check the chain"); }
}
