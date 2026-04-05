"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * ClawMine — OpenClaw Plugin
 *
 * 功能：
 *   1. registerService  — 生成/加载唯一 userId，发送激活心跳，定期扫描 session 文件采集 token usage
 *   2. /mine-bind       — 开始钱包绑定流程（生成签名挑战）
 *   3. /mine-verify     — 提交签名完成绑定
 *   4. /mine-status     — 查看当前 epoch 状态
 *   5. /mine-rewards    — 查看历史奖励
 */
const plugin_sdk_1 = require("openclaw/plugin-sdk");
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const readline = __importStar(require("readline"));
// ─── 常量 ──────────────────────────────────────────────────────────────────────
const OPENCLAW_DIR = path.join(process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(), '.openclaw');
const SESSIONS_BASE = path.join(OPENCLAW_DIR, 'agents');
const USER_ID_FILE = path.join(OPENCLAW_DIR, 'clawmine-user.json');
// ─── 用户 ID 管理 ─────────────────────────────────────────────────────────────
/**
 * 加载或生成唯一 userId。
 * 首次调用时生成 UUID 并写入 ~/.openclaw/clawmine-user.json，
 * 后续调用读取同一文件保证跨 session / 重启一致。
 */
function loadOrCreateUserId() {
    try {
        if (fs.existsSync(USER_ID_FILE)) {
            const data = JSON.parse(fs.readFileSync(USER_ID_FILE, 'utf-8'));
            if (data.user_id && typeof data.user_id === 'string')
                return data.user_id;
        }
    }
    catch {
        // 文件损坏 → 重新生成
    }
    const userId = (0, crypto_1.randomUUID)();
    fs.writeFileSync(USER_ID_FILE, JSON.stringify({ user_id: userId, created_at: new Date().toISOString() }, null, 2));
    return userId;
}
// ─── HMAC 签名 ────────────────────────────────────────────────────────────────
function signRecord(r, secret) {
    const payload = [
        r.request_id, r.user_id, r.agent_id, r.workflow_id ?? '',
        r.provider, r.model,
        r.prompt_tokens, r.completion_tokens, r.total_tokens,
        r.timestamp,
    ].join('|');
    return (0, crypto_1.createHmac)('sha256', secret).update(payload).digest('hex');
}
function reply(text) {
    return { text };
}
// ─── Session 文件扫描 ──────────────────────────────────────────────────────────
// 记录每个 session 文件已扫描到的消息 ID 集合
const scannedMessages = new Map();
/**
 * 扫描单个 session .jsonl 文件，提取未上报的 assistant usage 记录
 */
async function scanSessionFile(filePath) {
    const results = [];
    if (!fs.existsSync(filePath))
        return results;
    const seen = scannedMessages.get(filePath) ?? new Set();
    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line.trim())
            continue;
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (entry.type !== 'message')
            continue;
        if (entry.message?.role !== 'assistant')
            continue;
        if (!entry.message?.usage)
            continue;
        if (seen.has(entry.id))
            continue;
        const usage = entry.message.usage;
        const total = usage.totalTokens ?? (usage.input + usage.output);
        if (!total || total === 0)
            continue;
        results.push({
            provider: entry.message.provider ?? 'unknown',
            model: entry.message.model ?? 'unknown',
            prompt: usage.input ?? 0,
            completion: usage.output ?? 0,
            total,
            msgId: entry.id,
            ts: entry.message.timestamp ?? Date.now(),
        });
        seen.add(entry.id);
    }
    scannedMessages.set(filePath, seen);
    return results;
}
/**
 * 扫描所有 agent sessions，上报未记录的 usage
 */
