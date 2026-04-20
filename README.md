# ClawMine — OpenClaw Plugin

> Track your AI token usage and earn on-chain CLAW token rewards automatically.

## What It Does

ClawMine is a community OpenClaw plugin that:

- Tracks token usage across all your OpenClaw agent sessions
- Reports usage to the ClawMine settlement service each epoch
- Lets you bind a Solana wallet and claim CLAW token rewards

## Installation

1. Clone the repo:
   ```bash
   git clone https://github.com/herrcai/ClawMine.git ~/ClawMine
   ```

2. Add to `~/.openclaw/openclaw.json`:
   ```json
   {
     "plugins": {
       "paths": ["~/ClawMine/openclaw-plugin"],
       "entries": {
         "clawmine": {
           "enabled": true,
           "config": {
             "settlementApiUrl": "https://api.clawmine.xyz",
             "internalApiKey": "YOUR_API_KEY",
             "serverSecret": "YOUR_SERVER_SECRET"
           }
         }
       }
     }
   }
   ```

3. Restart OpenClaw Gateway:
   ```bash
   openclaw gateway restart
   ```

## Commands

| Command | Description |
|---------|-------------|
| `/mine-bind <wallet>` | Bind your Solana wallet address |
| `/mine-status` | View current epoch status and estimated rewards |
| `/mine-rewards` | View reward history |

## How It Works

```
OpenClaw session ends
  → llm_output hook captures token usage
  → HMAC-signed report sent to settlement service
  → Aggregated per epoch (default: 7 days)
  → Merkle tree generated and submitted on-chain
  → Users claim CLAW tokens via Solana
```

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `settlementApiUrl` | No | Settlement service URL (default: `http://localhost:3100`) |
| `internalApiKey` | Yes | API key provided by the ClawMine operator |
| `serverSecret` | Yes | HMAC secret for report signing (must match server) |

## Security

- All usage reports are signed with **HMAC-SHA256** to prevent tampering
- Wallet binding uses **ed25519 signature verification**
- On-chain claims are protected by **Merkle proof** verification

## License

MIT
