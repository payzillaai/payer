# Payzilla payer

Let your AI assistant pay for things on the Payzilla Marketplace, in USDC on Solana, from a small wallet of its own. The wallet's key stays in your computer's keychain; Payzilla never sees it.

MIT licence · release v0.1.0 (signed tag) · Node.js 24+ · macOS, Linux, Windows · for developers who run an AI assistant with local MCP servers (tested with Claude Code)

**Cost to try:** the tool is free. You put a little USDC in the small wallet and pay only the listing's price (from 0.01 USDC). Payzilla pays the network fee today.

```bash
git clone --branch v0.1.0 https://github.com/payzillaai/payer.git && cd payer
npm ci --ignore-scripts
node src/small-wallet.ts init        # makes the wallet; prints only its address
# send that address a little USDC on Solana
node src/server.ts cap 0.50          # your cap per payment (at most 10 USDC)
claude mcp add payzilla-payer --scope user -- node "$PWD/src/server.ts"
claude mcp add --transport http payzilla https://paywith.payzilla.ai/mcp/read
```
Then ask your assistant: "Find a Payzilla listing for X and pay it."

## Status: Early. Real money. Use with caution.
This tool lets an AI assistant pay Payzilla Marketplace listings in USDC on Solana mainnet from a small wallet whose key is kept in your operating system's keychain. **It uses real money.**

**What can go wrong.** An AI assistant using this tool can pay without asking you each time. It can be misled by listing text or by other content (prompt injection), can make mistakes, and can be affected by bugs in this tool, in Payzilla's service or in a seller's service. Any program that runs as your user on your computer, including the AI assistant's shell, may be able to read the key in your keychain. A Solana transaction cannot be undone.

**What protects you** is only: the small balance of the wallet this tool creates, the per-payment cap you set (0.50 USDC by default, up to 10 USDC), a repeat guard (10 payments an hour) and Payzilla's service limits (10 USDC per payment and 100 USDC a day across all users) These are safety nets, not guarantees, and they can change. Put in only what you are ready to lose. Withdraw what you do not need.

**Verified** means Payzilla marked a listing itself after looking at it. It is not an endorsement or a guarantee. Payzilla may refuse a payment, change limits or stop the service at any time. Payzilla pays the network fee today and may stop doing so.

**No warranty.** The code is under the MIT licence: provided "as is", without warranty of any kind, and the authors are not liable for any loss. The licence covers the code only. It gives you no right to the Payzilla name, logo or other trademarks. This is not financial, legal or tax advice. You are responsible for using it lawfully where you live.

**Install safely.** Pin a release tag or a commit hash; do not pull blindly. Install with `npm ci --ignore-scripts`. Report security problems to hello@payzilla.ai before posting them publicly.

## What it does
- Reads the listing from the Payzilla Marketplace and takes the receiving wallet and the price from it.
- Pays only if the payment terms name that same wallet and price, the price is within your cap, and fewer than 10 payments went through in the last hour. Otherwise it pays nothing and gives you the listing's pay link, so you can pay yourself.
- Signs on your computer with the small wallet's key, read from the keychain only to sign. Payzilla's fee payer pays the network fee.

## Requirements
- Node.js 24 or newer.
- macOS: the built-in Keychain.
- Linux: `secret-tool` (package `libsecret-tools` on Debian and Ubuntu) and a running keyring (GNOME Keyring or KWallet).
- Windows: Windows PowerShell 5.1, which comes with Windows. The key is encrypted for your Windows user (DPAPI). On a company computer with PowerShell logging or transcription turned on, the key may be written to a log. Use a personal computer, or ask your admin.
- About 0.003 SOL in the wallet if you want to withdraw later. Payments themselves need no SOL.

On Windows, write `src\` instead of `src/` in the commands, in PowerShell or cmd.

## Connect another assistant
- The payer is a local MCP server over stdio. The command is `node`, the argument is the full path to `src/server.ts`.
- To find listings, the assistant also needs the Marketplace: the MCP address `https://paywith.payzilla.ai/mcp/read`.
- Claude Desktop: add the payer to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`; Windows: `%APPDATA%\Claude\`), then restart:
  ```json
  { "mcpServers": { "payzilla-payer": { "command": "node", "args": ["<full path>/payer/src/server.ts"] } } }
  ```

## What the tool answers
| Answer | Meaning |
|---|---|
| `settled` | Paid. The answer has the transaction. |
| `needs approval` | Paid nothing: above your cap, 10 payments in the last hour, or the tool is off. You get the pay link. |
| `refused` | Paid nothing, nothing was sent. For example, the wallet holds less than the price, or the terms did not match the listing. After 10 refused tries in an hour, it tries at most once a minute. |
| `unknown` | A payment may have been sent. The tool stops paying until you check. With a pending transaction: do not pay again; check it first. |
| `blocked` | An earlier payment is still open or unknown. |

## Everyday commands
```bash
node src/small-wallet.ts address                     # the address and the balances
node src/small-wallet.ts withdraw <address> <USDC>   # send USDC out; you type a confirmation word
node src/small-wallet.ts remove                      # delete the key; it refuses while USDC is left
node src/server.ts clear                             # after an unknown answer, once you checked the chain
```
To stop all payments, create an empty file named `off` in the tool's folder: `~/.payzilla-payer/assistant/off` on macOS and Linux, `%USERPROFILE%\.payzilla-payer\assistant\off` on Windows. Delete it to start again.

## Known advisory

`npm audit` reports one high-severity advisory: GHSA-mrhx-c7xc-m3w5, in `zod` before 4.6.6 (validating very large collections can use up memory). It comes in through the x402 library this tool uses (`@x402/svm` 2.28.0, which brings `@x402/core` 2.28.0).

This tool never loads that part. It uses only the x402 payment client, which does not use `zod`. The answers it reads from Payzilla are capped at 64 KB and checked by its own strict rules first. Even in the worst case the tool would only stop: your key stays in the keychain and nothing is sent.

Our CI fails on any other high or critical advisory. This one stays allowed, by its id only, until we move to the fixed library version.

## Licence
MIT. See LICENSE.
