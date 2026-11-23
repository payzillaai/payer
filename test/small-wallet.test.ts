import { createKeyPairSignerFromBytes, getBase58Encoder, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, type Address, type Blockhash } from "@solana/kit";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { KeychainError, SECRET, type Keychain } from "../src/keychain.ts";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addr, lockIn, memKc } from "./fixtures.ts";
import { ATA_RENT_LAMPORTS, MANUAL_DELETE, cli, FEE_LAMPORTS, RENT_EXEMPT_MIN_LAMPORTS, SYSTEM_PROGRAM, addressOf, fundLink, initWallet, newWallet, removeWallet, solRefusal, usdc, withdraw, type Chain } from "../src/small-wallet.ts";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const KEY = newWallet();
const OTHER = newWallet().address;   // a fresh address: no real account
const WORD = `WITHDRAW 0.25 ${OTHER.slice(0, 4)}...${OTHER.slice(-4)}`;
const ata = async (owner: string): Promise<string> => (await findAssociatedTokenPda({ owner: owner as Address, mint: USDC as Address, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

type ChainOpts = { usdc?: bigint | null; lamports?: bigint; destAtaExists?: boolean; toOwner?: string | null; sendThrows?: boolean; status?: "confirmed" | "failed" | "unknown"; balanceThrows?: boolean };
function fakeChain(o: ChainOpts = {}): Chain & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    tokenBalance: async (a: string) => { if (o.balanceThrows) throw new Error("rpc"); return a !== (await ata(KEY.address)) ? null : o.usdc === undefined ? 1_000_000n : o.usdc; },   // only the wallet's own USDC account holds anything
    lamports: async () => o.lamports ?? 3_000_000n,
    owner: async (a: string) => (a === OTHER ? (o.toOwner === undefined ? SYSTEM_PROGRAM : o.toOwner) : o.destAtaExists ? TOKEN_PROGRAM_ADDRESS : null),
    blockhash: async () => ({ blockhash: addr(5) as Blockhash, lastValidBlockHeight: 1n }),
    send: async (w: string) => { sent.push(w); if (o.sendThrows) throw new Error("rpc"); },
    status: async () => o.status ?? "confirmed",
  };
}
type W = Parameters<typeof withdraw>[0];
const noWait = async (): Promise<void> => {};
const go = (o: Partial<W> & { chain: Chain }) => withdraw({ kc: memKc(KEY.secret), to: OTHER, amountMinor: 250_000n, ask: async () => WORD, wait: noWait, ...o });
const reason = (r: unknown): string => (r as { reason?: string }).reason ?? "";

describe("the small wallet: one change at a time (the lock)", () => {
  /** Linux's behaviour: store REPLACES an existing item, and every call takes a moment, so two inits interleave. */
  const linuxLike = () => { const k = memKc(); const slow = () => new Promise((r) => setTimeout(r, 5)); return { ...k, get s() { return k.s; }, exists: async () => { await slow(); return k.s !== null; }, add: async (x: string) => { await slow(); k.s = x; }, read: async () => { await slow(); return k.read(); } }; };
  const busy = (lock: string): string => `another setup, init or remove is changing the wallet right now; if none is running, delete ${lock} and run this again`;
  it("two inits at once: exactly one makes the wallet, the other refuses with words naming the lock; the key shown is the key kept", async () => {
    const kc = linuxLike(), lock = lockIn(), [a, b] = await Promise.all([initWallet(kc, lock), initWallet(kc, lock)]);
    const ok = [a, b].filter((r) => r.outcome === "ok"), no = [a, b].filter((r) => r.outcome === "refused");
    expect(ok).toHaveLength(1); expect(no).toHaveLength(1); expect(reason(no[0])).toBe(busy(lock));
    expect(await addressOf(kc.s!)).toBe((ok[0] as { address: string }).address); expect(existsSync(lock)).toBe(false);
  });
  it("two PROCESSES at once on a Linux-like keychain file: one wallet, its shown address is the one kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "init2-")), child = join(import.meta.dirname, "two-process-child.ts"), args = [child, dir, "init"];
    const outs = await Promise.all([0, 1].map(() => new Promise<string>((res) => { let o = ""; const p = spawn(process.execPath, args); p.stdout.on("data", (d) => { o += d; }); p.on("close", () => res(o)); })));
    const shown = outs.filter((o) => o.startsWith("ok ")), busyOut = outs.filter((o) => o.startsWith("refused another setup"));
    expect(shown).toHaveLength(1); expect(busyOut).toHaveLength(1);
    expect(await addressOf(readFileSync(join(dir, "kc"), "utf8"))).toBe(shown[0]!.slice(3)); expect(existsSync(join(dir, "init.lock"))).toBe(false);
  }, 20_000);
  it("a held lock refuses init and remove, however old it is (no takeover), and leaves the keychain and the lock alone", async () => {
    const lock = lockIn(); writeFileSync(lock, ""); const old = Date.now() / 1000 - 86_400; utimesSync(lock, old, old);
    const kc = memKc(); expect(await initWallet(kc, lock)).toEqual({ outcome: "refused", reason: busy(lock) }); expect(kc.s).toBeNull(); expect(existsSync(lock)).toBe(true);
    const full = memKc(KEY.secret); expect(await removeWallet({ lock, kc: full, chain: fakeChain({ usdc: 0n }), ask: async () => null })).toEqual({ outcome: "refused", reason: busy(lock) }); expect(full.s).toBe(KEY.secret);
    const dirLock = lockIn(); mkdirSync(dirLock); expect(reason(await initWallet(memKc(), dirLock))).toBe(busy(dirLock));   // anything at the path names the path
  });
  it("the lock is released after ok, after a refusal and after remove; a lock that cannot be made refuses with its path", async () => {
    const lock = lockIn(); expect((await initWallet(memKc(KEY.secret), lock)).outcome).toBe("refused"); expect(existsSync(lock)).toBe(false);
    expect((await initWallet(memKc(), lock)).outcome).toBe("ok"); expect(existsSync(lock)).toBe(false);
    expect((await removeWallet({ lock, kc: memKc(KEY.secret), chain: fakeChain({ usdc: 0n }), ask: async () => null })).outcome).toBe("ok"); expect(existsSync(lock)).toBe(false);
    if (process.platform === "win32") return;   // the two cases below need a file used as a folder and a read-only folder (POSIX); setup refuses Windows anyway
    const bad = "/dev/null/init.lock", r = await initWallet(memKc(), bad); expect(r).toEqual({ outcome: "refused", reason: `the lock file ${bad} could not be made` });
    const ro = mkdtempSync(join(tmpdir(), "ro-")); chmodSync(ro, 0o500); const roLock = join(ro, "init.lock"), kc = memKc();   // the folder exists, the file cannot be created
    expect(await initWallet(kc, roLock)).toEqual({ outcome: "refused", reason: `the lock file ${roLock} could not be made` }); expect(kc.s).toBeNull(); chmodSync(ro, 0o700);
  });
});

