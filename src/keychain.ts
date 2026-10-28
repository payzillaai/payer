// The small wallet's key in the operating system's keychain, through the system's own command-line tool (no extra package):
//   macOS  /usr/bin/security   the secret goes in through `security -i` on standard input, never as an argument (an argument is visible in the process list)
//          exit 44 = no item; add without -U on an existing item fails (exit 45); checked with a dummy item on one macOS version only
//   Linux  /usr/bin/secret-tool (libsecret)   the secret goes in on standard input; it needs a running Secret Service (GNOME Keyring or KWallet)
//   Windows  Windows PowerShell 5.1 by its absolute path, DPAPI for the current user (ConvertFrom-SecureString with no key): the key goes in on standard input, the
//            encrypted text is kept in %LOCALAPPDATA%\payzilla-payer\wallet.dpapi (protected by the user profile's access rules). Not yet run on Windows: the repo's Windows CI
//            is the first proof.
// One item: service "payzilla-payer", account "wallet". Every call has a 10 s limit (a locked keychain can block). Errors, standard output and standard error of the tool are
// never logged or returned: only fixed words. Any program running as the same user can call the same tool and read the key: the loss bound is the small wallet's balance.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SERVICE = "payzilla-payer", ACCOUNT = "wallet", CALL_TIMEOUT_MS = 10_000;
export const MAC_TOOL = "/usr/bin/security", LINUX_TOOL = "/usr/bin/secret-tool", WINDOWS_TOOL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/** One run of the keychain tool: its exit code, its standard output (at most 4096 characters kept) and whether standard error stayed EMPTY (its text is never kept). `input` goes to standard input. */
export type Run = (file: string, args: string[], input: string | null, timeoutMs: number) => Promise<{ code: number | null; out: string; quiet: boolean }>;
export interface Keychain { exists(): Promise<boolean>; add(secret: string): Promise<void>; read(): Promise<string>; remove(): Promise<void> }
/** A keychain failure, in fixed words. */
export class KeychainError extends Error { readonly word: "unavailable" | "empty" | "exists" | "refused"; constructor(word: KeychainError["word"]) { super(`keychain_${word}`); this.word = word; } }

/** The base58 of a 64-byte Solana secret: the only text this module ever stores. It also guarantees that the line given to `security -i` holds no space or quote. */
export const SECRET = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

export const realRun: Run = (file, args, input, timeoutMs) => new Promise((resolve) => {
  const p = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, killSignal: "SIGKILL" });
  let out = "", errBytes = 0, done = false;
  const finish = (code: number | null): void => { if (!done) { done = true; resolve({ code, out: code === null ? "" : out, quiet: errBytes === 0 }); } };
  p.stdout.setEncoding("utf8"); p.stdout.on("data", (d: string) => { if (out.length < 4096) out = (out + d).slice(0, 4096); });
  p.stderr.on("data", (d: Buffer) => { errBytes += d.length; });   // counted, never kept
  p.on("error", () => finish(null));
  p.on("exit", (_code, signal) => { if (signal) finish(null); });   // killed at the time limit: no answer now, even if a child of the tool still holds the pipes
  p.on("close", (code, signal) => finish(signal ? null : code));
  p.stdin.on("error", () => undefined); p.stdin.end(input ?? "");
});

export function macKeychain(run: Run = realRun): Keychain {
  const base = ["-s", SERVICE, "-a", ACCOUNT];
  return {
    async exists() { const r = await run(MAC_TOOL, ["find-generic-password", ...base], null, CALL_TIMEOUT_MS); if (r.code === 0) return true; if (r.code === 44) return false; throw new KeychainError("unavailable"); },
    async add(secret) {
      if (!SECRET.test(secret)) throw new KeychainError("refused");
      const r = await run(MAC_TOOL, ["-i"], `add-generic-password -s ${SERVICE} -a ${ACCOUNT} -w ${secret}\n`, CALL_TIMEOUT_MS);   // without -U: an existing item makes it fail, never replaced
      if (r.code !== 0) throw new KeychainError("unavailable");
    },
    async read() {
      const r = await run(MAC_TOOL, ["find-generic-password", ...base, "-w"], null, CALL_TIMEOUT_MS);
      if (r.code === 44) throw new KeychainError("empty");
      const s = r.out.trim(); if (r.code !== 0 || !SECRET.test(s)) throw new KeychainError("unavailable");
      return s;
    },
    async remove() { const r = await run(MAC_TOOL, ["delete-generic-password", ...base], null, CALL_TIMEOUT_MS); if (r.code !== 0 && r.code !== 44) throw new KeychainError("unavailable"); },
  };
}

/** Linux: `secret-tool store` REPLACES an existing item without asking, so `add` looks it up first and refuses (one user, one terminal: a race between the look-up and the store is accepted).
 *  `secret-tool lookup` exits 1 both for "no such item" and for a D-Bus or session error: only exit 1 with NOTHING on standard output or standard error counts as absent;
 *  anything else is "unavailable" (not yet run on a real Linux machine: the repo's Linux CI is the first proof). */
