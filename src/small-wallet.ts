// A small, separate wallet for an assistant to pay from: its key is made here and kept only in the operating system's keychain (keychain.ts).
//   node services/mcp-payer/src/small-wallet.ts init                      make a NEW wallet; refuses if one exists. Prints only its address.
//   node services/mcp-payer/src/small-wallet.ts address                   print the address and the balances
//   node services/mcp-payer/src/small-wallet.ts withdraw <address> <USDC> send USDC out, after the typed WITHDRAW <amount> <first4...last4>
//   node services/mcp-payer/src/small-wallet.ts remove                    delete the key; refuses while USDC is left, unless REMOVE AND LOSE <balance> is typed
// Put in only what you are ready to lose. Payments need no SOL (Payzilla's fee payer pays their fee); a withdrawal pays its own fee (and a new USDC account for the address, if it has none),
// so keep about 0.003 SOL in the wallet for it. The address is always derived from the stored key; no address file is kept.
// Memory: byte arrays are zeroed after use (best effort); text cannot be zeroed in JavaScript.
import { generateKeyPairSync } from "node:crypto";
import { appendTransactionMessageInstructions, createKeyPairSignerFromBytes, createSolanaRpc, createTransactionMessage, getBase58Decoder, getBase58Encoder, getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners, type Address, type Blockhash } from "@solana/kit";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
// @ts-expect-error plain node module (no types)
import { USDC_MINT } from "./lib/x402-client.mjs";
import { createPrompts } from "./lib/hidden-prompt.mjs";
import { isMain } from "./lib/main-guard.ts";
import { KeychainError, systemKeychain, type Keychain } from "./keychain.ts";
import { priceMinor } from "./payer.ts";

/** The rent of a new USDC account (165 bytes), one signature fee, and the smallest SOL balance a wallet may keep (rent-exempt minimum of an empty account), in lamports. */
export const ATA_RENT_LAMPORTS = 2_039_280n, FEE_LAMPORTS = 5_000n, RENT_EXEMPT_MIN_LAMPORTS = 890_880n;
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const short = (a: string): string => `${a.slice(0, 4)}...${a.slice(-4)}`;   // ASCII only: any console can type it
/** Where a damaged key can be deleted by hand. */
export const MANUAL_DELETE = "macOS: Keychain Access, or Linux: Passwords and Keys, the item payzilla-payer / wallet; Windows: the file %LOCALAPPDATA%\\payzilla-payer\\wallet.dpapi";
/** USDC minor units as text: 10000 -> "0.01". Pure. */
export const usdc = (minor: bigint): string => `${minor / 1_000_000n}.${(minor % 1_000_000n).toString().padStart(6, "0").replace(/0{1,4}$/, "")}`;

/** A NEW Ed25519 keypair as Solana stores it: the base58 of the 64 bytes (seed then public key), and the address. The byte buffers are zeroed (best effort). */
export function newWallet(): { secret: string; address: string } {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const seed = Buffer.from(String(jwk.d), "base64url"), pub = Buffer.from(String(jwk.x), "base64url");
  const bytes = new Uint8Array(64); bytes.set(seed, 0); bytes.set(pub, 32);
  const b58 = getBase58Decoder();
  const out = { secret: b58.decode(bytes), address: b58.decode(pub) };
  bytes.fill(0); seed.fill(0);
  return out;
}
/** The address of a stored key (the key is the source of truth; no address file is kept). */
export async function addressOf(secret: string): Promise<string> {
  const bytes = new Uint8Array(getBase58Encoder().encode(secret));
  try { return (await createKeyPairSignerFromBytes(bytes)).address; } finally { bytes.fill(0); }
}
/** SOL rule of a withdrawal: the wallet pays the fee, and the new USDC account if the address has none; what is left must be 0 or at least the rent-exempt minimum. Pure. */
export function solRefusal(lamports: bigint, destinationExists: boolean): string | null {
  const cost = FEE_LAMPORTS + (destinationExists ? 0n : ATA_RENT_LAMPORTS), left = lamports - cost;
  return left < 0n || (left > 0n && left < RENT_EXEMPT_MIN_LAMPORTS) ? "the wallet needs a little more SOL for this withdrawal (about 0.003 SOL): send some to it first" : null;
}