async function scanAndReport(apiUrl, apiKey, secret, userId, logger) {
    if (!fs.existsSync(SESSIONS_BASE))
        return;
    const agentDirs = fs.readdirSync(SESSIONS_BASE).filter(d => fs.statSync(path.join(SESSIONS_BASE, d)).isDirectory());
    const records = [];
    for (const agentId of agentDirs) {
        const sessionsDir = path.join(SESSIONS_BASE, agentId, 'sessions');
        if (!fs.existsSync(sessionsDir))
            continue;
        const sessionFiles = fs.readdirSync(sessionsDir)
            .filter(f => f.endsWith('.jsonl') && !f.includes('.reset.'))
            .map(f => path.join(sessionsDir, f));
        // 只扫最近修改的文件（24小时内）
        const recent = sessionFiles.filter(f => {
            try {
                const stat = fs.statSync(f);
                return Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000;
            }
            catch {
                return false;
            }
        });
        for (const filePath of recent) {
            const entries = await scanSessionFile(filePath);
            for (const e of entries) {
                // 将 msgId 转换为确定性 UUID（msgId 是短 hex）
                const paddedId = e.msgId.padStart(32, '0').slice(0, 32);
                const deterministicUuid = [
                    paddedId.slice(0, 8),
                    paddedId.slice(8, 12),
                    '4' + paddedId.slice(13, 16),
                    '8' + paddedId.slice(17, 20),
                    paddedId.slice(20, 32),
                ].join('-');
                const base = {
                    request_id: deterministicUuid,
                    user_id: userId, // ✅ 使用持久化的唯一 userId
                    agent_id: agentId,
                    provider: e.provider,
                    model: e.model,
                    prompt_tokens: e.prompt,
                    completion_tokens: e.completion,
                    total_tokens: e.total,
                    timestamp: e.ts,
                };
                records.push({ ...base, record_hash: signRecord(base, secret) });
            }
        }
    }
    if (records.length === 0)
        return;
    logger.info(`[ClawMine] Reporting ${records.length} usage records (batched)`);
    // 分批发送，每批最多 100 条
    const BATCH_SIZE = 100;
    let accepted = 0;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE);
        try {
            const res = await fetch(`${apiUrl}/api/metering`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
                body: JSON.stringify({ records: batch }),
            });
            if (!res.ok) {
                const body = await res.text();
                logger.warn(`[ClawMine] metering batch ${i}-${i + batch.length} failed: ${res.status} ${body}`);
            }
            else {
                const data = await res.json();
                accepted += data.accepted;
            }
        }
        catch (err) {
            logger.warn(`[ClawMine] metering write failed: ${err.message}`);
        }
    }
    logger.info(`[ClawMine] Reported ${accepted}/${records.length} records OK`);
}
/**
 * 向 service 注册/激活本节点。
 * 若 userId 已注册则 service 返回 200（幂等），不会重复创建。
 */
