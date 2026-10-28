// Terminal prompts for command-line tools that must not echo a secret: `readSecret` (no echo, raw mode) and `readLine` (a FRESH line: anything typed or pasted before the question is dropped).
// Shared by scripts/pay-x402-once.mjs (the payer key) and scripts/cosigner-operator.ts (the database password): ONE implementation, moved out of pay-x402-once.mjs unchanged. The two callers differ only in what a refusal
// is: `refuse(text)` throws the caller's refusal (used when there is no terminal), `cancelled()` returns the caller's cancellation error (Ctrl-C / Ctrl-D at the secret prompt).
export function createPrompts({ stdin = process.stdin, stderr = process.stderr, refuse, cancelled }) {
  const needTty = () => { if (!stdin.isTTY) refuse("this needs an interactive terminal (a typed answer). Nothing was sent."); };
  return {
    readSecret(prompt) {
      needTty();
      return new Promise((resolve, reject) => {
        stderr.write(prompt);
        const chars = [];
        const done = (fn, v) => { stdin.removeListener("data", onData); stdin.setRawMode(false); stdin.pause(); stderr.write("\n"); fn(v); };
        const onData = (d) => {
          for (const ch of d.toString("utf8")) {
            if (ch === "\r" || ch === "\n") return done(resolve, chars.join(""));
            if (ch === "\u0003" || (ch === "\u0004" && chars.length === 0)) return done(reject, cancelled());
            if (ch === "\u007f" || ch === "\b") chars.pop();
            else if (ch >= " " && ch !== "\u007f") chars.push(ch);
          }
        };
        stdin.setRawMode(true); stdin.resume(); stdin.on("data", onData);
      });
    },
    async readLine(prompt) {
      needTty();
      // discard anything already typed or pasted (it was typed before this summary was shown): read and drop pending input, then ask for a FRESH line
      stdin.setRawMode(true); stdin.resume(); await new Promise((r) => setTimeout(r, 150)); stdin.pause(); stdin.setRawMode(false);
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: stdin, output: stderr, terminal: true });
      return new Promise((resolve) => { rl.once("close", () => resolve(null)); rl.question(prompt, (a) => { resolve(a); rl.close(); }); });
    },
  };
}