/** The wallet's own USDC account (its associated token account for mainnet USDC). */
export const usdcAccount = async (owner: string): Promise<string> => (await findAssociatedTokenPda({ owner: owner as Address, mint: USDC_MINT as Address, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

export interface Chain {
  tokenBalance(account: string): Promise<bigint | null>;   // one token account's balance; null if the account does not exist
  lamports(owner: string): Promise<bigint>;
  owner(account: string): Promise<string | null>;          // the program that owns an account; null if there is none
  blockhash(): Promise<{ blockhash: Blockhash; lastValidBlockHeight: bigint }>;
  send(wireBase64: string): Promise<void>;
  status(signature: string): Promise<"confirmed" | "failed" | "unknown">;
}
export type Outcome =
  | { outcome: "ok"; address?: string }
  | { outcome: "confirmed"; signature: string }
  | { outcome: "submitted"; signature: string }   // sent, or maybe sent, and NOT confirmed: check the link before any new try
  | { outcome: "failed"; signature: string }      // it landed and failed: nothing moved; the fee was spent
  | { outcome: "refused"; reason: string };
const refused = (reason: string): Outcome => ({ outcome: "refused", reason });
const kcWords = (e: unknown): string => (e instanceof KeychainError ? (e.word === "empty" ? "there is no wallet in the keychain (run init)" : e.word === "exists" ? "a wallet already exists in the keychain" : "the keychain could not be used (unlock it, or install its tool)") : "the keychain could not be used");

/** init: a NEW wallet, only when the keychain holds none; the stored key is READ BACK and compared before the address is shown. */
export async function initWallet(kc: Keychain): Promise<Outcome> {
  let w: { secret: string; address: string };
  try {
    if (await kc.exists()) return refused("a wallet already exists in the keychain: withdraw and remove it first");
    w = newWallet();
    await kc.add(w.secret);
  } catch (e) { return refused(kcWords(e)); }
  let back: string | null = null;
  try { back = await kc.read(); } catch { /* compared below */ }
  if (back !== w.secret) {   // the new key was never shown or funded: delete it, or say how to
    try { await kc.remove(); } catch { return refused(`the key could not be read back and could not be deleted; it was never shown or funded. Delete it by hand (${MANUAL_DELETE}), then run init again`); }
    return refused("the key could not be stored and read back; no wallet was made (run init again later)");
  }
  return { outcome: "ok", address: w.address };
}

/** withdraw: ONE USDC transfer out, to a WALLET address the person typed, after the typed confirmation. The wallet pays the fee (and the new USDC account, if the address has none). */
export async function withdraw(o: { kc: Keychain; chain: Chain; to: string; amountMinor: bigint; ask: (prompt: string) => Promise<string | null>; wait?: (ms: number) => Promise<void> }): Promise<Outcome> {
  if (!B58.test(o.to)) return refused("the address is not a Solana address");
  if (o.amountMinor <= 0n) return refused("the amount must be above 0");
  let secret: string;
  try { secret = await o.kc.read(); } catch (e) { return refused(kcWords(e)); }
  const bytes = new Uint8Array(getBase58Encoder().encode(secret));
  let signature: string | null = null;
  try {
    const signer = await createKeyPairSignerFromBytes(bytes);
    if (o.to === signer.address) return refused("that is this wallet's own address");
    const toOwner = await o.chain.owner(o.to);
    if (toOwner !== null && toOwner !== SYSTEM_PROGRAM) return refused("that address is not a wallet (it is an account of a program, for example a token account): give a wallet address");
    const mint = USDC_MINT as Address, tokenProgram = TOKEN_PROGRAM_ADDRESS;
    const [source] = await findAssociatedTokenPda({ owner: signer.address, mint, tokenProgram });
    const [destination] = await findAssociatedTokenPda({ owner: o.to as Address, mint, tokenProgram });
    const balance = (await o.chain.tokenBalance(source)) ?? 0n;
    if (o.amountMinor > balance) return refused(`the wallet holds ${usdc(balance)} USDC, less than ${usdc(o.amountMinor)}`);
    const sol = solRefusal(await o.chain.lamports(signer.address), (await o.chain.owner(destination)) !== null);
    if (sol) return refused(sol);
    const word = `WITHDRAW ${usdc(o.amountMinor)} ${short(o.to)}`;
    if ((await o.ask(`Send ${usdc(o.amountMinor)} USDC from ${signer.address} to ${o.to}. Type ${word} to send (anything else cancels): `).catch(() => null))?.trim() !== word) return refused("cancelled; nothing was sent");
    const bh = await o.chain.blockhash();
    const msg = pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(signer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
      (m) => appendTransactionMessageInstructions([
        getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: destination, owner: o.to as Address, mint, tokenProgram }),
        getTransferCheckedInstruction({ source, mint, destination, authority: signer, amount: o.amountMinor, decimals: 6 }, { programAddress: tokenProgram }),
      ], m));
    const tx = await signTransactionMessageWithSigners(msg);
    signature = getSignatureFromTransaction(tx);
    try { await o.chain.send(getBase64EncodedWireTransaction(tx)); } catch { return { outcome: "submitted", signature }; }   // maybe sent: never "ok", never a second try here
    const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 0; i < 5; i++) {
      await wait(2_000);
      const s = await o.chain.status(signature).catch(() => "unknown" as const);
      if (s === "confirmed") return { outcome: "confirmed", signature };
      if (s === "failed") return { outcome: "failed", signature };
    }
    return { outcome: "submitted", signature };
  } catch { return signature ? { outcome: "submitted", signature } : refused("the withdrawal could not be built; nothing was sent"); }
  finally { bytes.fill(0); }
}