describe("the small wallet: init", () => {
  it("a new wallet: 64 bytes in base58, and the address is the key's own", async () => {
    const w = newWallet(); expect(w.secret).toMatch(SECRET);
    expect((await createKeyPairSignerFromBytes(new Uint8Array(getBase58Encoder().encode(w.secret)))).address).toBe(w.address);
    expect(await addressOf(w.secret)).toBe(w.address); expect(newWallet().address).not.toBe(w.address);
  });
  it("init: refuses an existing wallet with its own words; stores a new key and READS IT BACK before showing the address", async () => {
    const full = memKc(KEY.secret); expect(await initWallet(full, lockIn())).toEqual({ outcome: "refused", reason: "a wallet already exists in the keychain: withdraw and remove it first" }); expect(full.s).toBe(KEY.secret);
    const k = memKc(); const r = await initWallet(k, lockIn());
    expect(r.outcome).toBe("ok"); expect(k.s).toMatch(SECRET); expect((r as { address: string }).address).toBe(await addressOf(k.s!)); expect(JSON.stringify(r)).not.toContain(k.s!);
  });
  it("init: a read-back that differs or fails shows NO address and deletes NOTHING (a key another process put there, or ours, stays; address shows it)", async () => {
    for (const kc of [memKc(null, { readBack: () => KEY.secret }), memKc(null, { readThrows: true })]) {
      let removed = false; const watched = { ...kc, remove: async () => { removed = true; } };
      const r = await initWallet(watched, lockIn());
      expect(r).toEqual({ outcome: "refused", reason: "the new wallet could not be confirmed in the keychain; nothing was deleted. Run address to see what it holds, then run this again" });
      expect(removed).toBe(false); expect(kc.s).toMatch(SECRET);
    }
  });
});

