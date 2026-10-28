// The payer's local state and the human step after an unknown outcome: one small folder, written so that two processes cannot both hold the marker.
// Shared by the payer tool (main.ts) and the own-key command (own.ts).
import { chmodSync, closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Marker, Store } from "./payer.ts";

const isMarker = (m: unknown): m is Marker => typeof m === "object" && m !== null && ["pending", "unknown"].includes((m as Marker).state) && typeof (m as Marker).listingId === "string" && typeof (m as Marker).amountMinor === "string" && typeof (m as Marker).at === "string";
/** The files, written so two processes cannot both hold the marker and no reader ever sees half a file: the marker is written in full to a temp file, then LINKED into place
 *  (the link fails if a marker exists: the lock; a file system without hard links, such as FAT, makes take throw, so nothing is paid there); every other write goes through a temp file and a rename. A file that cannot be read throws: the tool then pays nothing. */
/** `unlinkTemp`: removes a temp file; best effort (Windows antivirus or indexing can hold it): a leftover temp file never changes the answer.
 *  `read`: reads a file. On Windows a file another process is deleting refuses reads for a moment (EPERM, EBUSY): that read is tried again, up to 10 times a few ms apart. */
export function fileStore(dir: string, io: { unlinkTemp?: (f: string) => void; read?: (f: string) => string } = {}): Store {
  const unlinkTemp = io.unlinkTemp ?? unlinkSync, read = io.read ?? ((f: string) => readFileSync(f, "utf8"));
  const mf = join(dir, "marker.json"), af = join(dir, "attempts.json"), rf = join(dir, "refusals.json");
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const text = (f: string): string | null => {
    for (let i = 0; ; i++) {
      try { return read(f); } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "ENOENT") return null;
        if ((code === "EPERM" || code === "EBUSY") && i < 9) { Atomics.wait(pause, 0, 0, 5); continue; }
        throw e;
      }
    }
  };
  const times = (f: string, what: string): number[] => { const t = text(f); if (t === null) return []; const a: unknown = JSON.parse(t); if (!Array.isArray(a) || !a.every((x) => Number.isFinite(x))) throw new Error(`${what}_unreadable`); return a as number[]; };
  const temp = (f: string): string => `${f}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const ready = (): void => { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); };
  const write = (fd: number, s: string): void => { try { writeSync(fd, s); fsyncSync(fd); } finally { closeSync(fd); } };
  const replace = (f: string, s: string): void => { ready(); const tmp = temp(f); write(openSync(tmp, "wx", 0o600), s); renameSync(tmp, f); };
  return {
    marker(): Marker | null { const t = text(mf); if (t === null) return null; const m: unknown = JSON.parse(t); if (!isMarker(m)) throw new Error("marker_unreadable"); return m; },
    attempts: () => times(af, "attempts"), refusals: () => times(rf, "refusals"),
    take(m: Marker): boolean {
      ready(); const tmp = temp(mf);
      write(openSync(tmp, "wx", 0o600), JSON.stringify(m));   // complete and on disk before it can be seen
      try { linkSync(tmp, mf); return true; } catch (e) { if ((e as { code?: string }).code === "EEXIST") return false; throw e; } finally { try { unlinkTemp(tmp); } catch { /* best effort */ } }
    },
    update(m: Marker): void { replace(mf, JSON.stringify(m)); },
    release(): void { unlinkSync(mf); },
    saveAttempts(a: number[]): void { replace(af, JSON.stringify(a)); }, saveRefusals(a: number[]): void { replace(rf, JSON.stringify(a)); },
  };
}

/** `end` is called once when clear is done, so the terminal reader closes and the process can exit. */
export interface ClearIo { isTTY: boolean; ask(prompt: string): Promise<string | null>; out(s: string): void; end?(): void }
/** The terminal side of clear: the process's own stdin and stdout. */
export function terminalClearIo(): ClearIo {
  let rl: ReturnType<typeof createInterface> | null = null;
  return {
    isTTY: process.stdin.isTTY === true, out: (s) => { process.stdout.write(s); }, end: () => { rl?.close(); },
    ask: (p) => { process.stdout.write(p); rl ??= createInterface({ input: process.stdin }); const r0 = rl; return new Promise((r) => { r0.once("line", r); r0.once("close", () => r(null)); }); },
  };
}
/** The marker is removed only by a person at a terminal who typed CLEAR after checking the chain. A pipe (an assistant's `echo CLEAR |`) is refused.
 *  Still only a local safety net: anyone with a shell on this computer can delete these files. */
export async function clear(store: Store, io: ClearIo, wallet = "the wallet"): Promise<number> {
  try {
    if (!io.isTTY) { io.out("clear needs a person at a terminal: run it yourself, not through a pipe or a tool. Nothing changed.\n"); return 2; }
    const k = store.marker();
    if (!k) { io.out("No marker: nothing to clear.\n"); return 0; }
    io.out(`Marker: ${k.state}, listing ${k.listingId}, ${k.amountMinor} minor units, at ${k.at}${k.signature ? `, transaction ${k.signature}` : ""}${k.reference ? `, reference ${k.reference}` : ""}\nCheck ${wallet} on Solscan first.\n`);
    if ((await io.ask("Type CLEAR to remove the marker (anything else keeps it): "))?.trim() !== "CLEAR") { io.out("Kept.\n"); return 1; }
    store.release(); io.out("Cleared.\n"); return 0;
  } finally { io.end?.(); }
}
