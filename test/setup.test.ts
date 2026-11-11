import { mkdtempSync, mkdirSync, utimesSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KeychainError, type Keychain } from "../src/keychain.ts";
import { depsCurrent, FINDER_NAME, FINDER_URL, makeRun, nodeRefusal, setup, WALLET_NAME, type Run, type SetupDeps } from "../src/setup.ts";
import * as wallet from "../src/small-wallet.ts";
import { lockIn, memKc } from "./fixtures.ts";

const ROOT = "/home/a/payer", NODE = "/usr/bin/node", SERVER = `${ROOT}/src/server.ts`;

/** A fake machine: npm, and a claude whose servers live in `servers` (name -> target). Every call is recorded. The missing-name text is claude's own, seen in a real run. */
function machine(o: { npm?: number | null; claude?: boolean; addFails?: boolean; getFails?: boolean; scope?: string; servers?: Record<string, string> } = {}) {
  const servers: Record<string, string> = { ...o.servers }, calls: string[] = [];
  const run: Run = (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "npm") return o.npm === null ? { code: null, out: "" } : { code: o.npm ?? 0, out: o.npm ? "line1\nERR! network\n" : "" };
    if (o.claude === false) return { code: null, out: "" };
    const [, sub, ...rest] = args;
    if (sub === "get" && o.getFails) return { code: 1, out: "Error: config file is damaged" };
    if (sub === "get") { const n = rest[0]!; return n in servers ? { code: 0, out: `${n}:\n  Scope: ${o.scope ?? "User"} config\n  Args: ${servers[n]}` } : { code: 1, out: `No MCP server named "${n}". Configured servers: x` }; }
    if (o.addFails) return { code: 1, out: "error" };
    const name = rest.find((a) => a === WALLET_NAME || a === FINDER_NAME)!;
    servers[name] = name === WALLET_NAME ? args.slice(args.indexOf("--") + 1).join(" ") : FINDER_URL;
    return { code: 0, out: "" };
  };
  return { run, calls, servers };
}
async function go(m: ReturnType<typeof machine>, o: Partial<SetupDeps> = {}) {
  const lines: string[] = [];
  const code = await setup({ version: "v24.21.0", platform: "darwin", depsCurrent: false, initLock: lockIn(), root: ROOT, execPath: NODE, hasLock: true, run: m.run, kc: memKc(), wallet: async () => wallet, out: (t) => lines.push(t), ...o });
  return { code, text: lines.join("\n") };
}

