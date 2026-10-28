import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handle, MAX_LINE, onLine, type Served } from "../src/wire.ts";
import { clear, fileStore } from "../src/store.ts";
import { payListing, priceMinor, REFUSAL_GAP_MS, REFUSAL_LIMIT, refusalWait, REPEAT_LIMIT, type Deps, type Marker, type SignOutcome } from "../src/payer.ts";
import { addr, ALLOWED, FEE, ID, listing, memStore, OTHER, settled, short, SIG, terms } from "./fixtures.ts";

const NOW = 1_000_000_000, TOOL = { name: "pay_listing" };
function rig(o: { sign?: SignOutcome | "throw"; paid?: unknown; listing?: Record<string, unknown>; terms?: Record<string, unknown>; store?: ReturnType<typeof memStore>; enabled?: boolean } = {}) {
  const store = o.store ?? memStore(); const calls: string[] = []; let signed = 0; const markerAtSign: (Marker | null)[] = [];
  const d: Deps = {
    allow: [ALLOWED], store,
    signer: { sign: async () => { signed++; markerAtSign.push(store.m); if (o.sign === "throw") throw new Error("boom"); return o.sign ?? { kind: "signed", payload: { x402Version: 2 } }; } },
    call: async (name, _a, meta) => {
      calls.push(meta ? `${name}+paid` : name);
      if (name === "marketplace_get_listing") return o.listing ?? listing();
      if (meta) { if (o.paid === "throw") throw new Error("net"); return (o.paid === undefined ? settled : o.paid) as Record<string, unknown>; }
      return o.terms ?? terms();
    },
    now: () => NOW, enabled: () => o.enabled ?? true,
  };
  const s: Served = { tool: TOOL, pay: (a) => payListing(d, a["listing_id"]), errorWords: "the payer tool hit an error; its outcome is unknown" };
  return { d, s, store, calls, signed: () => signed, markerAtSign };
}

