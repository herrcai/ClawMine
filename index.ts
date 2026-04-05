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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { definePluginEntry } = require("./node_modules/openclaw/dist/plugin-sdk/plugin-entry.js") as typeof import("./node_modules/openclaw/dist/plugin-sdk/plugin-entry");
import { createHmac, randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import type { PluginCommandContext } from "./node_modules/openclaw/dist/plugin-sdk/plugin-entry";

// ─── 常量 ──────────────────────────────────────────────────────────────────────

const OPENCLAW_DIR   = path.join(process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(), '.openclaw');
const SESSIONS_BASE  = path.join(OPENCLAW_DIR, 'agents');
const USER_ID_FILE   = path.join(OPENCLAW_DIR, 'clawmine-user.json');

// ─── 用户 ID 管理 ─────────────────────────────────────────────────────────────

/**
 * 加载或生成唯一 userId。
 * 首次调用时生成 UUID 并写入 ~/.openclaw/clawmine-user.json，
 * 后续调用读取同一文件保证跨 session / 重启一致。
 */
function loadOrCreateUserId(): string {
  try {
    if (fs.existsSync(USER_ID_FILE)) {
      const data = JSON.parse(fs.readFileSync(USER_ID_FILE, 'utf-8'));
      if (data.user_id && typeof data.user_id === 'string') return data.user_id;
    }
  } catch {
    // 文件损坏 → 重新生成
  }
  const userId = randomUUID();
  fs.writeFileSync(USER_ID_FILE, JSON.stringify({ user_id: userId, created_at: new Date().toISOString() }, null, 2));
  return userId;
}

// ─── HMAC 签名 ────────────────────────────────────────────────────────────────

function signRecord(r: {
  request_id: string; user_id: string; agent_id: string;
  workflow_id?: string; provider: string; model: string;
  prompt_tokens: number; completion_tokens: number; total_tokens: number;
  timestamp: number;
}, secret: string): string {
  const payload = [
    r.request_id, r.user_id, r.agent_id, r.workflow_id ?? '',
    r.provider, r.model,
    r.prompt_tokens, r.completion_tokens, r.total_tokens,
    r.timestamp,
  ].join('|');
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function reply(text: string) {
  return { text };
}

// ─── Session 文件扫描 ──────────────────────────────────────────────────────────

// 记录每个 session 文件已扫描到的消息 ID 集合
const scannedMessages = new Map<string, Set<string>>();

/**
 * 扫描单个 session .jsonl 文件，提取未上报的 assistant usage 记录
 */
async function scanSessionFile(
  filePath: string,
): Promise<Array<{ provider: string; model: string; prompt: number; completion: number; total: number; msgId: string; ts: number }>> {
  const results: Array<{ provider: string; model: string; prompt: number; completion: number; total: number; msgId: string; ts: number }> = [];

  if (!fs.existsSync(filePath)) return results;

  const seen = scannedMessages.get(filePath) ?? new Set<string>();
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.type !== 'message') continue;
    if (entry.message?.role !== 'assistant') continue;
    if (!entry.message?.usage) continue;
    if (seen.has(entry.id)) continue;

    const usage = entry.message.usage;
    const total = usage.totalTokens ?? (usage.input + usage.output);
    if (!total || total === 0) continue;

    results.push({
      provider:   entry.message.provider ?? 'unknown',
      model:      entry.message.model    ?? 'unknown',
      prompt:     usage.input      ?? 0,
      completion: usage.output     ?? 0,
      total,
      msgId: entry.id,
      ts:    entry.message.timestamp ?? Date.now(),
    });

    seen.add(entry.id);
  }

  scannedMessages.set(filePath, seen);
  return results;
}

/**
 * 扫描所有 agent sessions，上报未记录的 usage
 */