describe("the small wallet: withdraw", () => {
  it("the transaction, decoded: create the destination's USDC account (idempotent), then ONE transferChecked of exactly the amount, 6 decimals, mainnet USDC; signed only by the wallet", async () => {
    const c = fakeChain(); const r = await go({ chain: c });
    expect(r.outcome).toBe("confirmed"); expect(c.sent).toHaveLength(1);
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(c.sent[0]!));
    expect(Object.keys(tx.signatures)).toEqual([KEY.address]);
    const m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const acct = (i: number): string => String(m.staticAccounts[i]);
    expect(m.instructions).toHaveLength(2);
    const [create, transfer] = m.instructions as unknown as { programAddressIndex: number; accountIndices: number[]; data: Uint8Array }[];
    expect(acct(create!.programAddressIndex)).toBe(ASSOCIATED_TOKEN_PROGRAM_ADDRESS); expect([...create!.data]).toEqual([1]);   // CreateIdempotent
    expect(create!.accountIndices.map(acct).slice(0, 4)).toEqual([KEY.address, await ata(OTHER), OTHER, USDC]);   // payer, account, owner, mint
    expect(acct(transfer!.programAddressIndex)).toBe(TOKEN_PROGRAM_ADDRESS); expect(transfer!.data[0]).toBe(12);   // TransferChecked
    expect(new DataView(transfer!.data.buffer, transfer!.data.byteOffset).getBigUint64(1, true)).toBe(250_000n); expect(transfer!.data[9]).toBe(6);
    expect(transfer!.accountIndices.map(acct)).toEqual([await ata(KEY.address), USDC, await ata(OTHER), KEY.address]);   // source, mint, destination, authority
  });
  it("a failed send is NEVER success: it is 'submitted' with the signature; not confirmed in time is 'submitted'; a failed transaction is 'failed'", async () => {
    expect(await go({ chain: fakeChain({ sendThrows: true }) })).toMatchObject({ outcome: "submitted", signature: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/) });
    expect((await go({ chain: fakeChain({ status: "unknown" }) })).outcome).toBe("submitted");
    expect((await go({ chain: fakeChain({ status: "failed" }) })).outcome).toBe("failed");
  });
  it("the SOL rule: the fee, the new account's rent if needed, and what is left must be 0 or rent-exempt", () => {
    const newAcct = FEE_LAMPORTS + ATA_RENT_LAMPORTS;
    expect(solRefusal(newAcct, false)).toBeNull(); expect(solRefusal(newAcct - 1n, false)).not.toBeNull();
    expect(solRefusal(newAcct + 1n, false)).not.toBeNull(); expect(solRefusal(newAcct + RENT_EXEMPT_MIN_LAMPORTS, false)).toBeNull(); expect(solRefusal(newAcct + RENT_EXEMPT_MIN_LAMPORTS - 1n, false)).not.toBeNull();
    expect(solRefusal(FEE_LAMPORTS, true)).toBeNull(); expect(solRefusal(FEE_LAMPORTS + 10n, true)).not.toBeNull(); expect(solRefusal(FEE_LAMPORTS - 1n, true)).not.toBeNull();
    expect([FEE_LAMPORTS, ATA_RENT_LAMPORTS, RENT_EXEMPT_MIN_LAMPORTS]).toEqual([5_000n, 2_039_280n, 890_880n]);
  });
  it("refuses, sending nothing: a bad or own address, a token account or program as destination, nothing to send, more than the USDC account holds, too little SOL, a wrong word, no key", async () => {
    const cases: [Partial<W> & { chain: ReturnType<typeof fakeChain> }, string][] = [
      [{ chain: fakeChain(), to: "not an address" }, "not a Solana address"],
      [{ chain: fakeChain(), to: KEY.address }, "own address"],
      [{ chain: fakeChain({ toOwner: TOKEN_PROGRAM_ADDRESS }) }, "not a wallet"],
      [{ chain: fakeChain({ toOwner: "BPFLoaderUpgradeab1e11111111111111111111111" }) }, "not a wallet"],
      [{ chain: fakeChain(), amountMinor: 0n }, "above 0"],
      [{ chain: fakeChain({ usdc: 5n }), amountMinor: 6n }, "less than"],
      [{ chain: fakeChain({ usdc: null }), amountMinor: 1n }, "less than"],
      [{ chain: fakeChain({ lamports: FEE_LAMPORTS + ATA_RENT_LAMPORTS - 1n }) }, "more SOL"],
      [{ chain: fakeChain({ lamports: FEE_LAMPORTS + 1n, destAtaExists: true }) }, "more SOL"],
      [{ chain: fakeChain(), ask: async () => "WITHDRAW 0.25" }, "cancelled"],
      [{ chain: fakeChain(), ask: async () => WORD.replace("0.25", "0.24") }, "cancelled"],
      [{ chain: fakeChain(), ask: async () => WORD.replace("...", "…") }, "cancelled"],   // the word is ASCII only
      [{ chain: fakeChain(), ask: () => Promise.reject(new Error("no terminal")) }, "cancelled"],
      [{ chain: fakeChain(), kc: memKc() }, "no wallet in the keychain"],
    ];
    for (const [o, why] of cases) { const r = await go(o); expect(r.outcome, why).toBe("refused"); expect(reason(r), why).toContain(why); expect(o.chain.sent, why).toEqual([]); }
    expect((await go({ chain: fakeChain({ lamports: FEE_LAMPORTS, destAtaExists: true }) })).outcome).toBe("confirmed");   // an existing USDC account and exactly the fee: allowed
    expect((await go({ chain: fakeChain({ toOwner: null }) })).outcome).toBe("confirmed");   // a fresh wallet address with no account yet: allowed
  });
});

