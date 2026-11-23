// One command from a fresh clone to a ready payer (macOS and Linux). Running it again keeps the wallet and any entry it finds; it never prints the key.
//   node src/setup.ts
// It installs the pinned dependencies the tool needs to run (npm ci, no dev tools, no install scripts; skipped while they match the lock), makes the small wallet only if the
// keychain holds none, adds the payer and the Marketplace to Claude Code (user scope) unless a server of that name is already there, then prints the Codex line and how to fund it.
// No shell: every command is started with its arguments as a list. Windows is refused for now (its npm and claude are .cmd files, which need a shell).
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/main-guard.ts";
import { systemKeychain, type Keychain } from "./keychain.ts";

export const WALLET_NAME = "payzilla-wallet", FINDER_NAME = "payzilla", FINDER_URL = "https://paywith.payzilla.ai/mcp/read";
/** A command's exit code and output; code null: the command is not installed. A timeout or a kill is a failure (code 1) with its reason in `out`. */
export type Run = (cmd: string, args: readonly string[], cwd?: string) => { code: number | null; out: string };
type Wallet = Pick<typeof import("./small-wallet.ts"), "initWallet" | "addressOf" | "kcWords" | "fundText">;
export interface SetupDeps { version: string; platform: string; root: string; execPath: string; hasLock: boolean; depsCurrent: boolean; initLock?: string; run: Run; kc: Keychain | null; wallet: () => Promise<Wallet>; out: (text: string) => void }

/** Node 24 or newer: the payer runs its TypeScript directly. Pure. */
export const nodeRefusal = (version: string): string | null =>
  Number(/^v?(\d+)\./.exec(version)?.[1] ?? 0) >= 24 ? null : `Node ${version} is too old: install Node 24 or newer (nodejs.org), then run this again`;

/** The installed dependencies match the lock: npm writes node_modules/.package-lock.json after the lock it installed from, so a newer lock (a new release) installs again. */
export function depsCurrent(root: string): boolean {
  try { return statSync(join(root, "node_modules", ".package-lock.json")).mtimeMs >= statSync(join(root, "package-lock.json")).mtimeMs; } catch { return false; }
}

type Entry = { r: "added" | "already there" | "no claude" | "failed" } | { r: "taken"; scope: string };
/** One Claude Code entry. Already there: the same name with every part of `targets` in it. Taken: the same name pointing elsewhere (kept, never overwritten). */
export function claudeEntry(run: Run, name: string, targets: readonly string[], addArgs: readonly string[]): Entry {
  const got = run("claude", ["mcp", "get", name]);
  if (got.code === null) return { r: "no claude" };
  if (got.out.includes(`No MCP server named "${name}"`)) return { r: run("claude", addArgs).code === 0 ? "added" : "failed" };   // claude's own words for a missing name, seen in a real run
  if (got.code !== 0) return { r: "failed" };
  if (targets.every((t) => got.out.includes(t))) return { r: "already there" };
  return { r: "taken", scope: (/Scope: (User|Local|Project)/.exec(got.out)?.[1] ?? "User").toLowerCase() };
}

/** The whole setup, testable: 0 only when the payer is ready to use, 1 otherwise. Every step says what it did. */
export async function setup(d: SetupDeps): Promise<number> {
  const stop = (why: string): number => { d.out(`STOPPED: ${why}`); return 1; };
  if (d.platform === "win32") return stop("setup does not run on Windows yet: follow the steps by hand in the README");
  const old = nodeRefusal(d.version); if (old) return stop(old);
  if (d.hasLock && d.depsCurrent) d.out("Dependencies already installed.");
  else if (d.hasLock) {
    const npm = d.run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], d.root);
    if (npm.code === null) return stop("npm was not found: it comes with Node.js (nodejs.org)");
    if (npm.code !== 0) return stop(`npm ci failed:\n${npm.out.trim().split("\n").slice(-5).join("\n")}`);
    d.out("Dependencies installed.");
  }
  if (!d.kc) return stop("only macOS and Linux are supported by setup");
  let w: Wallet;
  try { w = await d.wallet(); } catch { return stop("the tool's code could not be loaded: run npm ci in its folder, then run this again"); }
  let address: string;
  try {
    if (await d.kc.exists()) { address = await w.addressOf(await d.kc.read()); d.out(`Wallet kept (one per computer): ${address}`); }
    else { const made = await w.initWallet(d.kc, d.initLock); if (made.outcome !== "ok" || !made.address) return stop(made.outcome === "refused" ? made.reason : "no wallet was made"); address = made.address; d.out(`Wallet made: ${address}`); }
  } catch (e) { return stop(w.kcWords(e)); }
  const server = join(d.root, "src", "server.ts"), q = (s: string): string => (/\s/.test(s) ? `"${s}"` : s);
  const walletAdd = ["mcp", "add", "--scope", "user", WALLET_NAME, "--", d.execPath, server], finderAdd = ["mcp", "add", "--transport", "http", "--scope", "user", FINDER_NAME, FINDER_URL];
  let ready = true;
  for (const [name, targets, add] of [[WALLET_NAME, [d.execPath, server], walletAdd], [FINDER_NAME, ["https://paywith.payzilla.ai/mcp"], finderAdd]] as const) {
    const e = claudeEntry(d.run, name, targets, add);
    if (e.r === "no claude") { d.out(`Claude Code not found. To add it later: claude ${add.map(q).join(" ")}`); continue; }
    if (e.r === "taken") { ready = ready && name !== WALLET_NAME; d.out(`Claude Code: "${name}" is set to something else (another server, or this payer with another Node or folder); kept it. To use this one: claude mcp remove ${name} -s ${e.scope}, then run this again`); continue; }
    if (e.r === "failed") { ready = false; d.out(`Claude Code: could not add "${name}". By hand: claude ${add.map(q).join(" ")}`); continue; }
    d.out(`Claude Code: ${name} ${e.r}.`);
  }
  d.out(`Codex: codex mcp add ${WALLET_NAME} -- ${q(d.execPath)} ${q(server)}`);
  d.out(w.fundText(address));
  if (ready) d.out("Ready. Restart your assistant, then ask it to pay a Marketplace listing with payzilla-wallet.");
  return ready ? 0 : 1;
}

/** Starts a command without a shell. Not installed: code null. A timeout or a kill: code 1 and the reason, never "not installed". */
export const makeRun = (timeoutMs: number): Run => (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: timeoutMs });
  const why = (r.error as { code?: string } | undefined)?.code;
  if (why === "ENOENT") return { code: null, out: "" };
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status === null) return { code: 1, out: `${out}\n${why === "ETIMEDOUT" ? `timed out after ${timeoutMs / 1000} s` : `stopped (${r.signal ?? why ?? "unknown"})`}` };
  return { code: r.status, out };
};

if (isMain(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  setup({ version: process.version, platform: process.platform, root, execPath: process.execPath, hasLock: existsSync(join(root, "package-lock.json")), depsCurrent: depsCurrent(root),
    run: makeRun(300_000), kc: systemKeychain(), wallet: () => import("./small-wallet.ts"), out: (t) => process.stdout.write(`${t}\n`) })
    .then((code) => { process.exitCode = code; }, () => { process.stdout.write("STOPPED: an unexpected error\n"); process.exitCode = 1; });
}
