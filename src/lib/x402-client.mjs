// The x402 client checks of the Payzilla payers: pure helpers, no I/O of their own.
// A refusal carries a FIXED text: never a library message, a path, a key or a server text. The key handling (signerFromText) zeroes its byte buffers; the input string cannot be zeroed.
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const MEMO_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // the classic Token program only: mainnet USDC is a classic token, Token-2022 is refused
// What the x402 client library (@x402/svm 2.28.0) really sets: compute unit limit 20000, price 1 micro-lamport. The caps below leave small headroom.
const MAX_UNIT_LIMIT = 40000, MAX_UNIT_PRICE = 100n;
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const ACCEPT_KEYS = ["scheme", "network", "asset", "payTo", "amount", "maxTimeoutSeconds", "extra"];

/** A refusal carries a FIXED text chosen in this file: never a library message, a path, a key or a server text. */
export class Refusal extends Error { constructor(text, code = 1) { super(text); this.refusal = true; this.code = code; } }
const refuse = (t, code = 1) => { throw new Refusal(t, code); };

export function formatUsdc(minor) {
  const s = BigInt(minor).toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6).replace(/0+$/, "").padEnd(2, "0")}`;
}

export const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** Pure check of the decoded 402 against the fixed terms. Returns the accepted entry (as received) or throws a Refusal. The payer-dependent checks come later. */
export function validateChallenge(pr, c) {
  const bad = (what) => refuse(`REFUSING: the endpoint's answer is not what this script pays (${what}). Nothing was signed.`);
  if (!isObj(pr) || pr.x402Version !== 2) bad("not an x402 version 2 challenge");
  if (!Array.isArray(pr.accepts) || pr.accepts.length !== 1 || !isObj(pr.accepts[0])) bad("not exactly one offer");
  const a = pr.accepts[0];
  if (Object.keys(a).some((k) => !ACCEPT_KEYS.includes(k))) bad("the offer has an unknown field");
  if (a.scheme !== "exact") bad("scheme is not exact");
  if (a.network !== c.network) bad("network is not Solana mainnet");
  if (a.asset !== c.mint) bad("token is not mainnet USDC");
  if (a.payTo !== c.expectedPayTo) bad("the receiving wallet is not the expected wallet");
  if (typeof a.amount !== "string" || !/^[1-9]\d{0,17}$/.test(a.amount)) bad("the amount is not a plain whole number");
  if (BigInt(a.amount) > c.capMinor) bad(`the amount is above the ${formatUsdc(c.capMinor)} USDC cap`);
  if (a.maxTimeoutSeconds !== undefined && !(Number.isInteger(a.maxTimeoutSeconds) && a.maxTimeoutSeconds >= 1 && a.maxTimeoutSeconds <= 600)) bad("the timeout is not usable");
  const x = a.extra;
  if (!isObj(x)) bad("no extra");
  const keys = Object.keys(x).sort().join();
  if (keys !== "feePayer,memo" && keys !== "feePayer,memo,paymentFlow") bad("extra has an unknown or missing field");
  if (typeof x.memo !== "string" || !MEMO_RE.test(x.memo)) bad("the memo is not a payment id");
  if (x.paymentFlow !== undefined && x.paymentFlow !== "upfront") bad("unknown payment flow");
  if (typeof x.feePayer !== "string" || !B58.test(x.feePayer)) bad("the fee payer is not an address");
  if (x.feePayer === a.payTo || x.feePayer === a.asset) bad("the fee payer is the payee or the token");
  if (pr.resource !== undefined) {
    const r = pr.resource;
    if (!isObj(r) || r.url !== c.url || Object.keys(r).some((k) => !["url", "description", "mimeType"].includes(k)) || Object.values(r).some((v) => typeof v !== "string")) bad("the resource is not this endpoint");
  }
  return a;
}

/** text -> a non-extractable signer. Accepts the 64-number JSON array or the base58 of the 64 secret key bytes. Every failure is the same fixed sentence. */
export async function signerFromText(text, { jsonOnly }) {
  const kit = await import("@solana/kit");
  let bytes = null;
  try {
    const t = text.trim();
    if (t.startsWith("[")) {
      const arr = JSON.parse(t);
      if (!Array.isArray(arr) || arr.length !== 64 || arr.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) throw 0;
      bytes = Uint8Array.from(arr); arr.fill(0);
    } else if (!jsonOnly) {
      bytes = Uint8Array.from(kit.getBase58Encoder().encode(t));
      if (bytes.length !== 64) throw 0;
    } else throw 0;
    return await kit.createKeyPairSignerFromBytes(bytes);
  } catch { refuse("the secret key is not valid (expected the base58 of a 64 byte Solana secret key, or an array of 64 numbers). Nothing was sent."); }
  finally { if (bytes) bytes.fill(0); }
}

