// The own-key path: pay ANY verified, payable Marketplace listing from YOUR OWN Solana wallet, within YOUR OWN cap (default 0.01 USDC). Non-custodial: Payzilla never sees the key.
//   node services/mcp-payer/src/own.ts <listing id> [--cap <USDC, at most 1>]
//   node services/mcp-payer/src/own.ts clear      after an unknown outcome, at a terminal only (the same clear as main.ts, on this path's own state)
// The same rule as the payer tool (payer.ts: listing checks, the terms must name the listing's registered wallet and price, marker, repeat guard, safe receipt), with a local signer.
// What the check protects: a 402 that differs from the listing. What it does NOT: the listing and the 402 both come from Payzilla's server, so a compromised server could name another
// wallet in both. Compare the printed payee with the seller yourself (out of band) before you type PAY.
// The key is typed at a hidden prompt only (never an argument, an environment variable or a file) and lives in memory for one signature. State: ~/.payzilla-payer/own (apart from the payer tool's).
import { homedir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain node module (no types)
import { analyzePaymentTransaction, signerFromText, USDC_MINT } from "./lib/x402-client.mjs";
import { callTool } from "./lib/mcp-client.ts";
import { createPrompts } from "./lib/hidden-prompt.mjs";
import { isMain } from "./lib/main-guard.ts";
import { clear, fileStore, terminalClearIo } from "./store.ts";
import { isObj, MCP_URL, payListing, priceMinor, RESOURCE, UUID, type Allowed, type Call, type Signer } from "./payer.ts";

export const DEFAULT_CAP_MINOR = 10_000n, MAX_CAP_MINOR = 1_000_000n;   // 0.01 USDC by default; never above the MCP service's 1 USDC per payment
/** Payzilla's mainnet fee payer (public on chain). A 402 naming another fee payer is refused before anything is built. */
export const PAYZILLA_FEE_PAYER = "CE9TKZjh9yQY1NtdZ3MJUByaN41E49NRt1QE4DQW8M1f";
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** USDC minor units as text a person reads: 10000 -> "0.01". Pure. */
export const usdcText = (minor: bigint): string => `${minor / 1_000_000n}.${(minor % 1_000_000n).toString().padStart(6, "0").replace(/0{1,4}$/, "")}`;

/** `<listing id> [--cap <USDC>]` -> the listing id and the cap in minor units, or why not. Pure. */
export function parseOwnArgs(argv: readonly string[]): { id: string; capMinor: bigint } | string {
  const [id, flag, cap, ...rest] = argv;
  if (typeof id !== "string" || !UUID.test(id) || rest.length > 0 || (flag !== undefined && flag !== "--cap")) return "usage: node services/mcp-payer/src/own.ts <listing id> [--cap <USDC, at most 1>]";
  if (flag === undefined) return { id, capMinor: DEFAULT_CAP_MINOR };
  const c = priceMinor(cap);
  return c !== null && c > 0n && c <= MAX_CAP_MINOR ? { id, capMinor: c } : "the cap must be a USDC amount above 0 and at most 1";
}

/** The rule for ONE listing, read from the listing itself: its registered wallet (payTo on marketplace_get_listing), its price, and the user's cap. null when the listing names no wallet or price. */
export async function ruleFor(call: Call, id: string, capMinor: bigint): Promise<{ rule: Allowed; priceMinor: bigint } | null> {
  const r = await call("marketplace_get_listing", { id });
  const l = isObj(r["structuredContent"]) ? r["structuredContent"]["listing"] : undefined;
  const price = isObj(l) ? priceMinor(l["priceUsdc"]) : null;
  if (!isObj(l) || l["id"] !== id || typeof l["payTo"] !== "string" || !B58.test(l["payTo"]) || price === null) return null;
  return { rule: { listingId: id, label: `listing ${id.slice(0, 8)}`, payee: l["payTo"], maxMinor: capMinor }, priceMinor: price };
}
/** The word the person types to pay: tied to the amount, so a confirmation for another amount does not match. Pure. */
export const payWord = (priceMinor: bigint): string => `PAY ${usdcText(priceMinor)}`;

export interface OwnTools {
  create(accept: Record<string, unknown>): Promise<string>;                                              // the signed transaction (base64), from the official x402 Solana client
  analyze(tx: string, exp: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }>;         // the local check of the bytes about to be sent (four instructions, amount, payee, memo, our signature)
  payer: string;
}
/** A Signer over the user's own key. Signing is local and nothing is sent here, so every failure is a refusal (no payment can exist). */
export function ownSigner(t: OwnTools): Signer {
  return {
    async sign(accept, resource) {
      const x = isObj(accept["extra"]) ? accept["extra"] : {};
      if (accept["payTo"] === t.payer) return { kind: "refused", reason: "the payee is your own wallet" };
      if (x["feePayer"] !== PAYZILLA_FEE_PAYER) return { kind: "refused", reason: "the fee payer is not Payzilla's" };
      let tx: string;
      try { tx = await t.create(accept); } catch { return { kind: "refused", reason: "the payment could not be built (the Solana RPC or the wallet)" }; }
      const ok = await t.analyze(tx, { payer: t.payer, feePayer: PAYZILLA_FEE_PAYER, payTo: accept["payTo"], mint: USDC_MINT, amount: BigInt(String(accept["amount"])), memo: x["memo"] });
      if (!ok.ok) return { kind: "refused", reason: "the signed payment failed the local check" };
      return { kind: "signed", payload: { x402Version: 2, resource: isObj(resource) ? resource : { url: RESOURCE }, accepted: accept, payload: { transaction: tx } } };
    },
  };
}

/** The real tools over a key signer (signerFromText): the official x402 Solana client builds the payment, the local check reads its bytes. */
export async function ownTools(signer: { address: unknown }): Promise<OwnTools> {
  const { ExactSvmScheme } = await import("@x402/svm/exact/client");
  return {
    payer: String(signer.address),
    create: async (accept) => String(((await new ExactSvmScheme(signer as never, { rpcUrl: "https://api.mainnet-beta.solana.com" }).createPaymentPayload(2, accept as never)) as { payload?: { transaction?: unknown } }).payload?.transaction),
    analyze: (tx, exp) => analyzePaymentTransaction(tx, exp),
  };
}

export const OWN_DIR = join(homedir(), ".payzilla-payer", "own");
const short = (a: string): string => `${a.slice(0, 4)}…${a.slice(-4)}`;
if (isMain(import.meta.url) && process.argv[2] === "clear") {
  process.exitCode = await clear(fileStore(OWN_DIR), terminalClearIo(), "your wallet");
} else if (isMain(import.meta.url)) {
  const a = parseOwnArgs(process.argv.slice(2));
  if (typeof a === "string") { process.stderr.write(`${a}\n`); process.exit(2); }
  const { id, capMinor } = a;
  let n = 100;
  const call: Call = (name, args, meta, fresh = false) => callTool({ fetch }, { mcpUrl: MCP_URL, timeoutMs: fresh ? 60_000 : 10_000 }, n++, name, args, meta, fresh ? 60_000 : 10_000, fresh);
  const prompts = createPrompts({ refuse: (t) => Object.assign(new Error(t), { refusal: true }), cancelled: () => Object.assign(new Error("Cancelled."), { refusal: true }) });
  let paying = false;   // false: nothing can have been signed or sent; true: payListing runs and decides (marker, unknown)
  (async () => {
    const found = await ruleFor(call, id, capMinor).catch(() => null);
    if (!found) { process.stderr.write("STOP: the listing was not found, or it names no wallet or price. Nothing was signed or sent.\n"); return 1; }
    const { rule, priceMinor: price } = found;
    process.stdout.write(`Listing   ${id}\nPrice     ${usdcText(price)} USDC\nPays      ${short(rule.payee)}  (full: ${rule.payee}; compare it with the seller yourself)\nYour cap  ${usdcText(capMinor)} USDC\nSolana mainnet, real money, cannot be undone.\n`);
    if (price > capMinor) { process.stdout.write(`The price is above your cap: nothing was signed. Pay it yourself with the pay link: https://paywith.payzilla.ai/p/${id}\n`); return 1; }
    let text: string | null = await prompts.readSecret("Your wallet's secret key (hidden; base58 or the 64-number array): ");
    const signer = await signerFromText(text, { jsonOnly: false }); text = null;
    const word = payWord(price);
    if ((await prompts.readLine(`Type ${word} to pay (anything else cancels): `))?.trim() !== word) { process.stderr.write("Cancelled. Nothing was signed or sent.\n"); return 1; }
    const tools = await ownTools(signer);
    paying = true;
    const answer = await payListing({ allow: [rule], store: fileStore(OWN_DIR), signer: ownSigner(tools), call, now: Date.now, enabled: () => true }, id);
    process.stdout.write(`${JSON.stringify(answer, null, 1)}\n${answer.transaction ? `https://solscan.io/tx/${answer.transaction}\n` : ""}`);
    return answer.outcome === "settled" ? 0 : 1;
  })().then((code) => { process.exitCode = code; }, (e: unknown) => {
    const refusal = (e as { refusal?: boolean } | null)?.refusal === true ? `${(e as Error).message} ` : "";
    process.stderr.write(paying ? "STOP: an error during the payment. A payment may have been sent: check your wallet on Solscan before trying again, then run clear.\n" : `STOP: ${refusal}Nothing was signed or sent.\n`);
    process.exitCode = 1;
  });
}