describe("setup: one command from a clone to a ready payer", () => {
  it("Node 24 or newer only; an older Node stops before anything runs", async () => {
    expect(nodeRefusal("v24.0.0")).toBeNull(); expect(nodeRefusal("v25.1.0")).toBeNull();
    for (const v of ["v23.11.0", "v22.18.0", "v20.1.0", "garbage"]) expect(nodeRefusal(v)).toContain("install Node 24 or newer");
    const m = machine(), kc = memKc(), r = await go(m, { version: "v22.18.0", kc });
    expect(r.code).toBe(1); expect(r.text).toMatch(/^STOPPED: Node v22\.18\.0 is too old/); expect(m.calls).toEqual([]); expect(kc.s).toBeNull();
  });
  it("first run: installs, makes the wallet, adds both entries, prints the Codex line and the fund link; the key is never printed", async () => {
    const m = machine(), kc = memKc(), r = await go(m, { kc });
    expect(r.code).toBe(0);
    const address = await wallet.addressOf(kc.s!);
    expect(m.calls[0]).toBe("npm ci --omit=dev --ignore-scripts --no-audit --no-fund");
    expect(m.calls).toContain(`claude mcp add --scope user ${WALLET_NAME} -- ${NODE} ${SERVER}`);
    expect(m.calls).toContain(`claude mcp add --transport http --scope user ${FINDER_NAME} ${FINDER_URL}`);
    expect(r.text).toContain(`Wallet made: ${address}`); expect(r.text).toContain(`Codex: codex mcp add ${WALLET_NAME} -- ${NODE} ${SERVER}`);
    expect(r.text).toContain(`link ${wallet.fundLink(address)}`); expect(r.text).toContain("Ready."); expect(r.text).not.toContain(kc.s!);
  });
  it("run twice: the same wallet is kept, no second wallet, no second add, no 'already exists' failure", async () => {
    const m = machine(), kc = memKc();
    expect((await go(m, { kc })).code).toBe(0);
    const key = kc.s, adds = m.calls.filter((c) => c.startsWith("claude mcp add")).length;
    const r = await go(m, { kc });
    expect(r.code).toBe(0); expect(kc.s).toBe(key); expect(r.text).toContain(`Wallet kept (one per computer): ${await wallet.addressOf(key!)}`);
    expect(m.calls.filter((c) => c.startsWith("claude mcp add")).length).toBe(adds);
    expect(r.text).toContain(`${WALLET_NAME} already there`); expect(r.text).toContain(`${FINDER_NAME} already there`);
  });
  it("an existing Marketplace entry on the full address counts as there (/mcp and /mcp/read both find listings)", async () => {
    const m = machine({ servers: { [FINDER_NAME]: "https://paywith.payzilla.ai/mcp" } }), r = await go(m);
    expect(r.code).toBe(0); expect(r.text).toContain(`${FINDER_NAME} already there`);
  });
  it("name taken: the other server is kept, never overwritten; the wallet name taken is not ready (exit 1), the finder name taken is a note", async () => {
    const m = machine({ servers: { [WALLET_NAME]: "/somewhere/else.js" } }), r = await go(m);
    expect(r.code).toBe(1); expect(m.servers[WALLET_NAME]).toBe("/somewhere/else.js"); expect(m.calls.some((c) => c.includes(`add --scope user ${WALLET_NAME}`))).toBe(false);
    expect(r.text).toContain(`"${WALLET_NAME}" is set to something else (another server, or this payer with another Node or folder); kept it. To use this one: claude mcp remove ${WALLET_NAME} -s user`); expect(r.text).not.toContain("Ready.");
    const f = machine({ servers: { [FINDER_NAME]: "/opt/other/finder.js" } }), rf = await go(f);
    expect(rf.code).toBe(0); expect(f.servers[FINDER_NAME]).toBe("/opt/other/finder.js"); expect(rf.text).toContain(`"${FINDER_NAME}" is set to something else`);
  });
  it("keychain locked or unsupported: stops with words, adds nothing; a locked keychain on the second run also keeps the key", async () => {
    const locked: Keychain = { exists: async () => { throw new KeychainError("unavailable"); }, add: async () => undefined, read: async () => "", remove: async () => undefined };
    const m = machine(), r = await go(m, { kc: locked });
    expect(r.code).toBe(1); expect(r.text).toContain("STOPPED: the keychain could not be used (unlock it, or install its tool)"); expect(m.calls.some((c) => c.startsWith("claude"))).toBe(false);
    const kept = memKc(wallet.newWallet().secret, { readThrows: true }), r2 = await go(machine(), { kc: kept });
    expect(r2.code).toBe(1); expect(kept.s).not.toBeNull(); expect(r2.text).toContain("STOPPED: the keychain could not be used");
    expect((await go(machine(), { kc: null })).text).toBe("Dependencies installed.\nSTOPPED: only macOS and Linux are supported by setup");
  });
  it("a refused init (the key did not read back) stops before Claude Code; no address is shown", async () => {
    const m = machine(), r = await go(m, { kc: memKc(null, { readBack: () => "other" }) });
    expect(r.code).toBe(1); expect(r.text).toContain("STOPPED: the new wallet could not be confirmed in the keychain; nothing was deleted"); expect(r.text).not.toContain("Wallet made"); expect(m.calls.some((c) => c.startsWith("claude"))).toBe(false);
  });
  it("a Claude Code look-up that errors is not 'already there': exit 1, nothing added, the by-hand line", async () => {
    const m = machine({ getFails: true }), r = await go(m);
    expect(r.code).toBe(1); expect(r.text).not.toContain("already there"); expect(m.calls.some((c) => c.startsWith("claude mcp add"))).toBe(false); expect(r.text).toContain(`could not add "${WALLET_NAME}". By hand:`);
  });
  it("npm missing or failing stops before the wallet; no lock file (the private repo) skips npm", async () => {
    const kc = memKc();
    expect((await go(machine({ npm: null }), { kc })).text).toBe("STOPPED: npm was not found: it comes with Node.js (nodejs.org)");
    const r = await go(machine({ npm: 1 }), { kc }); expect(r.code).toBe(1); expect(r.text).toContain("npm ci failed:\nline1\nERR! network"); expect(kc.s).toBeNull();
    const m = machine(); expect((await go(m, { hasLock: false })).code).toBe(0); expect(m.calls.some((c) => c.startsWith("npm"))).toBe(false);
  });
  it("no Claude Code: the wallet is still made, the add lines and the Codex line are printed, exit 0 (Codex users)", async () => {
    const r = await go(machine({ claude: false }));
    expect(r.code).toBe(0); expect(r.text).toContain(`Claude Code not found. To add it later: claude mcp add --scope user ${WALLET_NAME} -- ${NODE} ${SERVER}`); expect(r.text).toContain("Codex: codex mcp add");
  });
  it("a failed add says how to add by hand and exits 1; paths with spaces are quoted in printed lines", async () => {
    const r = await go(machine({ addFails: true }), { root: "/home/A B/payer" });
    expect(r.code).toBe(1); expect(r.text).toContain(`could not add "${WALLET_NAME}". By hand: claude mcp add --scope user ${WALLET_NAME} -- ${NODE} "/home/A B/payer/src/server.ts"`);
  });
  it("setup uses the lock it is given: a held lock stops it with the lock's words, before Claude Code, and no key is made", async () => {
    const lock = lockIn(); writeFileSync(lock, ""); const m = machine(), kc = memKc(), r = await go(m, { kc, initLock: lock });
    expect(r.code).toBe(1); expect(r.text).toContain(`STOPPED: another setup, init or remove is changing the wallet right now; if none is running, delete ${lock}`); expect(kc.s).toBeNull(); expect(m.calls.some((c) => c.startsWith("claude"))).toBe(false);
  });
  it("Windows is refused before anything runs (no shell is ever used)", async () => {
    const m = machine(), kc = memKc(), r = await go(m, { platform: "win32", kc });
    expect(r.code).toBe(1); expect(r.text).toBe("STOPPED: setup does not run on Windows yet: follow the steps by hand in the README"); expect(m.calls).toEqual([]); expect(kc.s).toBeNull();
  });
  it("dependencies that match the lock are not installed again (npm ci would delete them under a running payer)", async () => {
    const m = machine(), r = await go(m, { depsCurrent: true });
    expect(r.code).toBe(0); expect(r.text).toContain("Dependencies already installed."); expect(m.calls.some((c) => c.startsWith("npm"))).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "setup-")); writeFileSync(join(dir, "package-lock.json"), "{}");
    expect(depsCurrent(dir)).toBe(false);
    mkdirSync(join(dir, "node_modules")); writeFileSync(join(dir, "node_modules", ".package-lock.json"), "{}");
    utimesSync(join(dir, "package-lock.json"), 1000, 1000); utimesSync(join(dir, "node_modules", ".package-lock.json"), 2000, 2000); expect(depsCurrent(dir)).toBe(true);
    utimesSync(join(dir, "package-lock.json"), 3000, 3000); expect(depsCurrent(dir)).toBe(false);   // a new release's lock installs again
  });
  it("our entry with another Node (an upgrade) is not 'already there': kept, not ready, and the remove hint names the scope found", async () => {
    const m = machine({ scope: "Local", servers: { [WALLET_NAME]: `/old/node ${SERVER}` } }), r = await go(m);
    expect(r.code).toBe(1); expect(r.text).not.toContain(`${WALLET_NAME} already there`); expect(r.text).toContain(`claude mcp remove ${WALLET_NAME} -s local, then run this again`); expect(m.servers[WALLET_NAME]).toBe(`/old/node ${SERVER}`);
  });
  it("the tool's code failing to load stops with words, not a stack trace", async () => {
    const r = await go(machine(), { wallet: () => Promise.reject(new Error("Cannot find package")) });
    expect(r.code).toBe(1); expect(r.text).toContain("STOPPED: the tool's code could not be loaded");
  });
});