describe("payer tool: pays by itself only inside the rule", () => {
  it("settles an allow-listed listing at the cap: marker held while signing, released after, one attempt counted, the pinned label (never seller text)", async () => {
    const r = rig(); const a = await payListing(r.d, ID);
    expect(a).toEqual({ outcome: "settled", listing: "Test listing", amount: "0.01", transaction: SIG });
    expect(r.calls).toEqual(["marketplace_get_listing", "listing_pay", "listing_pay+paid"]);
    expect(r.markerAtSign[0]?.state).toBe("pending"); expect(r.store.m).toBeNull(); expect(r.store.a).toEqual([NOW]);
    expect(JSON.stringify(a)).not.toContain("Ignore");
  });
  it("unknown from the wallet: marker kept as unknown, nothing sent, the next call is blocked with the pay link and asks the service nothing", async () => {
    const r = rig({ sign: { kind: "unknown" } });
    expect((await payListing(r.d, ID)).outcome).toBe("unknown"); expect(r.calls).not.toContain("listing_pay+paid"); expect(r.store.m?.state).toBe("unknown");
    const n = r.calls.length;
    expect(await payListing(r.d, ID)).toMatchObject({ outcome: "blocked", payLink: `https://paywith.payzilla.ai/p/${ID}` }); expect(r.calls.length).toBe(n); expect(r.signed()).toBe(1);
  });
  it("after signing every failure is unknown with the marker kept: a throwing signer, a failed paid call, an unreadable answer, a not-settled answer, a store that fails on release", async () => {
    const cases: Parameters<typeof rig>[0][] = [{ sign: "throw" }, { paid: "throw" }, { paid: null }, { paid: { isError: true, structuredContent: { error: "outcome_unknown" } } }, { paid: { isError: true, structuredContent: { error: "not_sent" } } }, { paid: { content: [] } }];
    for (const o of cases) { const r = rig(o); expect((await payListing(r.d, ID)).outcome, JSON.stringify(o)).toBe("unknown"); expect(r.store.m?.state).toBe("unknown"); }
    const s = memStore(); s.release = () => { throw new Error("disk"); };
    const r = rig({ store: s }); expect((await payListing(r.d, ID)).outcome).toBe("unknown"); expect(s.m?.state).toBe("unknown");
  });
  it("Signer contract: `refused` means nothing was sent, so the marker is released and the attempt does NOT count (refusals never lock payments out)", async () => {
    const r = rig({ sign: { kind: "refused", reason: "x" } });
    expect(await payListing(r.d, ID)).toMatchObject({ outcome: "refused", reason: "the wallet refused to sign: x; nothing was sent" });
    expect(r.store.m).toBeNull(); expect(r.store.a).toEqual([]);
    for (const sign of ["throw", { kind: "unknown" }] as const) { const u = rig({ sign }); await payListing(u.d, ID); expect(u.store.a, JSON.stringify(sign)).toEqual([NOW]); }   // maybe signed: counts
    const ok = rig(); await payListing(ok.d, ID); expect(ok.store.a).toEqual([NOW]);
  });
  it("refused tries: recorded under the marker; from the 10th in an hour, one try a minute (no service call); older ones drop out; a clock moved back waits at most a minute", async () => {
    expect([REFUSAL_LIMIT, REFUSAL_GAP_MS]).toEqual([10, 60_000]);
    const r = rig({ sign: { kind: "refused", reason: "x" }, store: memStore({ refusals: [NOW - 4_000_000] }) }); await payListing(r.d, ID); expect(r.store.r).toEqual([NOW]);   // older than an hour: dropped
    const nine = Array.from({ length: 9 }, (_, i) => NOW - 1_800_000 - i);   // half an hour ago
    expect(refusalWait(nine, NOW)).toBeNull(); expect(refusalWait([...nine, NOW - 10_000], NOW)).toBe(REFUSAL_GAP_MS - 10_000);
    expect(refusalWait([...nine, NOW - REFUSAL_GAP_MS], NOW)).toBeNull(); expect(refusalWait([...nine, NOW - 3_600_000], NOW)).toBeNull();
    expect(refusalWait([...nine.map((t) => t - 3_600_000), NOW - 1_000], NOW)).toBeNull();   // nine older than an hour and one recent: only one counts
    expect(refusalWait([...nine, NOW + 600_000], NOW)).toBeNull(); expect(refusalWait(Array.from({ length: 12 }, (_, i) => NOW + 1_000 + i), NOW)).toBeNull();
    const ahead = rig({ store: memStore({ refusals: Array.from({ length: 12 }, (_, i) => NOW + 600_000 + i) }) });   // a clock moved back: refusals dated in the future never block a payment
    expect((await payListing(ahead.d, ID)).outcome).toBe("settled");
    const broken = memStore(); broken.refusals = () => { throw new Error("refusals_unreadable"); };
    expect((await payListing(rig({ store: broken }).d, ID)).outcome).toBe("settled");   // an unreadable record only loosens the slow-down
    const slow = rig({ store: memStore({ refusals: [...nine, NOW - 1_000] }) });
    expect(await payListing(slow.d, ID)).toMatchObject({ outcome: "refused", payLink: `https://paywith.payzilla.ai/p/${ID}` }); expect(slow.calls).toEqual([]); expect(slow.signed()).toBe(0);
    const s = memStore(); s.saveRefusals = () => { throw new Error("disk"); }; const r2 = rig({ sign: { kind: "refused", reason: "x" }, store: s });
    expect((await payListing(r2.d, ID)).outcome).toBe("refused"); expect(s.m).toBeNull();   // a refusal that cannot be recorded still releases the marker
  });
  it("an attempt that cannot be recorded is not sent: unknown, marker kept, no paid call", async () => {
    const r = rig(); r.store.saveAttempts = () => { throw new Error("disk"); };
    expect((await payListing(r.d, ID)).outcome).toBe("unknown"); expect(r.store.m).toMatchObject({ state: "unknown" }); expect(r.calls.some((c) => c.endsWith("+paid"))).toBe(false);
  });
  it("a marker that exists blocks before anything else; one taken between the first look and signing (another process) blocks too", async () => {
    const r = rig({ store: memStore({ marker: { state: "pending", listingId: ID, amountMinor: "10000", at: "t" } }) });
    expect((await payListing(r.d, ID)).outcome).toBe("blocked"); expect(r.calls).toEqual([]); expect(r.signed()).toBe(0);
    const s = memStore(); const r2 = rig({ store: s });
    const call = r2.d.call; r2.d.call = async (n, a, m, f) => { if (n === "listing_pay" && !m) s.m = { state: "pending", listingId: OTHER, amountMinor: "1", at: "t" }; return call(n, a, m, f); };
    expect((await payListing(r2.d, ID)).outcome).toBe("blocked"); expect(r2.signed()).toBe(0); expect(s.m?.listingId).toBe(OTHER);
  });
  it(`the repeat guard: ${REPEAT_LIMIT} attempts in the last hour means needs approval, also when they appear under the lock; older ones drop out`, async () => {
    expect(REPEAT_LIMIT).toBe(3);   // the default: 3 per hour
    const recent = Array.from({ length: REPEAT_LIMIT }, (_, i) => NOW - 1000 * (i + 1));
    const r = rig({ store: memStore({ attempts: recent }) });
    expect(await payListing(r.d, ID)).toMatchObject({ outcome: "needs approval", payLink: `https://paywith.payzilla.ai/p/${ID}` }); expect(r.signed()).toBe(0);
    const s = memStore({ attempts: recent.slice(1) }); const r2 = rig({ store: s });
    const call = r2.d.call; r2.d.call = async (n, a, m, f) => { if (n === "listing_pay" && !m) s.a = [...s.a, NOW - 10]; return call(n, a, m, f); };   // another process paid meanwhile
    expect((await payListing(r2.d, ID)).outcome).toBe("needs approval"); expect(r2.signed()).toBe(0); expect(s.m).toBeNull();
    const r3 = rig({ store: memStore({ attempts: [NOW - 3_600_000, ...recent.slice(1)] }) }); expect((await payListing(r3.d, ID)).outcome).toBe("settled");
    expect(r3.store.a).toHaveLength(REPEAT_LIMIT);
  });
  it("a clock behind the last attempt pays nothing", async () => {
    const r = rig({ store: memStore({ attempts: [NOW + 60_000] }) });
    expect(await payListing(r.d, ID)).toMatchObject({ outcome: "needs approval", reason: "the clock is behind the last payment; a person can pay with the link" }); expect(r.signed()).toBe(0);
  });
  it("above the cap: needs approval with the pay link, no terms asked, nothing signed", async () => {
    const r = rig({ listing: listing({ priceUsdc: "0.10" }) });
    expect(await payListing(r.d, ID)).toMatchObject({ outcome: "needs approval", amount: "0.10", payLink: `https://paywith.payzilla.ai/p/${ID}` }); expect(r.calls).toEqual(["marketplace_get_listing"]); expect(r.signed()).toBe(0);
  });
  it("wrong payee, amount, network or token in the terms: refused, nothing signed, no marker", async () => {
    for (const t of [{ payTo: FEE }, { amount: "9999" }, { amount: "20000" }, { network: "solana:devnet" }, { asset: FEE }, { scheme: "upto" }]) {
      const r = rig({ terms: terms(t) }); expect((await payListing(r.d, ID)).outcome, JSON.stringify(t)).toBe("refused"); expect(r.signed()).toBe(0); expect(r.store.m).toBeNull();
    }
    const r = rig({ terms: { isError: false, structuredContent: {} } }); expect((await payListing(r.d, ID)).outcome).toBe("refused"); expect(r.signed()).toBe(0);
  });
  it("the listing must match the allow list: payee, verified, payable, host, network, token", async () => {
    for (const l of [{ payToShort: short(addr(3)) }, { verified: false }, { payable: false }, { serviceHost: "evil.example" }, { network: "x" }, { asset: "x" }, { id: OTHER }, { priceUsdc: "1e-2" }]) {
      const r = rig({ listing: listing(l) }); expect((await payListing(r.d, ID)).outcome, JSON.stringify(l)).toBe("refused"); expect(r.signed()).toBe(0);
    }
  });
  it("off the allow list, switched off or a bad id: the pay link (or a refusal) and no service call", async () => {
    const r = rig(); expect(await payListing(r.d, OTHER)).toMatchObject({ outcome: "needs approval", payLink: `https://paywith.payzilla.ai/p/${OTHER}` });
    const off = rig({ enabled: false }); expect((await payListing(off.d, ID)).outcome).toBe("needs approval");
    expect((await payListing(r.d, "../x")).outcome).toBe("refused"); expect(r.calls).toEqual([]); expect(off.calls).toEqual([]);
  });
  it("priceMinor reads plain USDC text only", () => {
    expect(priceMinor("0.01")).toBe(10_000n); expect(priceMinor("25")).toBe(25_000_000n); expect(priceMinor("0.000001")).toBe(1n);
    for (const x of ["1e-2", "-1", "0.0000001", "", " 1", 1]) expect(priceMinor(x), String(x)).toBeNull();
  });
});