// ---------------------------------------------------------------- the local analysis of the signed transaction
/** An own check (not the facilitator's code) on the bytes about to be sent: exactly 4 instructions (compute limit, compute price, one classic-Token TransferChecked, one memo) and nothing else, fee payer slot unsigned, your signature valid.
 *  exp = { payer, feePayer, payTo, mint, amount (bigint), memo, destAta? }. Returns { ok: true } or { ok: false, reason }. */
export async function analyzePaymentTransaction(b64, exp) {
  const no = (reason) => ({ ok: false, reason });
  try {
    const kit = await import("@solana/kit");
    const { parseSetComputeUnitLimitInstruction, parseSetComputeUnitPriceInstruction } = await import("@solana-program/compute-budget");
    const { parseTransferCheckedInstruction } = await import("@solana-program/token");
    const { findAssociatedTokenPda } = await import("@solana-program/token-2022");
    const tx = kit.getTransactionDecoder().decode(kit.getBase64Encoder().encode(b64));
    const compiled = kit.getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const accts = compiled.staticAccounts.map(String);
    if (accts[0] !== exp.feePayer) return no("the fee payer of the transaction is not the one named by the endpoint");
    if (compiled.header.numSignerAccounts !== 2 || accts[1] !== exp.payer) return no("the transaction is not signed by exactly the fee payer and you");
    if ((compiled.addressTableLookups?.length ?? 0) !== 0) return no("the transaction uses address lookup tables");
    const sigs = tx.signatures;
    if (sigs[exp.feePayer] != null) return no("the fee payer slot is already signed");
    const mine = sigs[exp.payer];
    if (!mine || mine.length !== 64) return no("your signature is missing");
    const pub = await crypto.subtle.importKey("raw", kit.getAddressEncoder().encode(exp.payer), "Ed25519", false, ["verify"]);
    if (!(await kit.verifySignature(pub, mine, tx.messageBytes))) return no("your signature does not verify");
    const ixs = kit.decompileTransactionMessage(compiled).instructions;
    if (ixs.length !== 4) return no("the transaction does not have exactly four instructions");
    const [limit, price, transfer, memo] = ixs;
    if (String(limit.programAddress) !== COMPUTE_BUDGET_PROGRAM || (limit.accounts?.length ?? 0) !== 0 || limit.data?.length !== 5 || limit.data[0] !== 2) return no("instruction 1 is not a compute limit");
    if (parseSetComputeUnitLimitInstruction(limit).data.units > MAX_UNIT_LIMIT) return no("the compute limit is too high");
    if (String(price.programAddress) !== COMPUTE_BUDGET_PROGRAM || (price.accounts?.length ?? 0) !== 0 || price.data?.length !== 9 || price.data[0] !== 3) return no("instruction 2 is not a compute price");
    if (parseSetComputeUnitPriceInstruction(price).data.microLamports > MAX_UNIT_PRICE) return no("the compute price is too high");
    const program = String(transfer.programAddress);
    if (program !== TOKEN_PROGRAM) return no("instruction 3 is not a transfer in the classic Token program");
    if (!transfer.data || transfer.data[0] !== 12 || transfer.accounts.length !== 4) return no("instruction 3 is not one TransferChecked");
    const t = parseTransferCheckedInstruction(transfer);
    if (String(t.accounts.authority.address) !== exp.payer) return no("the transfer is not authorised by you only");
    if (String(t.accounts.mint.address) !== exp.mint) return no("the transfer is not in USDC");
    if (t.data.amount !== exp.amount) return no("the transfer amount is not the agreed amount");
    if (t.data.decimals !== 6) return no("the token does not have 6 decimals");
    const [dest] = await findAssociatedTokenPda({ mint: exp.mint, owner: exp.payTo, tokenProgram: program });
    if (String(t.accounts.destination.address) !== String(dest)) return no("the transfer does not go to the payee's USDC account");
    if (exp.destAta !== undefined && String(dest) !== exp.destAta) return no("the payee's USDC account is not the expected one");
    const [src] = await findAssociatedTokenPda({ mint: exp.mint, owner: exp.payer, tokenProgram: program });
    if (String(t.accounts.source.address) !== String(src)) return no("the transfer does not come from your USDC account");
    if (String(memo.programAddress) !== MEMO_PROGRAM || (memo.accounts?.length ?? 0) !== 0) return no("instruction 4 is not a plain memo");
    if (new TextDecoder("utf-8", { fatal: true }).decode(memo.data) !== exp.memo) return no("the memo is not the payment id");
    return { ok: true };
  } catch { return no("the transaction could not be read"); }
}