export function linuxKeychain(run: Run = realRun): Keychain {
  const attrs = ["service", SERVICE, "account", ACCOUNT];
  const look = async (): Promise<string | null> => {
    const r = await run(LINUX_TOOL, ["lookup", ...attrs], null, CALL_TIMEOUT_MS);
    if (r.code === 0 && r.out.trim() !== "") return r.out.trim();
    if (r.code === 1 && r.out.trim() === "" && r.quiet) return null;
    throw new KeychainError("unavailable");
  };
  return {
    async exists() { return (await look()) !== null; },
    async add(secret) {
      if (!SECRET.test(secret)) throw new KeychainError("refused");
      if (await this.exists()) throw new KeychainError("exists");
      const r = await run(LINUX_TOOL, ["store", "--label=Payzilla payer wallet", ...attrs], secret, CALL_TIMEOUT_MS);
      if (r.code !== 0) throw new KeychainError("unavailable");
    },
    async read() {
      const s = await look();
      if (s === null) throw new KeychainError("empty");
      if (!SECRET.test(s)) throw new KeychainError("unavailable");
      return s;
    },
    async remove() { const r = await run(LINUX_TOOL, ["clear", ...attrs], null, CALL_TIMEOUT_MS); if (r.code !== 0) throw new KeychainError("unavailable"); },
  };
}

/** The two PowerShell scripts: each reads ONE line from standard input and writes ONE line. No secret is ever in a script or an argument. */
export const PS_PROTECT = "$s = [Console]::In.ReadLine(); $ss = ConvertTo-SecureString -String $s -AsPlainText -Force; $s = $null; [Console]::Out.WriteLine((ConvertFrom-SecureString -SecureString $ss))";
export const PS_UNPROTECT = "$b = [Console]::In.ReadLine(); $ss = ConvertTo-SecureString -String $b; $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss); try { [Console]::Out.WriteLine([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }";
const psArgs = (script: string): string[] => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script];
/** DPAPI's text form: hexadecimal only. */
const BLOB = /^[0-9a-fA-F]{100,8000}$/;
export const windowsDir = (env: Readonly<Record<string, string | undefined>> = process.env): string => join(env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "payzilla-payer");

/** Windows: the encrypted key in one file, created EXCLUSIVELY (an existing wallet is never replaced). Any program running as the same Windows user can decrypt it, the same as the other keychains.
 *  Only "file not found" (ENOENT) counts as absent; any other file error is "unavailable". */
const missing = (e: unknown): boolean => (e as { code?: string } | null)?.code === "ENOENT";
export function windowsKeychain(run: Run = realRun, dir: string = windowsDir()): Keychain {
  const file = join(dir, "wallet.dpapi");
  const present = (): boolean => { try { statSync(file); return true; } catch (e) { if (missing(e)) return false; throw new KeychainError("unavailable"); } };
  return {
    async exists() { return present(); },
    async add(secret) {
      if (!SECRET.test(secret)) throw new KeychainError("refused");
      if (present()) throw new KeychainError("exists");
      const r = await run(WINDOWS_TOOL, psArgs(PS_PROTECT), `${secret}\n`, CALL_TIMEOUT_MS);
      const blob = r.out.trim(); if (r.code !== 0 || !BLOB.test(blob)) throw new KeychainError("unavailable");
      mkdirSync(dir, { recursive: true });
      let fd: number;
      try { fd = openSync(file, "wx"); } catch (e) { throw new KeychainError((e as { code?: string } | null)?.code === "EEXIST" ? "exists" : "unavailable"); }
      try { writeSync(fd, blob); closeSync(fd); } catch { try { closeSync(fd); } catch { /* already closed */ } try { unlinkSync(file); } catch { /* left for remove */ } throw new KeychainError("unavailable"); }   // no half-written wallet is left behind
    },
    async read() {
      let blob: string;
      try { blob = readFileSync(file, "utf8").trim(); } catch (e) { throw new KeychainError(missing(e) ? "empty" : "unavailable"); }
      if (!BLOB.test(blob)) throw new KeychainError("unavailable");
      const r = await run(WINDOWS_TOOL, psArgs(PS_UNPROTECT), `${blob}\n`, CALL_TIMEOUT_MS);
      const s = r.out.trim(); if (r.code !== 0 || !SECRET.test(s)) throw new KeychainError("unavailable");
      return s;
    },
    async remove() { try { unlinkSync(file); } catch (e) { if (!missing(e)) throw new KeychainError("unavailable"); } },
  };
}

/** The keychain of this computer: macOS, Linux or Windows; null on any other system. */
export const systemKeychain = (platform: string = process.platform, run: Run = realRun): Keychain | null => (platform === "darwin" ? macKeychain(run) : platform === "linux" ? linuxKeychain(run) : platform === "win32" ? windowsKeychain(run) : null);