async function scanAndReport(
  apiUrl: string,
  apiKey: string,
  secret: string,
  userId: string,
  logger: any,
) {
  if (!fs.existsSync(SESSIONS_BASE)) return;

  const agentDirs = fs.readdirSync(SESSIONS_BASE).filter(d =>
    fs.statSync(path.join(SESSIONS_BASE, d)).isDirectory()
  );

  const records: any[] = [];

  for (const agentId of agentDirs) {
    const sessionsDir = path.join(SESSIONS_BASE, agentId, 'sessions');
    if (!fs.existsSync(sessionsDir)) continue;

    const sessionFiles = fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.jsonl') && !f.includes('.reset.'))
      .map(f => path.join(sessionsDir, f));

    // 只扫最近修改的文件（24小时内）
    const recent = sessionFiles.filter(f => {
      try {
        const stat = fs.statSync(f);
        return Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000;
      } catch { return false; }
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
          request_id:        deterministicUuid,
          user_id:           userId,   // ✅ 使用持久化的唯一 userId
          agent_id:          agentId,
          provider:          e.provider,
          model:             e.model,
          prompt_tokens:     e.prompt,
          completion_tokens: e.completion,
          total_tokens:      e.total,
          timestamp:         e.ts,
        };
        records.push({ ...base, record_hash: signRecord(base, secret) });
      }
    }
  }

  if (records.length === 0) return;

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
      } else {
        const data = await res.json() as { accepted: number; rejected: number };
        accepted += data.accepted;
      }
    } catch (err) {
      logger.warn(`[ClawMine] metering write failed: ${(err as Error).message}`);
    }
  }
  logger.info(`[ClawMine] Reported ${accepted}/${records.length} records OK`);
}

/**
 * 向 service 注册/激活本节点。
 * 若 userId 已注册则 service 返回 200（幂等），不会重复创建。
 */
async function registerNode(
  apiUrl: string,
  apiKey: string,
  userId: string,
  logger: any,
): Promise<void> {
  try {
    const hostname = os.hostname();
    const res = await fetch(`${apiUrl}/api/users/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: JSON.stringify({ user_id: userId, hostname }),
    });
    if (res.ok) {
      logger.info(`[ClawMine] Node registered (userId=${userId})`);
    } else {
      logger.warn(`[ClawMine] Node registration returned ${res.status}`);
    }
  } catch (err) {
    // 注册失败不阻塞启动，service 可能暂时不可达
    logger.warn(`[ClawMine] Node registration failed: ${(err as Error).message}`);
  }
}

/**
 * 发送在线心跳（每 5 分钟一次）
 */
async function sendHeartbeat(
  apiUrl: string,
  apiKey: string,
  userId: string,
  logger: any,
): Promise<void> {
  try {
    await fetch(`${apiUrl}/api/users/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: JSON.stringify({ user_id: userId, ts: Date.now() }),
    });
  } catch {
    // 心跳失败静默处理，不打 log（避免日志噪音）
  }
}

// ─── 本地临时 HTTP 绑定服务 ──────────────────────────────────────────────────────

import * as http from 'http';
import { exec as execChild } from 'child_process';