describe("the small wallet: remove", () => {
  it("reads the balance of the KEY's own USDC account (no file is trusted): refused while USDC is left or unknown unless REMOVE AND LOSE <balance> is typed", async () => {
    const k1 = memKc(KEY.secret); expect(await removeWallet({ lock: lockIn(), kc: k1, chain: fakeChain({ usdc: 50_000n }), ask: async () => "yes" })).toEqual({ outcome: "refused", reason: "kept; withdraw first" }); expect(k1.s).toBe(KEY.secret);
    const k2 = memKc(KEY.secret); expect((await removeWallet({ lock: lockIn(), kc: k2, chain: fakeChain({ usdc: 50_000n }), ask: async () => `REMOVE AND LOSE ${usdc(50_000n)}` })).outcome).toBe("ok"); expect(k2.s).toBeNull();
    const k3 = memKc(KEY.secret); expect((await removeWallet({ lock: lockIn(), kc: k3, chain: fakeChain({ usdc: 0n }), ask: async () => null })).outcome).toBe("ok"); expect(k3.s).toBeNull();
    const k4 = memKc(KEY.secret); expect((await removeWallet({ lock: lockIn(), kc: k4, chain: fakeChain({ balanceThrows: true }), ask: async () => "REMOVE AND LOSE 0" })).outcome).toBe("refused"); expect(k4.s).toBe(KEY.secret);
    const k5 = memKc(KEY.secret); expect((await removeWallet({ lock: lockIn(), kc: k5, chain: fakeChain({ balanceThrows: true }), ask: async () => "REMOVE AND LOSE UNKNOWN" })).outcome).toBe("ok"); expect(k5.s).toBeNull();
    const k6 = memKc(KEY.secret); expect((await removeWallet({ lock: lockIn(), kc: k6, chain: fakeChain({ usdc: null }), ask: async () => null })).outcome).toBe("ok");   // no USDC account at all: nothing to lose
  });
  it("the confirmation says SOL and other tokens are lost too; an answer that cannot be read keeps the key", async () => {
    let asked = ""; await removeWallet({ lock: lockIn(), kc: memKc(KEY.secret), chain: fakeChain({ usdc: 1n }), ask: async (p) => { asked = p; return null; } }); expect(asked).toContain("SOL or other tokens");
    const k = memKc(KEY.secret); expect(await removeWallet({ lock: lockIn(), kc: k, chain: fakeChain({ usdc: 1n }), ask: () => Promise.reject(new Error("no terminal")) })).toEqual({ outcome: "refused", reason: "kept; withdraw first" }); expect(k.s).toBe(KEY.secret);
  });
  it("a keychain that cannot be read keeps the key and says so; a chain error is not called a keychain error", async () => {
    const r = await removeWallet({ lock: lockIn(), kc: memKc(KEY.secret, { readThrows: true }), chain: fakeChain(), ask: async () => "x" }); expect(r.outcome).toBe("refused"); expect(reason(r)).toContain("keychain"); expect(reason(r)).toContain(MANUAL_DELETE);
    const r2 = await removeWallet({ lock: lockIn(), kc: memKc(KEY.secret), chain: fakeChain({ balanceThrows: true }), ask: async () => "no" }); expect(reason(r2)).toBe("kept; withdraw first");
  });
});