describe("payer tool: files, two processes, clear, wire", () => {
  it("SIX processes on one state folder: exactly one signs and settles, the others are blocked (none reads a half-written marker)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "payer2-")); const child = join(import.meta.dirname, "two-process-child.ts");
    const run = () => new Promise<string>((res, rej) => execFile(process.execPath, [child, dir], { timeout: 20_000 }, (e, out) => (e ? rej(e) : res(out))));
    const outs = (await Promise.all(Array.from({ length: 6 }, run))).sort();
    expect(outs).toEqual(["blocked", "blocked", "blocked", "blocked", "blocked", "settled"]);
    expect(readFileSync(join(dir, "signed.log"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(existsSync(join(dir, "marker.json"))).toBe(false); expect(JSON.parse(readFileSync(join(dir, "attempts.json"), "utf8"))).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  }, 30_000);
  it("a reader never sees a half-written marker: one process takes and releases in a loop, another reads in a loop, no read fails", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "payer-race-")), "s"); fileStore(dir).attempts(); const child = join(import.meta.dirname, "two-process-child.ts");
    const run = (mode: string) => new Promise<string>((res, rej) => execFile(process.execPath, [child, dir, mode, "1500"], { timeout: 20_000 }, (e, out) => (e ? rej(e) : res(out))));
    const [, bad] = await Promise.all([run("churn"), run("watch")]);
    expect(bad).toBe("0");
  }, 30_000);
  it("fileStore: exclusive take, update, release, attempts; an unreadable file throws; the folder is 0700", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "payer-")), "s"); const s = fileStore(dir);
    expect(s.marker()).toBeNull(); expect(s.attempts()).toEqual([]);
    const m: Marker = { state: "pending", listingId: ID, amountMinor: "10000", at: "t" };
    expect(s.take(m)).toBe(true); expect(s.take(m)).toBe(false); expect(fileStore(dir).take(m)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["marker.json"]); expect(JSON.parse(readFileSync(join(dir, "marker.json"), "utf8"))).toEqual(m);   // written in full, then linked; no temp file left
    const held = join(mkdtempSync(join(tmpdir(), "payer-")), "s"), h = fileStore(held, { unlinkTemp: () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); } });   // Windows antivirus holding the temp file
    expect(h.take(m)).toBe(true); expect(h.marker()).toEqual(m); expect(h.take(m)).toBe(false); h.release(); expect(h.marker()).toBeNull(); expect(h.take(m)).toBe(true);
    s.update({ ...m, state: "unknown" }); expect(s.marker()?.state).toBe("unknown"); s.release(); expect(s.marker()).toBeNull();
    s.saveAttempts([1, 2]); expect(s.attempts()).toEqual([1, 2]); expect(s.refusals()).toEqual([]); s.saveRefusals([3]); expect(s.refusals()).toEqual([3]);
    if (process.platform !== "win32") expect(statSync(dir).mode & 0o777).toBe(0o700);   // Windows: the profile's access rules, not modes
    writeFileSync(join(dir, "marker.json"), "{nope"); expect(() => s.marker()).toThrow();
    writeFileSync(join(dir, "marker.json"), JSON.stringify({ state: "gone" })); expect(() => s.marker()).toThrow();
    writeFileSync(join(dir, "attempts.json"), JSON.stringify(["x"])); expect(() => s.attempts()).toThrow();
    writeFileSync(join(dir, "refusals.json"), "{"); expect(() => s.refusals()).toThrow();
    const busy = (n: number, code = "EPERM") => { let left = n; return (f: string): string => { if (left-- > 0) throw Object.assign(new Error("pending delete"), { code }); return readFileSync(f, "utf8"); }; };   // Windows: a file being deleted
    const w = join(mkdtempSync(join(tmpdir(), "payer-")), "s"); fileStore(w).take(m);
    const t0 = Date.now(); expect(fileStore(w, { read: busy(3) }).marker()).toEqual(m); expect(Date.now() - t0).toBeGreaterThanOrEqual(10);   // it waits between tries, it does not spin
    expect(fileStore(w, { read: busy(9, "EBUSY") }).marker()).toEqual(m);
    expect(() => fileStore(w, { read: busy(10) }).marker()).toThrow(); expect(() => fileStore(w, { read: busy(1, "EACCES") }).marker()).toThrow();
    const odd = join(mkdtempSync(join(tmpdir(), "payer-")), "s"); mkdirSync(join(odd, "marker.json"), { recursive: true }); expect(() => fileStore(odd).marker()).toThrow();   // only a missing file is no marker
  });
  it("clear: refused without a terminal; at a terminal only the typed CLEAR removes the marker", async () => {
    const s = memStore({ marker: { state: "unknown", listingId: ID, amountMinor: "10000", at: "t" } });
    let ends = 0;
    const io = (isTTY: boolean, answer: string | null) => ({ isTTY, ask: async () => answer, out: () => {}, end: () => { ends++; } });
    expect(await clear(s, io(false, "CLEAR"))).toBe(2); expect(s.m).not.toBeNull();
    expect(await clear(s, io(true, "clear"))).toBe(1); expect(s.m).not.toBeNull();
    expect(await clear(s, io(true, null))).toBe(1); expect(s.m).not.toBeNull();
    expect(await clear(s, io(true, " CLEAR "))).toBe(0); expect(s.m).toBeNull();
    expect(await clear(s, io(true, "CLEAR"))).toBe(0);
    expect(ends).toBe(5);   // the terminal reader is closed after every clear, so the process can exit
  });
  it("wire: one tool marked as paying, initialize, notifications ignored, unknown tool, malformed and oversized lines", async () => {
    const r = rig();
    expect(await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, r.s)).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [TOOL] } });
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, r.s)).toBeNull();
    expect((await handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18" } }, r.s))!["result"]).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
    expect(await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "other" } }, r.s)).toMatchObject({ error: { code: -32602 } });
    expect(JSON.parse((await onLine("{nope", r.s))!)).toMatchObject({ id: null, error: { code: -32700 } });
    expect(JSON.parse((await onLine("x".repeat(MAX_LINE + 1), r.s))!)).toMatchObject({ id: null, error: { code: -32600 } });
    const paid = JSON.parse((await onLine(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pay_listing", arguments: { listing_id: ID } } }), r.s))!);
    expect(paid.result).toMatchObject({ isError: false, structuredContent: { outcome: "settled", transaction: SIG } });
  });
  it("an error inside the tool is reported as unknown, never as 'nothing was signed', and never with the error text", async () => {
    const r = rig(); r.d.store.marker = () => { throw new Error("/secret/path"); };
    const out = await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "pay_listing", arguments: { listing_id: ID } } }, r.s);
    expect(JSON.stringify(out)).not.toContain("/secret/path"); expect(JSON.stringify(out)).not.toContain("nothing was signed");
    expect(out!["result"]).toMatchObject({ isError: true, structuredContent: { outcome: "unknown" } }); expect(r.signed()).toBe(0);
  });
});
