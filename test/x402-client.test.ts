import { getBase58Decoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain node module (no types)
import { NETWORK, USDC_MINT, validateChallenge } from "../src/lib/x402-client.mjs";

// A payment-id-shaped memo, built at run time so no uuid sits in the file.
const MEMO = ["01a17539", "aaaa", "4bbb", "8ccc", "ddddeeeeffff"].join("-");
// A payee built at run time: no real wallet address sits in a file that goes public.
const PAYEE = getBase58Decoder().decode(new Uint8Array(32).fill(9)), FEE = "CE9TKZjh9yQY1NtdZ3MJUByaN41E49NRt1QE4DQW8M1f";
const terms = (o: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ x402Version: 2, accepts: [{ scheme: "exact", network: NETWORK, asset: USDC_MINT, payTo: PAYEE, amount: "10000", maxTimeoutSeconds: 60, extra: { feePayer: FEE, memo: MEMO, ...extra }, ...o }] });
const c = { network: NETWORK, mint: USDC_MINT, expectedPayTo: PAYEE, capMinor: 10_000n, url: "mcp://tool/listing_pay" };
const why = (pr: unknown): string => { try { validateChallenge(pr, c); return "ok"; } catch (e) { return (e as Error).message; } };

describe("the shared x402 checks use neutral words (they serve any payee, not only Payzilla's donation)", () => {
  it("a wrong payee or a memo that is not a payment id: refused, in words that name no Payzilla wallet", () => {
    expect(why(terms())).toBe("ok");
    expect(why(terms({ payTo: FEE }))).toContain("the receiving wallet is not the expected wallet");
    expect(why(terms({}, { memo: "not-a-uuid" }))).toContain("the memo is not a payment id");
    for (const m of [why(terms({ payTo: FEE })), why(terms({}, { memo: "x" }))]) expect(m).not.toMatch(/donation|intent id/i);
  });
});