/** 生成绑定页面 HTML。页面自身连接钒包后，先向 service 动态申请 challenge，再签名。 */
function buildBindPage(params: {
  userId: string;
  callbackPort: number;
  apiUrl: string;
}): string {
  const { userId, callbackPort, apiUrl } = params;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ClawMine — Bind Wallet</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0a0a0a;color:#e5e5e5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
    .card{background:#111;border:1px solid #222;border-radius:16px;padding:40px;max-width:480px;width:100%;text-align:center}
    .logo{font-size:32px;margin-bottom:16px}
    h1{font-size:22px;font-weight:700;margin-bottom:8px}
    .sub{font-size:14px;color:#666;margin-bottom:24px;line-height:1.6}
    .node-id{font-size:11px;color:#444;margin-bottom:24px;font-family:ui-monospace,monospace;padding:8px 12px;background:#0f1117;border-radius:6px;display:inline-block}
    .challenge-box{background:#0f1117;border:1px solid #1a1a1a;border-radius:8px;
      padding:12px 14px;font-family:ui-monospace,monospace;font-size:11px;
      color:#38bdf8;text-align:left;word-break:break-all;margin-bottom:24px;line-height:1.6;display:none}
    .btn{width:100%;height:48px;border-radius:10px;font-size:15px;font-weight:600;
         cursor:pointer;transition:all .15s;border:none}
    .btn-primary{background:#fff;color:#000}
    .btn-primary:hover{background:#f0f0f0}
    .btn-primary:disabled{background:#333;color:#666;cursor:not-allowed}
    .status{margin-top:20px;font-size:14px;color:#666;min-height:20px;line-height:1.6}
    .status.ok{color:#4ade80}
    .status.err{color:#f87171}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">⚡</div>
    <h1>Bind Your Wallet</h1>
    <p class="sub">Connect your Solana wallet to link it<br/>to your OpenClaw node and start earning CLAW.</p>
    <div class="node-id">Node: ${userId.slice(0, 8)}&hellip;</div>
    <div class="challenge-box" id="chal"></div>
    <button class="btn btn-primary" id="btn" onclick="doSign()">Connect & Sign with Phantom</button>
    <div class="status" id="status"></div>
  </div>
  <script>
    const USER_ID   = ${JSON.stringify(userId)};
    const CALLBACK  = 'http://127.0.0.1:${callbackPort}/callback';
    const API_URL   = ${JSON.stringify(apiUrl)};

    async function doSign() {
      const btn    = document.getElementById('btn');
      const status = document.getElementById('status');
      const chal   = document.getElementById('chal');
      btn.disabled = true;
      btn.textContent = 'Connecting\u2026';
      status.textContent = '';
      status.className = 'status';

      try {
        // 1. 查找 Phantom
        const provider = window.phantom?.solana ?? window.solana;
        if (!provider?.isPhantom) {
          throw new Error('Phantom not found. Install the Phantom browser extension and reload.');
        }

        // 2. 连接钒包
        const resp   = await provider.connect();
        const pubkey = resp.publicKey.toString();
        status.textContent = 'Connected: ' + pubkey.slice(0,6) + '\u2026' + pubkey.slice(-4);
        btn.textContent = 'Requesting challenge\u2026';

        // 3. 向 service 申请 challenge
        const cr = await fetch(API_URL + '/api/wallet/challenge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: USER_ID, wallet_address: pubkey }),
        });
        if (!cr.ok) throw new Error('Failed to get challenge: ' + await cr.text());
        const { nonce, challenge } = await cr.json();

        chal.textContent = challenge;
        chal.style.display = 'block';
        btn.textContent = 'Signing\u2026';

        // 4. Phantom 签名
        const encoded = new TextEncoder().encode(challenge);
        const { signature } = await provider.signMessage(encoded, 'utf8');
        const b58 = toBase58(signature);

        // 5. 回调插件验证
        btn.textContent = 'Verifying\u2026';
        const r = await fetch(CALLBACK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nonce, wallet_address: pubkey, signature: b58 }),
        });
        const result = await r.json();

        if (result.success) {
          btn.textContent = '\u2705 Wallet Bound!';
          btn.style.background = '#0f2a0f';
          btn.style.color = '#4ade80';
          status.innerHTML = '<strong style="color:#4ade80">' + pubkey.slice(0,6) + '\u2026' + pubkey.slice(-4) + '</strong><br/>Binding complete. Return to OpenClaw.';
          status.className = 'status ok';
          chal.style.display = 'none';
        } else {
          throw new Error(result.error ?? 'Binding failed');
        }
      } catch(e) {
        btn.disabled = false;
        btn.textContent = 'Connect & Sign with Phantom';
        status.textContent = '\u274c ' + (e.message ?? String(e));
        status.className = 'status err';
      }
    }

    function toBase58(bytes) {
      const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      let d=[],s='',j,c,n;
      for(let i=0;i<bytes.length;i++){
        j=0;c=bytes[i];
        s+=c===0&&s.length===0?'1':'';
        while(j<d.length||(c>0)){n=(d[j]||0)*256+c;d[j]=n%58;c=n/58|0;j++;}
      }
      while(d.length>0)s+=A[d.pop()];
      return s;
    }
  <\/script>
</body>
</html>`;
}

/** 打开浏览器 */
function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? `open "${url}"`
             : platform === 'win32'  ? `start "" "${url}"`
             : `xdg-open "${url}"`;
  execChild(cmd);
}

/** 启动一次性本地绑定服务，返回 URL，等待绑定完成 */
function startBindServer(params: {
  userId: string;
  apiUrl: string;
  ttlMs?: number;
}): Promise<{ url: string; result: Promise<{ success: boolean; wallet?: string; error?: string }> }> {
  return new Promise((resolveStart) => {
    const { userId, apiUrl, ttlMs = 5 * 60_000 } = params;
    // challenge 和 nonce 由页面内自动申请（需要馒包地址）
    let port = 0;

    let resolveResult!: (v: { success: boolean; wallet?: string; error?: string }) => void;
    const resultPromise = new Promise<{ success: boolean; wallet?: string; error?: string }>(r => { resolveResult = r; });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://127.0.0.1:${port}`);

      // CORS headers for browser
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (req.method === 'GET' && url.pathname === '/') {
        const html = buildBindPage({ userId, callbackPort: port, apiUrl });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/callback') {
        // 收到签名回调
        let body = '';
        req.on('data', d => body += d);
        req.on('end', async () => {
          try {
            const { nonce: n, wallet_address, signature } = JSON.parse(body);
            // 转发给 service 验证
            const vRes = await fetch(`${apiUrl}/api/wallet/verify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ nonce: n, wallet_address, signature }),
            });
            const vData = await vRes.json() as { success?: boolean; error?: string };
            const ok = vRes.ok && vData.success === true;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: ok, error: vData.error }));
            resolveResult({ success: ok, wallet: ok ? wallet_address : undefined, error: vData.error });
            // 延迟关闭，让页面显示成功
            setTimeout(() => server.close(), 3000);
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ success: false, error: String(err) }));
          }
        });
        return;
      }

      res.writeHead(404); res.end();
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      port = addr.port;
      // TTL 超时自动关闭
      setTimeout(() => {
        server.close();
        resolveResult({ success: false, error: 'timeout' });
      }, ttlMs);
      resolveStart({ url: `http://127.0.0.1:${port}/`, result: resultPromise });
    });
  });
}

// ─── Plugin Entry ─────────────────────────────────────────────────────────────

export default definePluginEntry({
  id: "clawmine",
  name: "ClawMine",
  description: "Token usage tracking + Solana on-chain reward settlement",

  register(api) {
    const pluginConfig = api.pluginConfig as {
      settlementApiUrl?: string;
      internalApiKey?: string;
      serverSecret?: string;
    };
    const apiUrl = pluginConfig.settlementApiUrl ?? "http://127.0.0.1:3100";
    const apiKey = pluginConfig.internalApiKey   ?? "claw-settle-dev-key-2026";
    const secret = pluginConfig.serverSecret     ?? "claw-settle-dev-secret-2026";

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
          scanAndReport(apiUrl, apiKey, secret, userId, api.logger).catch(err =>
            api.logger.warn(`[ClawMine] scan error: ${err.message}`)
          );
        }, 60_000);

        // 每 5 分钟发送心跳
        setInterval(() => {
          sendHeartbeat(apiUrl, apiKey, userId, api.logger);
        }, 5 * 60_000);
      },
    });

    // ── 2. /mine-bind — 一键浏览器签名绑定 ──────────────────────────────────
    api.registerCommand({
      name: "mine-bind",
      description: "Bind your Solana wallet via browser. Run /mine-bind to open the signing page.",
      acceptsArgs: false,
      async handler(_ctx: PluginCommandContext) {
        try {
          // 启动本地绑定服务（随机端口，5分钟 TTL）
          const { url, result } = await startBindServer({
            userId,
            apiUrl,
            ttlMs: 5 * 60_000,
          });

          // 自动打开浏览器
          openBrowser(url);

          // 立即返回链接（不阻塞对话框）
          // 异步等待结果，完成后再发一条消息
          result.then(bindResult => {
            // 无法在异步回调里向对话框发消息（plugin-sdk 限制），
            // 用户刷新状态可用 /mine-status 查看
            void bindResult;
          });

          return reply([
            `🔐 **绑定页面已在浏览器打开**`,
            ``,
            `如果浏览器未自动打开，请手动访问：`,
            `\`${url}\``,
            ``,
            `**操作步骤：**`,
            `1. 页面自动检测 Phantom 扩展`,
            `2. 点击 **Connect & Sign** 按钮`,
            `3. Phantom 弹出签名请求 → 点击 **Approve**`,
            `4. 完成后运行 \`/mine-status\` 确认绑定`,
            ``,
            `⏰ 链接有效期 5 分钟`,
          ].join('\n'));
        } catch (err) {
          return reply(`❌ 启动失败：${(err as Error).message}`);
        }
      },
    });

    // ── 4. /mine-status ───────────────────────────────────────────────────────
    api.registerCommand({
      name: "mine-status",
      description: "View current epoch status and your reward summary",
      async handler(_ctx: PluginCommandContext) {
        try {
          const [epochRes, rewardsRes] = await Promise.all([
            fetch(`${apiUrl}/api/epochs/current`),
            fetch(`${apiUrl}/api/rewards/${userId}`),
          ]);
          const epoch = epochRes.ok ? await epochRes.json() as { epoch_id: number; end_time: string; reward_pool: string } : null;
          const rewardsData = rewardsRes.ok ? await rewardsRes.json() as { rewards: unknown[] } : { rewards: [] };
          const lines = [`📊 **ClawMine 状态**`, ``, `🆔 节点ID：\`${userId.slice(0, 8)}...\``];
          if (epoch) {
            const diff = new Date(epoch.end_time).getTime() - Date.now();
            const mins = Math.max(0, Math.floor(diff / 60000));
            lines.push(``, `**当前周期 #${epoch.epoch_id}** | 还剩 ${mins} 分钟 | 奖励池：${(BigInt(epoch.reward_pool) / 1_000_000n).toString()} Token`);
          }
          lines.push(``, `奖励记录：${rewardsData.rewards.length} 条 | \`/mine-rewards\` 查看详情`);
          return reply(lines.join('\n'));
        } catch (err) {
          return reply(`❌ 获取状态失败：${(err as Error).message}`);
        }
      },
    });

    // ── 5. /mine-rewards ──────────────────────────────────────────────────────
    api.registerCommand({
      name: "mine-rewards",
      description: "View your full reward history",
      async handler(_ctx: PluginCommandContext) {
        try {
          const res = await fetch(`${apiUrl}/api/rewards/${userId}`);
          const data = await res.json() as { rewards: Array<{ epoch_id: number; total_tokens: string; reward_amount: string; claimed: boolean; status: string }> };
          const rewards = data.rewards ?? [];
          if (rewards.length === 0) return reply(`💎 **奖励记录**\n\n暂无记录。使用 Token 后会在 Epoch 结算时计入。`);
          const lines = [`💎 **奖励记录**`, ``];
          for (const r of rewards) {
            const badge = r.claimed ? '✅ 已领取' : r.status === 'finalized' ? '💰 可领取' : '⏳ 结算中';
            lines.push(`**周期 #${r.epoch_id}** ${badge} — ${(Number(r.reward_amount) / 1_000_000).toFixed(6)} Claw (${Number(r.total_tokens).toLocaleString()} tokens)`, ``);
          }
          return reply(lines.join('\n'));
        } catch (err) {
          return reply(`❌ 获取奖励失败：${(err as Error).message}`);
        }
      },
    });

    api.logger.info("[ClawMine] Plugin loaded — session scanner active");
  },
});
