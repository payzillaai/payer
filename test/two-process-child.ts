// Child for the many-process tests (payer.test.ts), over the REAL file store in argv[2]:
//   (no mode)  one payListing with a fake service and a slow fake signer that logs each signature
//   churn <ms> take and release the marker in a loop        watch <ms>  read the marker in a loop; prints how many reads failed (a half-written marker)
//   init       initWallet with the lock argv[2]/init.lock over a Linux-like keychain FILE argv[2]/kc (store replaces; each call waits); prints "ok <address>" or "refused <reason>"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileStore } from "../src/store.ts";
import { payListing } from "../src/payer.ts";
import { initWallet } from "../src/small-wallet.ts";
import { ALLOWED, ID, listing, settled, terms } from "./fixtures.ts";

const [dir, mode, ms] = [process.argv[2]!, process.argv[3], Number(process.argv[4] ?? 0)];
const s = fileStore(dir), until = Date.now() + ms;
const pause = () => new Promise((r) => setTimeout(r, 300));
if (mode === "init") {
  const f = join(dir, "kc");
  const r = await initWallet({ exists: async () => { const e = existsSync(f); await pause(); return e; }, add: async (x) => { await pause(); writeFileSync(f, x); },
    read: async () => { await pause(); return readFileSync(f, "utf8"); }, remove: async () => undefined }, join(dir, "init.lock"));
  process.stdout.write(r.outcome === "ok" ? `ok ${r.address}` : r.outcome === "refused" ? `refused ${r.reason}` : r.outcome);
} else if (mode === "churn") {
  while (Date.now() < until) { if (s.take({ state: "pending", listingId: ID, amountMinor: "10000", at: "t" })) s.release(); }
} else if (mode === "watch") {
  let bad = 0; while (Date.now() < until) { try { s.marker(); } catch { bad++; } }
  process.stdout.write(String(bad));
} else {
  const a = await payListing({
    allow: [ALLOWED], store: s, now: Date.now, enabled: () => true,
    call: async (name, _a, meta) => (name === "marketplace_get_listing" ? listing() : meta ? settled : terms()),
    signer: { sign: async () => { appendFileSync(join(dir, "signed.log"), `${process.pid}\n`); await new Promise((r) => setTimeout(r, 1500)); return { kind: "signed", payload: { x402Version: 2 } }; } },
  }, ID);
  process.stdout.write(a.outcome);
}
