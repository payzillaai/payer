// Child for the many-process tests (payer.test.ts), over the REAL file store in argv[2]:
//   (no mode)  one payListing with a fake service and a slow fake signer that logs each signature
//   churn <ms> take and release the marker in a loop        watch <ms>  read the marker in a loop; prints how many reads failed (a half-written marker)
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileStore } from "../src/store.ts";
import { payListing } from "../src/payer.ts";
import { ALLOWED, ID, listing, settled, terms } from "./fixtures.ts";

const [dir, mode, ms] = [process.argv[2]!, process.argv[3], Number(process.argv[4] ?? 0)];
const s = fileStore(dir), until = Date.now() + ms;
if (mode === "churn") {
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