/** remove: delete the key. The balance is read for the key's OWN address (no file is trusted). Refused while USDC is left or the balance is unknown, unless the person types REMOVE AND LOSE <balance>. */
export async function removeWallet(o: { kc: Keychain; chain: Chain; ask: (prompt: string) => Promise<string | null> }): Promise<Outcome> {
  let secret: string;
  try { if (!(await o.kc.exists())) return { outcome: "ok" }; secret = await o.kc.read(); } catch (e) { return refused(`${kcWords(e)}; to delete a damaged key by hand: ${MANUAL_DELETE}`); }
  let left: bigint | null = null;
  try { left = (await o.chain.tokenBalance(await usdcAccount(await addressOf(secret)))) ?? 0n; } catch { left = null; }
  if (left === null || left > 0n) {
    const word = `REMOVE AND LOSE ${left === null ? "UNKNOWN" : usdc(left)}`;
    if ((await o.ask(`The wallet holds ${left === null ? "an amount that could not be read:" : `${usdc(left)} USDC:`} withdraw it first. Any SOL or other tokens in it are lost too. To delete the key anyway and lose it all, type ${word}: `).catch(() => null))?.trim() !== word) return refused("kept; withdraw first");
  }
  try { await o.kc.remove(); } catch (e) { return refused(kcWords(e)); }
  return { outcome: "ok" };
}

