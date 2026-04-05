# ClawMine — OpenClaw Plugin

> *Every conversation you have with AI takes effort — your time, your thoughts, your tokens. ClawMine recognizes that.*

ClawMine quietly tracks every token you spend across your OpenClaw agents and converts your interactions into on-chain Solana rewards. Bind your wallet, keep talking to your AI, and watch your contributions turn into Claw Token you can claim.

> ⚠️ **Disclaimer:** This is a **community-built plugin, not affiliated with or endorsed by OpenClaw**. Claw Token is an independent project. Use at your own discretion.

## What It Does

ClawMine is an OpenClaw plugin that runs silently in the background and:

1. **Scans your local session files** — collects token usage from all your agents every 60 seconds
2. **Reports to the ClawMine service** — securely signs and uploads usage records via HMAC
3. **Links your Solana wallet** — bind your wallet with a cryptographic challenge/verify flow
4. **Shows your rewards** — check your pending and claimable Claw Token rewards anytime

You keep full control of your data. The plugin only reads local `.jsonl` session files — nothing else.

## Quick Start

### 1. Clone and build

```bash
git clone https://github.com/herrcai/ClawMine
cd ClawMine
npm install
npm run build
```

### 2. Register in your `openclaw.json`

Open `~/.openclaw/config/openclaw.json` (create it if it doesn't exist) and add:

```json
{
  "plugins": {
    "entries": {
      "clawmine": {
        "path": "/absolute/path/to/ClawMine",
        "config": {
          "settlementApiUrl": "https://settle.clawmine.xyz",
          "internalApiKey": "your-api-key-here",
          "serverSecret": "your-hmac-secret-here"
        }
      }
    }
  }
}
```

> **Get your credentials:** Register at [https://settle.clawmine.xyz](https://settle.clawmine.xyz), bind your account, and copy your API key + secret from the Settings page.

### 3. Restart OpenClaw Gateway

```bash
openclaw gateway restart
```

That's it. Token tracking starts automatically within 60 seconds.

## Commands

| Command | Description |
|---------|-------------|
| `/settle-bind <wallet>` | Start wallet binding — generates a signing challenge |
| `/settle-verify <nonce> <wallet> <signature>` | Submit your wallet signature to complete binding |
| `/settle-status` | View current epoch status and your reward summary |
| `/settle-rewards` | View full history of earned rewards |

### Wallet Binding Flow

```
/settle-bind 7xKXtg2CW87d97TXJSDpbD5jBkheTqA36YnPTESwFVtK
→ Generates a challenge string

# Sign the challenge with your Solana wallet (Phantom, Solflare, CLI, etc.)
# Then submit:
/settle-verify <nonce> <wallet> <base58-signature>
→ ✅ Wallet bound! Rewards will accumulate from the next epoch.
```

## How Rewards Work

1. **Epoch** — a fixed time window (e.g., 1 week) during which usage is tracked
2. **Merkle settlement** — at epoch end, a Merkle tree is computed from all usage records
3. **On-chain** — the Merkle root is posted to Solana; your allocation is provably yours
4. **Claim** — visit the dashboard or use `/settle-rewards` to see claimable amounts; claim directly from the web UI

## Configuration Reference

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `settlementApiUrl` | Yes | `http://localhost:3100` | URL of the ClawMine settlement service |
| `internalApiKey` | Yes | — | API key from ClawMine dashboard |
| `serverSecret` | Yes | — | HMAC signing secret (must match server config) |

## Privacy & Security

- **Local reads only** — the plugin reads `~/.openclaw/agents/*/sessions/*.jsonl` files
- **HMAC signed** — every record is signed before upload; the server rejects tampered data
- **No private keys** — wallet binding uses cryptographic challenge/response, your keys never leave your device
- **Open source** — this plugin is fully auditable; the ClawMine settlement service is operated separately

## Requirements

- OpenClaw Gateway `>= 2026.3.24-beta.2`
- Plugin API `>= 2026.3.24-beta.2`
- Node.js `>= 18`

## Building from Source

```bash
npm install
npm run build
```

## License

MIT
