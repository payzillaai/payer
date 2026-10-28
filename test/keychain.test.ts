import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CALL_TIMEOUT_MS, LINUX_TOOL, MAC_TOOL, PS_PROTECT, PS_UNPROTECT, SECRET, WINDOWS_TOOL, linuxKeychain, macKeychain, realRun, systemKeychain, windowsDir, windowsKeychain, type Run } from "../src/keychain.ts";
import { newWallet } from "../src/small-wallet.ts";

/** A fake keychain tool: records every call, answers from a script (quiet = nothing on standard error). */
function fakeRun(answer: (file: string, args: string[], input: string | null) => { code: number | null; out?: string; quiet?: boolean }) {
  const calls: { file: string; args: string[]; input: string | null; timeout: number }[] = [];
  const run: Run = async (file, args, input, timeout) => { calls.push({ file, args, input, timeout }); const a = answer(file, args, input); return { code: a.code, out: a.out ?? "", quiet: a.quiet ?? true }; };
  return { run, calls };
}
const KEY = newWallet();

describe("keychain (macOS security, Linux secret-tool), against a fake tool", () => {
  it("macOS: the secret goes ONLY through standard input of `security -i`, never into the arguments; the fixed tool path and the 10 s limit", async () => {
    const f = fakeRun(() => ({ code: 0 }));
    await macKeychain(f.run).add(KEY.secret);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ file: MAC_TOOL, args: ["-i"], timeout: CALL_TIMEOUT_MS });
    expect(f.calls[0]!.input).toBe(`add-generic-password -s payzilla-payer -a wallet -w ${KEY.secret}\n`);   // no -U: an existing item is never replaced
    expect(JSON.stringify(f.calls.map((c) => c.args))).not.toContain(KEY.secret);
    expect(MAC_TOOL).toBe("/usr/bin/security"); expect(CALL_TIMEOUT_MS).toBe(10_000);
  });
  it("macOS: exists / empty / unavailable from the exit codes; read returns only a key-shaped text", async () => {
    expect(await macKeychain(fakeRun(() => ({ code: 0 })).run).exists()).toBe(true);
    expect(await macKeychain(fakeRun(() => ({ code: 44 })).run).exists()).toBe(false);
    await expect(macKeychain(fakeRun(() => ({ code: null })).run).exists()).rejects.toMatchObject({ word: "unavailable" });   // a timeout or a missing tool
    expect(await macKeychain(fakeRun(() => ({ code: 0, out: `${KEY.secret}\n` })).run).read()).toBe(KEY.secret);
    await expect(macKeychain(fakeRun(() => ({ code: 44 })).run).read()).rejects.toMatchObject({ word: "empty" });
    await expect(macKeychain(fakeRun(() => ({ code: 0, out: "not a key" })).run).read()).rejects.toMatchObject({ word: "unavailable" });
    await expect(macKeychain(fakeRun(() => ({ code: 45 })).run).add(KEY.secret)).rejects.toMatchObject({ word: "unavailable" });   // the item exists (exit 45 on macOS)
    await expect(macKeychain(fakeRun(() => ({ code: 0 })).run).add("a b -U")).rejects.toMatchObject({ word: "refused" });   // only base58 ever reaches the interactive line
  });
  it("Linux: the secret goes on standard input; an existing item is refused BEFORE store (store would replace it silently)", async () => {
    const empty = fakeRun((_f, args) => (args[0] === "lookup" ? { code: 1 } : { code: 0 }));
    await linuxKeychain(empty.run).add(KEY.secret);
    expect(empty.calls.map((c) => c.args[0])).toEqual(["lookup", "store"]);
    expect(empty.calls[1]).toMatchObject({ file: LINUX_TOOL, input: KEY.secret }); expect(JSON.stringify(empty.calls.map((c) => c.args))).not.toContain(KEY.secret);
    const full = fakeRun((_f, args) => (args[0] === "lookup" ? { code: 0, out: KEY.secret } : { code: 0 }));
    await expect(linuxKeychain(full.run).add(KEY.secret)).rejects.toMatchObject({ word: "exists" }); expect(full.calls.map((c) => c.args[0])).toEqual(["lookup"]);
    expect(await linuxKeychain(fakeRun(() => ({ code: 0, out: `${KEY.secret}\n` })).run).read()).toBe(KEY.secret);
    await expect(linuxKeychain(fakeRun(() => ({ code: 1 })).run).read()).rejects.toMatchObject({ word: "empty" });
    await expect(linuxKeychain(fakeRun(() => ({ code: null })).run).read()).rejects.toMatchObject({ word: "unavailable" });
    // exit 1 is "no item" ONLY with nothing on standard output and standard error (a D-Bus or session error also exits 1)
    const dbus = fakeRun((_f, args) => (args[0] === "lookup" ? { code: 1, quiet: false } : { code: 0 }));
    await expect(linuxKeychain(dbus.run).exists()).rejects.toMatchObject({ word: "unavailable" });
    await expect(linuxKeychain(dbus.run).add(KEY.secret)).rejects.toMatchObject({ word: "unavailable" }); expect(dbus.calls.map((c) => c.args[0])).not.toContain("store");
    await expect(linuxKeychain(fakeRun(() => ({ code: 0, out: "" })).run).exists()).rejects.toMatchObject({ word: "unavailable" });
  });
  it("Windows (DPAPI through Windows PowerShell 5.1 by its absolute path): the key only on standard input, the encrypted text in one file created exclusively", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kc-win-")); const BLOB = "01000000d08c9ddf".padEnd(200, "a");
    const f = fakeRun((_file, args, input) => (args.at(-1) === PS_PROTECT ? { code: 0, out: `${BLOB}\r\n` } : input?.trim() === BLOB ? { code: 0, out: `${KEY.secret}\r\n` } : { code: 1 }));
    const kc = windowsKeychain(f.run, dir);
    expect(await kc.exists()).toBe(false); await expect(kc.read()).rejects.toMatchObject({ word: "empty" });
    await kc.add(KEY.secret);
    expect(f.calls[0]).toMatchObject({ file: WINDOWS_TOOL, input: `${KEY.secret}\n`, timeout: CALL_TIMEOUT_MS }); expect(f.calls[0]!.args).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_PROTECT]);
    expect(JSON.stringify(f.calls.map((c) => c.args))).not.toContain(KEY.secret); expect(PS_PROTECT + PS_UNPROTECT).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{80}/);
    expect(readFileSync(join(dir, "wallet.dpapi"), "utf8")).toBe(BLOB); expect(await kc.exists()).toBe(true);
    await expect(kc.add(KEY.secret)).rejects.toMatchObject({ word: "exists" }); expect(f.calls).toHaveLength(1);   // refused before PowerShell runs
    expect(await kc.read()).toBe(KEY.secret); expect(f.calls[1]!.args.at(-1)).toBe(PS_UNPROTECT);
    await kc.remove(); expect(await kc.exists()).toBe(false);
    await expect(windowsKeychain(fakeRun(() => ({ code: 0, out: "not hex" })).run, mkdtempSync(join(tmpdir(), "kc-win-"))).add(KEY.secret)).rejects.toMatchObject({ word: "unavailable" });
    const notADir = join(mkdtempSync(join(tmpdir(), "kc-win-")), "file"); writeFileSync(notADir, "x");   // only "file not found" is absent; another file error is unavailable
    await expect(windowsKeychain(f.run, notADir).exists()).rejects.toMatchObject({ word: "unavailable" });
    await expect(windowsKeychain(f.run, notADir).read()).rejects.toMatchObject({ word: "unavailable" });
    const raced = mkdtempSync(join(tmpdir(), "kc-win-"));   // a wallet that appears while PowerShell runs is never replaced (the file is created exclusively)
    const r2 = fakeRun(() => { writeFileSync(join(raced, "wallet.dpapi"), "first"); return { code: 0, out: BLOB }; });
    await expect(windowsKeychain(r2.run, raced).add(KEY.secret)).rejects.toMatchObject({ word: "exists" }); expect(readFileSync(join(raced, "wallet.dpapi"), "utf8")).toBe("first");
    const stuck = mkdtempSync(join(tmpdir(), "kc-win-")); mkdirSync(join(stuck, "wallet.dpapi")); writeFileSync(join(stuck, "wallet.dpapi", "x"), "x");   // a delete that fails is not "removed"
    await expect(windowsKeychain(f.run, stuck).remove()).rejects.toMatchObject({ word: "unavailable" });
    expect(WINDOWS_TOOL).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(windowsDir({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" })).toContain("payzilla-payer");
  });
  it("macOS, Linux and Windows have a keychain; other systems none", () => {
    expect(systemKeychain("freebsd")).toBeNull(); for (const p of ["darwin", "linux", "win32"]) expect(systemKeychain(p), p).not.toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("realRun (the real child process; the Windows runner skips these POSIX commands)", () => {
  it("a time limit ends the call with no answer, even after some output", async () => {
    expect(await realRun("/bin/sleep", ["5"], null, 200)).toMatchObject({ code: null, out: "" });
    const t0 = Date.now(); expect(await realRun("/bin/sh", ["-c", "echo partial; sleep 5"], null, 300)).toMatchObject({ code: null, out: "" });
    expect(Date.now() - t0).toBeLessThan(2_000);   // the answer comes at the limit, not when a child of the tool lets go of the pipes
  });
  it("a tool that does not read its input does not crash the caller (EPIPE)", async () => { expect((await realRun("/bin/sh", ["-c", "exit 0"], "x".repeat(1_000_000), 5_000)).code).toBe(0); });
  it("standard output is capped at 4096 characters; standard error is only counted, never returned", async () => {
    const big = await realRun("/bin/sh", ["-c", "head -c 100000 /dev/zero | tr '\\0' a"], null, 5_000); expect(big.code).toBe(0); expect(big.out.length).toBe(4096);
    const err = await realRun("/bin/sh", ["-c", "echo secret-looking-text >&2; exit 1"], null, 5_000); expect(err).toEqual({ code: 1, out: "", quiet: false });
    expect(await realRun("/bin/sh", ["-c", "exit 1"], null, 5_000)).toEqual({ code: 1, out: "", quiet: true });
  });
  it("Windows file rules on a real folder: a folder that cannot be written is unavailable, not 'exists'", async () => {
    const ro = mkdtempSync(join(tmpdir(), "kc-win-")); chmodSync(ro, 0o500);
    try { await expect(windowsKeychain(fakeRun(() => ({ code: 0, out: "ab".repeat(60) })).run, ro).add(KEY.secret)).rejects.toMatchObject({ word: "unavailable" }); } finally { chmodSync(ro, 0o700); }
  });
  it("a missing tool is no answer", async () => { expect((await realRun("/no/such/tool", [], null, 1_000)).code).toBeNull(); });
});