export function liveChain(rpcUrl = "https://api.mainnet-beta.solana.com"): Chain {
  const rpc = createSolanaRpc(rpcUrl);
  const deadline = () => AbortSignal.timeout(10_000);
  return {
    async tokenBalance(account) { try { return BigInt((await rpc.getTokenAccountBalance(account as Address, { commitment: "confirmed" }).send({ abortSignal: deadline() })).value.amount); } catch (e) { if ((await rpc.getAccountInfo(account as Address, { encoding: "base64", commitment: "confirmed" }).send({ abortSignal: deadline() })).value === null) return null; throw e; } },
    async lamports(owner) { return BigInt((await rpc.getBalance(owner as Address, { commitment: "confirmed" }).send({ abortSignal: deadline() })).value); },
    async owner(account) { const v = (await rpc.getAccountInfo(account as Address, { encoding: "base64", commitment: "confirmed" }).send({ abortSignal: deadline() })).value; return v === null ? null : String(v.owner); },
    async blockhash() { return (await rpc.getLatestBlockhash({ commitment: "confirmed" }).send({ abortSignal: deadline() })).value; },
    async send(wire) { await rpc.sendTransaction(wire as never, { encoding: "base64" }).send({ abortSignal: deadline() }); },
    async status(signature) { const s = (await rpc.getSignatureStatuses([signature as never]).send({ abortSignal: deadline() })).value[0]; return !s ? "unknown" : s.err ? "failed" : s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" ? "confirmed" : "unknown"; },
  };
}

/** The command line, testable: every refusal or failure exits 1; only ok and confirmed exit 0. */
export async function cli(args: string[], d: { kc: Keychain | null; chain: () => Chain; ask: (prompt: string) => Promise<string | null>; out: (text: string) => void; wait?: (ms: number) => Promise<void> }): Promise<number> {
  const [cmd, a1, a2, ...rest] = args;
  const link = (s: string): string => `transaction ${s}\nhttps://solscan.io/tx/${s}`;
  const show = (o: Outcome): number => {
    d.out(o.outcome === "ok" ? `OK${o.address ? ` address ${o.address}` : ""}`
      : o.outcome === "confirmed" ? `CONFIRMED\n${link(o.signature)}` : o.outcome === "submitted" ? `SUBMITTED, NOT CONFIRMED: wait 2 minutes and check the link before you try again (a new try before then can send twice)\n${link(o.signature)}`
      : o.outcome === "failed" ? `FAILED on chain: nothing moved, the fee was spent\n${link(o.signature)}` : `REFUSED: ${o.reason}`);
    return o.outcome === "ok" || o.outcome === "confirmed" ? 0 : 1;
  };
  try {
    if (!d.kc) return show(refused("only macOS, Linux and Windows are supported"));
    if (cmd === "init" && a1 === undefined) {
      const code = show(await initWallet(d.kc));
      if (code === 0) d.out("Send it only what you are ready to lose, in USDC (payments need no SOL). Keep about 0.003 SOL in it to withdraw later.");
      return code;
    }
    if (cmd === "address" && a1 === undefined) {
      let a: string; try { a = await addressOf(await d.kc.read()); } catch (e) { return show(refused(kcWords(e))); }
      const c = d.chain();
      d.out(`address ${a}\nUSDC ${usdc((await c.tokenBalance(await usdcAccount(a))) ?? 0n)}\nSOL lamports ${await c.lamports(a)}`);
      return 0;
    }
    if (cmd === "withdraw" && a1 && a2 && rest.length === 0) {
      const amount = priceMinor(a2); if (amount === null) return show(refused("the amount must be a USDC amount, like 0.25"));
      return show(await withdraw({ kc: d.kc, chain: d.chain(), to: a1, amountMinor: amount, ask: d.ask, ...(d.wait ? { wait: d.wait } : {}) }));
    }
    if (cmd === "remove" && a1 === undefined) return show(await removeWallet({ kc: d.kc, chain: d.chain(), ask: d.ask }));
    return show(refused("usage: node services/mcp-payer/src/small-wallet.ts init | address | withdraw <address> <USDC> | remove"));
  } catch { return show(refused("an error before anything was signed")); }
}

if (isMain(import.meta.url)) {
  const prompts = createPrompts({ refuse: (t) => Object.assign(new Error(t), { refusal: true }), cancelled: () => Object.assign(new Error("Cancelled."), { refusal: true }) });
  void cli(process.argv.slice(2), { kc: systemKeychain(), chain: () => liveChain(), ask: (p) => prompts.readLine(p), out: (t) => process.stdout.write(`${t}\n`) }).then((code) => { process.exitCode = code; });
}
