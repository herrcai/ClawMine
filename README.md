# claw-settle

> OpenClaw 用户激励结算系统 — 按 AI token 使用量自动分发 CLAW token 奖励

## 概述

claw-settle 是一个面向 [OpenClaw](https://openclaw.ai) 的第三方激励插件。它自动采集用户在 OpenClaw 中消耗的 AI token 量，按周期（Epoch）生成 Merkle 分配树，并通过 Solana 合约支持用户 Claim 奖励。

```
OpenClaw 对话
  → llm_output hook 采集 token 用量
  → settlement-service 累计入库
  → Epoch 到期自动结算 (Merkle Tree)
  → 用户绑定 Solana 钱包 Claim CLAW token
```

## 项目结构

```
claw-settle/
├── gateway-plugin/        # OpenClaw Gateway 计量拦截插件（TypeScript）
├── openclaw-plugin/       # OpenClaw 插件（命令 + llm_output hook）
├── settlement-service/    # 结算后端（Fastify + PostgreSQL）
├── solana-contract/       # Solana 合约（Rust + Anchor）
├── frontend/              # 数据展示 UI（React + Vite）
├── scripts/
│   ├── install.sh         # 一键安装（macOS/Linux）
│   └── uninstall.sh       # 卸载
└── docs/
    └── architecture.md    # 架构文档
```

## 快速开始

### 前置要求

- Node.js >= 18
- PostgreSQL >= 14
- OpenClaw（已安装并运行）

### 安装

```bash
git clone https://github.com/your-org/claw-settle
cd claw-settle

# 一键安装（自动配置系统服务）
./scripts/install.sh
```

安装脚本会自动：
1. 安装 npm 依赖并编译
2. 初始化 PostgreSQL 数据库
3. 注册系统服务（macOS: launchd / Linux: systemd）
4. 验证服务健康状态

### 配置

编辑 `settlement-service/.env`：

```env
PORT=3100
HOST=127.0.0.1

# 必须修改为强密钥！
INTERNAL_API_KEY=your-secret-key
SERVER_SECRET=your-hmac-secret

# PostgreSQL
DATABASE_URL=postgresql://localhost/claw_settle

# Solana 网络
SOLANA_RPC_URL=https://api.devnet.solana.com

# 每 Epoch 奖励总量（单位：最小精度，6位小数）
# 1000000000 = 1000 CLAW
EPOCH_REWARD_POOL=1000000000
```

### 注册 OpenClaw 插件

在 `~/.openclaw/openclaw.json` 中添加：

```json
{
  "plugins": {
    "load": {
      "paths": ["<claw-settle路径>/openclaw-plugin"]
    },
    "entries": {
      "claw-settle": {
        "enabled": true,
        "config": {
          "settlementApiUrl": "http://127.0.0.1:3100",
          "internalApiKey": "your-secret-key",
          "serverSecret": "your-hmac-secret"
        }
      }
    }
  }
}
```

然后重启 OpenClaw Gateway：

```bash
openclaw gateway restart
```

## 使用

### 在 OpenClaw 中绑定钱包

直接在 OpenClaw 对话中说：

```
绑定钱包 <你的Solana地址>
```

### 查询收益

```
/settle-status    # 当前 Epoch 状态 + 收益概览
/settle-rewards   # 历史奖励记录
```

### API

| 端点 | 说明 |
|------|------|
| `GET /health` | 健康检查 |
| `POST /api/wallet/challenge` | 生成钱包绑定挑战 |
| `POST /api/wallet/verify` | 验证签名完成绑定 |
| `GET /api/wallet/:userId` | 查询绑定钱包 |
| `GET /api/rewards/:userId` | 查询奖励记录 |
| `GET /api/epochs/current` | 当前 Epoch 信息 |
| `POST /api/metering` | 写入计量记录（内部） |

## 架构

### 计量流程

```
OpenClaw Agent 调用 LLM
  → openclaw-plugin llm_output hook
  → HMAC 签名防篡改
  → POST /api/metering
  → PostgreSQL metering_records 表
```

### 结算流程

```
Epoch 到期（默认 7 天）
  → epoch-scheduler 触发结算
  → 聚合所有用户 token 用量
  → 按比例计算 CLAW 分配
  → 生成 Merkle Tree
  → 提交链上（Solana）
  → 用户可 Claim
```

### 安全机制

- **HMAC-SHA256** 防止计量记录篡改
- **ed25519 签名验证** 钱包绑定防伪
- **Merkle proof** 链上验证分配合法性
- **ClaimRecord PDA** 防止重复 Claim

## 开发

```bash
# 启动开发服务
cd settlement-service && npm run dev

# 运行测试
npm test

# 查看日志（macOS）
tail -f ~/Library/Logs/claw-settle/stdout.log
```

## Solana 合约部署

```bash
# 安装 Anchor
cargo install --git https://github.com/coral-xyz/anchor anchor-cli --tag v0.29.0

# 部署到 devnet
cd solana-contract
anchor build
anchor deploy --provider.cluster devnet

# 更新 frontend 配置
echo "VITE_PROGRAM_ID=<部署后的Program ID>" >> ../frontend/.env
```

## 卸载

```bash
./scripts/uninstall.sh
```

## License

MIT

---

## 🚀 Quick Deploy（生产上线指南）

### 一、购买域名和服务器

**域名**（推荐 [Cloudflare Registrar](https://dash.cloudflare.com)，约 $10/年）
- 进入 Cloudflare Dashboard → 左侧 Domain Registration → Register a domain
- 推荐域名：`clawmine.xyz`（约$9）或 `clawmine.app`（约$14）
- 购买后在 DNS 设置：
  - A 记录：`api` → 服务器 IP（用于 settlement-service）
  - CNAME：`app` → `cname.vercel-dns.com`（用于前端）

**服务器**（[AWS Lightsail](https://lightsail.aws.amazon.com)，$5/月）
1. Create instance → Linux/Unix → OS Only → **Ubuntu 22.04**
2. 选 **Singapore** 或 Tokyo 区域（亚洲用户延迟低）
3. Plan 选 **$5/month**（1 vCPU / 1GB RAM）
4. 创建后：Networking → 附加 **Static IP**（免费）
5. 开放防火墙端口：TCP **22, 80, 443**

---

### 二、部署 Settlement Service（SSH 后一键执行）

```bash
# SSH 进入服务器
ssh ubuntu@YOUR_SERVER_IP

# 下载并运行部署脚本（约 5 分钟）
curl -fsSL https://raw.githubusercontent.com/herrcai/ClawMine/main/deploy/setup-server.sh -o setup.sh
bash setup.sh
```

脚本自动完成：安装 Node.js + PostgreSQL + Nginx + PM2，克隆代码，执行 DB 迁移，配置防火墙。

**脚本结束时会输出两个密钥，务必保存：**
```
INTERNAL_API_KEY = xxxx  ← 插件配置需要
SERVER_SECRET    = xxxx  ← 插件配置需要
```

**配置 SSL（替换为你的域名）：**
```bash
sudo certbot --nginx -d api.yourdomain.xyz
```

**验证服务：**
```bash
curl https://api.yourdomain.xyz/health
# → {"status":"ok","service":"claw-settle"}
```

---

### 三、部署前端（Vercel，免费）

```bash
# 本地执行
cd frontend
npm install

# 方式 A：命令行一键部署
VITE_API_URL=https://api.yourdomain.xyz npx vercel --prod

# 方式 B：Vercel Dashboard
# 1. vercel.com → New Project → Import GitHub repo
# 2. Framework: Vite
# 3. 环境变量：VITE_API_URL = https://api.yourdomain.xyz
```

---

### 四、用户安装 ClawMine 插件

1. Clone 插件 repo：
```bash
git clone https://github.com/herrcai/ClawMine.git ~/ClawMine
```

2. 在 `~/.openclaw/openclaw.json` 添加：
```json
"plugins": {
  "paths": ["/Users/你的用户名/ClawMine/openclaw-plugin"],
  "entries": {
    "clawmine": {
      "enabled": true,
      "config": {
        "settlementApiUrl": "https://api.yourdomain.xyz",
        "internalApiKey": "YOUR_INTERNAL_API_KEY",
        "serverSecret": "YOUR_SERVER_SECRET"
      }
    }
  }
}
```

3. 重启 OpenClaw Gateway：
```bash
openclaw gateway restart
```

4. 绑定 Solana 钱包：
```
/mine-bind YOUR_SOLANA_WALLET_ADDRESS
```

插件启动后自动：生成唯一 userId → 注册节点 → 每60秒上报 token 使用 → 每5分钟心跳。

---

### 五、Solana Mainnet 迁移

```bash
# 1. 修改 .env
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
# 推荐付费 RPC：https://helius.dev（免费额度够 MVP 阶段）

# 2. 重新部署合约到 Mainnet
cd solana-contract
anchor build
anchor deploy --provider.cluster mainnet-beta

# 3. 更新 .env 里的合约地址
REWARD_PROGRAM_ID=<新地址>
REWARD_MINT=<新地址>

# 4. 重启服务
pm2 restart clawmine
```

---

### 六、成本估算（MVP 阶段）

| 项目 | 费用 |
|------|------|
| 域名（Cloudflare Registrar） | ~$10/年 |
| AWS Lightsail $5/月 | $60/年 |
| Vercel 前端托管 | 免费 |
| Helius RPC（Devnet/Mainnet 免费额度） | 免费 |
| Solana 合约部署 gas | ~0.5 SOL |
| **MVP 总计** | **约 $70/年** |

升级路径：用户超过 500 节点时升级到 Lightsail $10/月（2vCPU/2GB）。

---

## 🚀 Quick Deploy

### 一、购买服务器和域名

**域名**（推荐 Cloudflare Registrar，约 $10/年）
- 注册：https://dash.cloudflare.com → Domain Registration
- 推荐：`clawmine.xyz` 或 `clawmine.app`
- DNS 设置：A 记录 `api` → 服务器 IP，CNAME `app` → Vercel

**服务器**（AWS Lightsail，$5/月）
1. https://lightsail.aws.amazon.com → Create instance
2. Linux/Unix → Ubuntu 22.04 → $5 plan
3. 选 Singapore 或 Tokyo 区域
4. 附加 Static IP（免费）
5. 开放端口：TCP 80, 443

---

### 二、部署 Settlement Service（一键）

SSH 进入服务器后：

```bash
# 下载并运行部署脚本
curl -fsSL https://raw.githubusercontent.com/herrcai/ClawMine/main/deploy/setup-server.sh -o setup.sh
bash setup.sh

# 脚本会输出 INTERNAL_API_KEY 和 SERVER_SECRET，务必保存！
```

**配置 SSL（替换 yourdomain.xyz）：**
```bash
sudo certbot --nginx -d api.yourdomain.xyz
```

**验证：**
```bash
curl https://api.yourdomain.xyz/health
# → {"status":"ok","service":"claw-settle"}
```

---

### 三、部署前端（Vercel，免费）

```bash
cd frontend
npm install
VITE_API_URL=https://api.yourdomain.xyz npx vercel --prod
```

或在 Vercel Dashboard 设置环境变量 `VITE_API_URL`。

---

### 四、用户安装插件

用户在 OpenClaw 的 `openclaw.json` 中添加：

```json
"plugins": {
  "paths": ["~/.openclaw/workspace/ClawMine/openclaw-plugin"],
  "entries": {
    "clawmine": {
      "enabled": true,
      "config": {
        "settlementApiUrl": "https://api.yourdomain.xyz",
        "internalApiKey": "YOUR_INTERNAL_API_KEY_FROM_SETUP",
        "serverSecret": "YOUR_SERVER_SECRET_FROM_SETUP"
      }
    }
  }
}
```

然后重启 OpenClaw Gateway。插件会自动：
1. 生成持久化 userId（存储在 `~/.openclaw/clawmine-user.json`）
2. 向服务器注册节点
3. 每 60 秒扫描 token 使用并上报
4. 每 5 分钟发送心跳

绑定 Solana 钱包：
```
/mine-bind YOUR_SOLANA_WALLET_ADDRESS
```

---

### 五、Solana Mainnet 迁移（上线时）

1. 在 `.env` 中修改：
   ```
   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
   ```
   （推荐使用付费 RPC：Helius https://helius.dev 免费额度够 MVP）

2. 重新部署合约到 Mainnet：
   ```bash
   anchor build && anchor deploy --provider.cluster mainnet-beta
   ```

3. 更新 `.env` 中的 `REWARD_PROGRAM_ID` 和 `REWARD_MINT`

4. 重启服务：`pm2 restart clawmine`

---

### 六、成本估算

| 项目 | 费用 |
|------|------|
| 域名（Cloudflare） | ~$10/年 |
| AWS Lightsail $5 plan | $5/月 = $60/年 |
| Vercel 前端 | 免费 |
| Helius RPC（Devnet/MVP） | 免费 |
| Solana 合约部署（Devnet） | 免费 |
| **总计 MVP 阶段** | **~$70/年** |

---