describe("the small wallet: the command line's exit codes (a script or an assistant reads them)", () => {
  const run = async (args: string[], o: { kc?: Keychain | null; chain?: Chain; ask?: () => Promise<string | null> } = {}) => {
    const lines: string[] = [];
    const code = await cli(args, { kc: o.kc === undefined ? memKc(KEY.secret) : o.kc, lock: lockIn(), chain: () => o.chain ?? fakeChain(), ask: o.ask ?? (async () => WORD), out: (t) => lines.push(t), wait: noWait });
    return { code, text: lines.join("\n") };
  };
  it("every refusal or failure exits 1; only ok and confirmed exit 0", async () => {
    for (const [args, o] of [[["nonsense"], {}], [["withdraw", OTHER, "abc"], {}], [["init"], { kc: null }], [["init"], {}], [["remove"], { chain: fakeChain({ usdc: 1n }), ask: () => Promise.reject(new Error("no terminal")) }],
      [["withdraw", OTHER, "0.25"], { chain: fakeChain({ sendThrows: true }) }], [["withdraw", OTHER, "0.25"], { chain: fakeChain({ status: "failed" }) }], [["address"], { kc: memKc() }],
      [["address"], { chain: { ...fakeChain(), lamports: () => Promise.reject(new Error("rpc")) } }]] as [string[], Parameters<typeof run>[1]][]) {
      const r = await run(args, o); expect(r.code, `${args.join(" ")} ${r.text}`).toBe(1); expect(r.text).toMatch(/^(REFUSED|SUBMITTED|FAILED)/);
    }
    expect((await run(["withdraw", OTHER, "0.25"])).code).toBe(0); expect((await run(["init"], { kc: memKc() })).code).toBe(0); expect((await run(["remove"], { chain: fakeChain({ usdc: 0n }) })).code).toBe(0);
    expect((await run(["address"])).code).toBe(0);
  });
  it("fund: the address and a Solana Pay USDC link with no amount (the sending wallet asks); init shows the same; no key, no link", async () => {
    expect(fundLink(KEY.address)).toBe(`solana:${KEY.address}?spl-token=${USDC}&label=Payzilla%20payer`);
    const f = await run(["fund"]); expect(f.code).toBe(0); expect(f.text).toContain(`address ${KEY.address}`); expect(f.text).toContain(`link ${fundLink(KEY.address)}`);
    expect(f.text).not.toContain(KEY.secret); expect(f.text).not.toContain("amount=");
    const kc = memKc(), i = await run(["init"], { kc }); expect(i.text).toContain(`link ${fundLink(await addressOf(kc.s!))}`);
    for (const kcx of [memKc(), memKc(KEY.secret, { readThrows: true })]) { const r = await run(["fund"], { kc: kcx }); expect(r.code).toBe(1); expect(r.text).toMatch(/^REFUSED/); expect(r.text).not.toContain("solana:"); }
    expect((await run(["fund", "x"])).text).toContain("usage:");
  });
  it("submitted says to wait before a new try (the blockhash stays valid for about 90 s)", async () => {
    expect((await run(["withdraw", OTHER, "0.25"], { chain: fakeChain({ status: "unknown" }) })).text).toContain("wait 2 minutes and check the link before you try again");
  });
});
