import { describe, expect, it } from "vitest";
import { DEFAULT_CAP_MINOR, MAX_CAP_MINOR, PAYZILLA_FEE_PAYER, ownSigner, parseOwnArgs, payWord, ruleFor, usdcText, type OwnTools } from "../src/own.ts";
import { payListing } from "../src/payer.ts";
import { newWallet } from "../src/small-wallet.ts";
import { addr, ID, MEMO, memStore, OTHER, short } from "./fixtures.ts";

const NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SELLER = addr(9), FEE = "CE9TKZjh9yQY1NtdZ3MJUByaN41E49NRt1QE4DQW8M1f", ME = newWallet().address, SIG = "5".repeat(88);
const detail = (o: Record<string, unknown> = {}) => ({ structuredContent: { listing: { id: ID, name: "Weather", priceUsdc: "0.01", verified: true, payable: true, serviceHost: "paywith.payzilla.ai", network: NET, asset: USDC, payToShort: short(SELLER), payTo: SELLER, ...o } } });
const terms = (o: Record<string, unknown> = {}) => ({ isError: true, structuredContent: { x402Version: 2, resource: { url: "mcp://tool/listing_pay" }, accepts: [{ scheme: "exact", network: NET, asset: USDC, payTo: SELLER, amount: "10000", maxTimeoutSeconds: 60, extra: { feePayer: FEE, memo: MEMO }, ...o }] } });
const accept = (o: Record<string, unknown> = {}) => ({ scheme: "exact", network: NET, asset: USDC, payTo: SELLER, amount: "10000", extra: { feePayer: FEE, memo: MEMO }, ...o });
const tools = (o: Partial<OwnTools> = {}): OwnTools & { built: () => number; checked: Record<string, unknown>[] } => {
  let built = 0; const checked: Record<string, unknown>[] = [];
  return { payer: ME, create: async () => { built++; return "AQ".repeat(80); }, analyze: async (_tx: string, exp: Record<string, unknown>) => { checked.push(exp); return { ok: true }; }, ...o, built: () => built, checked } as OwnTools & { built: () => number; checked: Record<string, unknown>[] };
};

describe("own-key path: any verified listing, the user's own wallet and cap", () => {
  it("arguments: a listing id and an optional cap, default 0.01, never above 1 USDC", () => {
    expect(parseOwnArgs([ID])).toEqual({ id: ID, capMinor: DEFAULT_CAP_MINOR }); expect(DEFAULT_CAP_MINOR).toBe(10_000n);
    expect(parseOwnArgs([ID, "--cap", "0.25"])).toEqual({ id: ID, capMinor: 250_000n });
    expect(parseOwnArgs([ID, "--cap", "1"])).toEqual({ id: ID, capMinor: MAX_CAP_MINOR });
    for (const a of [[], ["nope"], [ID, "--cap", "1.01"], [ID, "--cap", "0"], [ID, "--cap"], [ID, "--key", "x"], [ID, "--key", "0.5"], [ID, "--max", "0.01"], [ID, "--cap", "0.1", "extra"]]) expect(typeof parseOwnArgs(a), JSON.stringify(a)).toBe("string");
  });
  it("the rule comes from the listing itself: its registered wallet (payTo) and the user's cap; no payTo means no rule", async () => {
    expect(await ruleFor(async () => detail(), ID, 10_000n)).toEqual({ rule: { listingId: ID, label: "listing 0b6e1f4a", payee: SELLER, maxMinor: 10_000n }, priceMinor: 10_000n });
    for (const o of [{ payTo: undefined }, { payTo: "not a wallet!" }, { id: OTHER }, { priceUsdc: "1e-2" }]) expect(await ruleFor(async () => detail(o), ID, 10_000n), JSON.stringify(o)).toBeNull();
  });
  it("the words a person sees: the amount in USDC, and a confirmation tied to it", () => {
    expect([usdcText(10_000n), usdcText(500_000n), usdcText(1_000_000n), usdcText(1n)]).toEqual(["0.01", "0.50", "1.00", "0.000001"]);
    expect(payWord(10_000n)).toBe("PAY 0.01"); expect(payWord(500_000n)).toBe("PAY 0.50");
  });
  it("the signer: builds and checks locally; any failure is a refusal (nothing sent); never pays itself or uses itself as the fee payer", async () => {
    const t0 = tools();
    expect((await ownSigner(t0).sign(accept(), { url: "mcp://tool/listing_pay" }))).toMatchObject({ kind: "signed", payload: { x402Version: 2, accepted: accept(), payload: { transaction: "AQ".repeat(80) } } });
    expect(t0.checked).toEqual([{ payer: ME, feePayer: PAYZILLA_FEE_PAYER, payTo: SELLER, mint: USDC, amount: 10_000n, memo: MEMO }]);   // the local check gets the values the terms promised
    expect((await ownSigner(tools({ create: async () => { throw new Error("rpc"); } })).sign(accept(), {})).kind).toBe("refused");
    expect((await ownSigner(tools({ analyze: async () => ({ ok: false, reason: "x" }) })).sign(accept(), {})).kind).toBe("refused");
    for (const a of [accept({ payTo: ME }), accept({ extra: { feePayer: ME, memo: "m" } }), accept({ extra: { feePayer: SELLER, memo: "m" } })]) { const t = tools(); expect((await ownSigner(t).sign(a, {})).kind, JSON.stringify(a)).toBe("refused"); expect(t.built()).toBe(0); }
    expect(PAYZILLA_FEE_PAYER).toBe(FEE);
  });
  it("end to end with fakes: pays any seller's listing within the cap; the terms must name the listing's own wallet; above the cap the pay link", async () => {
    const run = async (o: { detail?: Record<string, unknown>; terms?: Record<string, unknown>; cap?: bigint } = {}) => {
      const calls: string[] = [];
      const call = async (name: string, _a: Record<string, unknown>, meta?: Record<string, unknown>) => { calls.push(meta ? "paid" : name); return name === "marketplace_get_listing" ? (o.detail ?? detail()) : meta ? { content: [], _meta: { "x402/payment-response": { success: true, transaction: SIG, network: NET } } } : (o.terms ?? terms()); };
      const rule = (await ruleFor(call, ID, o.cap ?? 10_000n))!.rule;
      return { answer: await payListing({ allow: [rule], store: memStore(), signer: ownSigner(tools()), call, now: () => 1, enabled: () => true }, ID), calls };
    };
    expect((await run()).answer).toMatchObject({ outcome: "settled", transaction: SIG, listing: "listing 0b6e1f4a" });
    const other = await run({ terms: terms({ payTo: FEE }) }); expect(other.answer.outcome).toBe("refused"); expect(other.calls).not.toContain("paid");
    expect((await run({ detail: detail({ priceUsdc: "0.50" }) })).answer).toMatchObject({ outcome: "needs approval", payLink: `https://paywith.payzilla.ai/p/${ID}` });
    expect((await run({ detail: detail({ priceUsdc: "0.50" }), terms: terms({ amount: "500000" }), cap: 500_000n })).answer.outcome).toBe("settled");
  });
});