async function registerNode(apiUrl, apiKey, userId, logger) {
    try {
        const hostname = os.hostname();
        const res = await fetch(`${apiUrl}/api/users/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
            body: JSON.stringify({ user_id: userId, hostname }),
        });
        if (res.ok) {
            logger.info(`[ClawMine] Node registered (userId=${userId})`);
        }
        else {
            logger.warn(`[ClawMine] Node registration returned ${res.status}`);
        }
    }
    catch (err) {
        // 注册失败不阻塞启动，service 可能暂时不可达
        logger.warn(`[ClawMine] Node registration failed: ${err.message}`);
    }
}
/**
 * 发送在线心跳（每 5 分钟一次）
 */
async function sendHeartbeat(apiUrl, apiKey, userId, logger) {
    try {
        await fetch(`${apiUrl}/api/users/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
            body: JSON.stringify({ user_id: userId, ts: Date.now() }),
        });
    }
    catch {
        // 心跳失败静默处理，不打 log（避免日志噪音）
    }
}
// ─── Plugin Entry ─────────────────────────────────────────────────────────────
exports.default = (0, plugin_sdk_1.definePluginEntry)({
    id: "clawmine",
    name: "ClawMine",
    description: "Token usage tracking + Solana on-chain reward settlement",
    register(api) {
        const pluginConfig = api.pluginConfig;
        const apiUrl = pluginConfig.settlementApiUrl ?? "http://127.0.0.1:3100";
        const apiKey = pluginConfig.internalApiKey ?? "claw-settle-dev-key-2026";
        const secret = pluginConfig.serverSecret ?? "claw-settle-dev-secret-2026";
        // ── 加载/生成唯一 userId ──────────────────────────────────────────────────
        const userId = loadOrCreateUserId();
        api.logger.info(`[ClawMine] userId=${userId}`);
        // ── 1. 后台 session 扫描 + 心跳服务 ──────────────────────────────────────
        api.registerService({
            id: 'claw-settle-scanner',
            async start() {
                api.logger.info('[ClawMine] Session scanner started');
                // 启动时注册节点
                await registerNode(apiUrl, apiKey, userId, api.logger);
                // 启动时立即扫一次
                await scanAndReport(apiUrl, apiKey, secret, userId, api.logger);
                // 每 60 秒扫一次
                setInterval(() => {
                    scanAndReport(apiUrl, apiKey, secret, userId, api.logger).catch(err => api.logger.warn(`[ClawMine] scan error: ${err.message}`));
                }, 60000);
                // 每 5 分钟发送心跳
                setInterval(() => {
                    sendHeartbeat(apiUrl, apiKey, userId, api.logger);
                }, 5 * 60000);
            },
        });
        // ── 2. /mine-bind ─────────────────────────────────────────────────────────
        api.registerCommand({
            name: "mine-bind",
            description: "Bind your Solana wallet to receive ClawMine rewards. Usage: /mine-bind <wallet-address>",
            acceptsArgs: true,
            async handler(ctx) {
                const walletAddress = ctx.args?.trim();
                if (!walletAddress) {
                    return reply("❌ Please provide a wallet address: `/mine-bind <Solana wallet address>`");
                }
                try {
                    const res = await fetch(`${apiUrl}/api/wallet/challenge`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ user_id: userId, wallet_address: walletAddress }),
                    });
                    const data = await res.json();
                    return reply([
                        `🔐 **钱包绑定挑战已生成**`,
                        `钱包地址：\`${walletAddress}\``,
                        `有效期：${new Date(data.expiresAt).toLocaleString('zh-CN')}`,
                        ``,
                        `**请用你的 Solana 钱包对以下字符串签名：**`,
                        `\`\`\``,
                        data.challenge,
                        `\`\`\``,
                        `签名后运行：/mine-verify ${data.nonce} ${walletAddress} <your Base58 signature>`,
                    ].join('\n'));
                }
                catch (err) {
                    return reply(`❌ 请求失败：${err.message}`);
                }
            },
        });
        // ── 3. /mine-verify ───────────────────────────────────────────────────────
        api.registerCommand({
            name: "mine-verify",
            description: "Submit wallet signature to complete binding. Usage: /mine-verify <nonce> <wallet-address> <signature>",
            acceptsArgs: true,
            async handler(ctx) {
                const parts = ctx.args?.trim().split(/\s+/) ?? [];
                if (parts.length < 3)
                    return reply("❌ Usage: `/mine-verify <nonce> <wallet-address> <signature>`");
                const [nonce, walletAddress, signature] = parts;
                try {
                    const res = await fetch(`${apiUrl}/api/wallet/verify`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ nonce, wallet_address: walletAddress, signature }),
                    });
                    const data = await res.json();
                    if (!res.ok || !data.success)
                        return reply(`❌ 验证失败：${data.error ?? '未知错误'}`);
                    return reply(`✅ **钱包绑定成功！** \`${walletAddress}\` 已关联到你的节点。从下一个 Epoch 起开始累积奖励。`);
                }
                catch (err) {
                    return reply(`❌ 验证失败：${err.message}`);
                }
            },
        });
        // ── 4. /mine-status ───────────────────────────────────────────────────────
        api.registerCommand({
            name: "mine-status",
            description: "View current epoch status and your reward summary",
            async handler(_ctx) {
                try {
                    const [epochRes, rewardsRes] = await Promise.all([
                        fetch(`${apiUrl}/api/epochs/current`),
                        fetch(`${apiUrl}/api/rewards/${userId}`),
                    ]);
                    const epoch = epochRes.ok ? await epochRes.json() : null;
                    const rewardsData = rewardsRes.ok ? await rewardsRes.json() : { rewards: [] };
                    const lines = [`📊 **ClawMine 状态**`, ``, `🆔 节点ID：\`${userId.slice(0, 8)}...\``];
                    if (epoch) {
                        const diff = new Date(epoch.end_time).getTime() - Date.now();
                        const mins = Math.max(0, Math.floor(diff / 60000));
                        lines.push(``, `**当前周期 #${epoch.epoch_id}** | 还剩 ${mins} 分钟 | 奖励池：${(BigInt(epoch.reward_pool) / 1000000n).toString()} Token`);
                    }
                    lines.push(``, `奖励记录：${rewardsData.rewards.length} 条 | \`/mine-rewards\` 查看详情`);
                    return reply(lines.join('\n'));
                }
                catch (err) {
                    return reply(`❌ 获取状态失败：${err.message}`);
                }
            },
        });
        // ── 5. /mine-rewards ──────────────────────────────────────────────────────
        api.registerCommand({
            name: "mine-rewards",
            description: "View your full reward history",
            async handler(_ctx) {
                try {
                    const res = await fetch(`${apiUrl}/api/rewards/${userId}`);
                    const data = await res.json();
                    const rewards = data.rewards ?? [];
                    if (rewards.length === 0)
                        return reply(`💎 **奖励记录**\n\n暂无记录。使用 Token 后会在 Epoch 结算时计入。`);
                    const lines = [`💎 **奖励记录**`, ``];
                    for (const r of rewards) {
                        const badge = r.claimed ? '✅ 已领取' : r.status === 'finalized' ? '💰 可领取' : '⏳ 结算中';
                        lines.push(`**周期 #${r.epoch_id}** ${badge} — ${(Number(r.reward_amount) / 1000000).toFixed(6)} Claw (${Number(r.total_tokens).toLocaleString()} tokens)`, ``);
                    }
                    return reply(lines.join('\n'));
                }
                catch (err) {
                    return reply(`❌ 获取奖励失败：${err.message}`);
                }
            },
        });
        api.logger.info("[ClawMine] Plugin loaded — session scanner active");
    },
});
