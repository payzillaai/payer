# Payzilla payer

Your AI assistant pays a verified Payzilla Marketplace listing in USDC, from a small wallet of its own. The wallet's key stays in your computer's keychain. Payzilla never sees it.

## Status: early, no external audit yet. Use with caution.
This tool lets an AI assistant pay Payzilla Marketplace listings in USDC on Solana mainnet from a small wallet whose key is kept in your operating system's keychain. **It uses real money.**

**What can go wrong.** An AI assistant using this tool can pay without asking you each time. It can be misled by listing text or by other content (prompt injection), can make mistakes, and can be affected by bugs in this tool, in Payzilla's service or in a seller's service. Any program that runs as your user on your computer, including the AI assistant's shell, may be able to read the key in your keychain. A Solana transaction cannot be undone.

**What protects you** is only: the small balance of the wallet this tool creates, the per-payment cap you set (0.50 USDC by default, up to 10 USDC), a repeat guard (10 payments an hour) and Payzilla's service limits (10 USDC per payment and 100 USDC a day across all users) These are safety nets, not guarantees, and they can change. Put in only what you are ready to lose. Withdraw what you do not need.

**Verified** means Payzilla marked a listing itself after looking at it. It is not an endorsement or a guarantee. Payzilla may refuse a payment, change limits or stop the service at any time. Payzilla pays the network fee today and may stop doing so.

**No warranty.** The code is under the MIT licence: provided "as is", without warranty of any kind, and the authors are not liable for any loss. The licence covers the code only. It gives you no right to the Payzilla name, logo or other trademarks. This is not financial, legal or tax advice. You are responsible for using it lawfully where you live.

**Install safely.** Pin a release tag or a commit hash; do not pull blindly. Install with `npm ci --ignore-scripts`. Report security problems to hello@payzilla.ai before posting them publicly.

## What you need

- Node.js 24 or newer.
- macOS, Windows or Linux.
  - Linux: `secret-tool` (package `libsecret-tools` on Debian and Ubuntu) and a running keyring (GNOME Keyring or KWallet).
  - Windows: Windows PowerShell 5.1, which comes with Windows. The key is encrypted for your Windows user (DPAPI). On a company computer with PowerShell logging or transcription turned on, the key may be written to a log. Use a personal computer, or ask your admin.
- A little USDC to put in the small wallet, and about 0.003 SOL if you want to withdraw later.

## 1. Get the code

Pin a release tag. Do not pull blindly.

macOS and Linux (bash):
```bash
git clone --branch <release tag> https://github.com/payzillaai/payer.git
cd payer
npm ci --ignore-scripts
```

Windows (PowerShell):
```powershell
git clone --branch <release tag> https://github.com/payzillaai/payer.git
cd payer
npm ci --ignore-scripts
```

Windows (cmd):
```bat
git clone --branch <release tag> https://github.com/payzillaai/payer.git
cd payer
npm ci --ignore-scripts
```

## 2. Make the small wallet

This makes a new key in your keychain and shows only the wallet's address.

bash:
```bash
node src/small-wallet.ts init
```

PowerShell:
```powershell
node src\small-wallet.ts init
```

cmd:
```bat
node src\small-wallet.ts init
```

Send the address only what you are ready to lose, in USDC on Solana. Payments need no SOL.

## 3. Set your cap per payment

The default is 0.50 USDC. The most is 10 USDC. Your assistant can pay up to this much each time, without asking you. You set it at a terminal. Any program running as you can still change the file, up to 10 USDC.

At most 10 payments an hour go through. So with the cap at 10 USDC, up to 100 USDC an hour can leave the wallet. The tool warns when the wallet holds more than 10 times the cap. Its files (the cap, the payment marker, the count and `off`) are safety nets on your computer: any program running as you can change or delete them.

bash:
```bash
node src/server.ts cap 0.50
```

PowerShell:
```powershell
node src\server.ts cap 0.50
```

cmd:
```bat
node src\server.ts cap 0.50
```

## 4. Connect your assistant

Two parts: the Marketplace, to find listings, and this tool, to pay them.

The Marketplace is the MCP address `https://paywith.payzilla.ai/mcp`. Add it in your assistant as an MCP server.

This tool runs on your computer. Give your assistant the full path to `src/server.ts`.

Claude Code (bash):
```bash
claude mcp add payzilla-payer --scope user -- node "$PWD/src/server.ts"
```

Claude Code (PowerShell):
```powershell
claude mcp add payzilla-payer --scope user -- node "$PWD\src\server.ts"
```

Claude Code (cmd):
```bat
claude mcp add payzilla-payer --scope user -- node "%CD%\src\server.ts"
```

Claude Desktop: add this to its config file and restart it. The file is `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows. Put your own full path in `args`.
```json
{ "mcpServers": { "payzilla-payer": { "command": "node", "args": ["<full path>/payer/src/server.ts"] } } }
```

Other MCP clients: the command is `node`, the argument is the full path to `src/server.ts`, over stdio.

## What the tool answers

- `settled`: paid. The answer has the transaction.
- `needs approval`: it paid nothing. The answer has the listing's pay link, so you can pay yourself. This happens above your cap, after 10 payments in an hour, or when the tool is off.
- `refused`: it paid nothing, and nothing was sent. For example, the wallet holds less than the price, or the payment terms did not match the listing. After 10 refused tries in an hour, it tries at most once a minute.
- `unknown`: a payment may have been sent. The tool stops paying until you check. A pending transaction means: do not pay again; check it first.
- `blocked`: an earlier payment is still open or unknown.

## Everyday commands

bash (use `src\` in PowerShell and cmd):
```bash
node src/small-wallet.ts address                      # the address and the balances
node src/small-wallet.ts withdraw <address> <USDC>    # send USDC out; you type a confirmation word
node src/small-wallet.ts remove                       # delete the key; it refuses while USDC is left
node src/server.ts clear                              # after an unknown outcome, once you checked the chain
```

To stop all payments, create an empty file named `off` in the tool's folder: `~/.payzilla-payer/assistant/off` on macOS and Linux, `%USERPROFILE%\.payzilla-payer\assistant\off` on Windows. Delete it to start again.

## Known advisory

`npm audit` reports one high-severity advisory: GHSA-mrhx-c7xc-m3w5, in `zod` before 4.6.6 (validating very large collections can use up memory). It comes in through the x402 library this tool uses (`@x402/svm` 2.28.0, which brings `@x402/core` 2.28.0).

This tool never loads that part. It uses only the x402 payment client, which does not use `zod`. The answers it reads from Payzilla are capped at 64 KB and checked by its own strict rules first. Even in the worst case the tool would only stop: your key stays in the keychain and nothing is sent.

Our CI fails on any other high or critical advisory. This one stays allowed, by its id only, until we move to the fixed library version.

## Licence

MIT. See LICENSE.