describe("makeRun: real processes, no shell", () => {
  const run = makeRun(5_000), node = process.execPath;
  it("not installed is code null; an exit code and the output come back; the working folder is used", () => {
    expect(run("payzilla-no-such-command", [])).toEqual({ code: null, out: "" });
    expect(run(node, ["-e", "process.stdout.write('hi'); process.stderr.write('!'); process.exit(3)"])).toEqual({ code: 3, out: "hi!" });
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "run-"))); expect(run(node, ["-e", "process.stdout.write(process.cwd())"], dir).out).toBe(dir);
  });
  it("arguments reach the program as they are: & ; % ^ ( and spaces are never read by a shell", () => {
    const tricky = "C:\\Users\\R&D\\a b;%PATH%^(x)$(id)";
    expect(run(node, ["-e", "process.stdout.write(process.argv[1])", tricky]).out).toBe(tricky);
  });
  it("a timeout or a kill is a failure with its reason, never 'not installed'", () => {
    const slow = makeRun(300)(node, ["-e", "setTimeout(() => {}, 10000)"]); expect(slow.code).toBe(1); expect(slow.out).toContain("timed out after 0.3 s");
    const killed = run(node, ["-e", "process.kill(process.pid, 'SIGKILL')"]); expect(killed.code).toBe(1); expect(killed.out).toContain("stopped (SIGKILL)");
  });
});
