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
 * Built-in plugin features:
 * 1. registerService  — generate/load persistent node userId, send heartbeat, scan local session files, report token usage
 * 2. /mine-bind       — start wallet bind flow (plugin-owned local signing page)
 * 3. /mine-status     — show current epoch status and node reward summary
 * 4. /mine-rewards    — show reward history
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { definePluginEntry } = require("./node_modules/openclaw/dist/plugin-sdk/plugin-entry.js");
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const readline = __importStar(require("readline"));
const http = __importStar(require("http"));
const child_process_1 = require("child_process");
const OPENCLAW_DIR = path.join(process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(), '.openclaw');
const SESSIONS_BASE = path.join(OPENCLAW_DIR, 'agents');
const USER_ID_FILE = path.join(OPENCLAW_DIR, 'clawmine-user.json');
function loadOrCreateUserId() {
    try {
        if (fs.existsSync(USER_ID_FILE)) {
            const data = JSON.parse(fs.readFileSync(USER_ID_FILE, 'utf-8'));
            if (data.user_id && typeof data.user_id === 'string')
                return data.user_id;
        }
    }
    catch { }
    const userId = (0, crypto_1.randomUUID)();
    fs.writeFileSync(USER_ID_FILE, JSON.stringify({ user_id: userId, created_at: new Date().toISOString() }, null, 2));
    return userId;
}
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
const scannedMessages = new Map();
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
                    user_id: userId,
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
async function registerNode(apiUrl, apiKey, userId, logger) {
    try {
        const hostname = os.hostname();
        const res = await fetch(`${apiUrl}/api/users/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
            body: JSON.stringify({ user_id: userId, hostname }),
        });
        if (res.ok)
            logger.info(`[ClawMine] Node registered (userId=${userId})`);
        else
            logger.warn(`[ClawMine] Node registration returned ${res.status}`);
    }
    catch (err) {
        logger.warn(`[ClawMine] Node registration failed: ${err.message}`);
    }
}
async function sendHeartbeat(apiUrl, apiKey, userId) {
    try {
        await fetch(`${apiUrl}/api/users/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
            body: JSON.stringify({ user_id: userId, ts: Date.now() }),
        });
    }
    catch { }
}
function openBrowser(url) {
    const platform = process.platform;
    const cmd = platform === 'darwin' ? `open "${url}"`
        : platform === 'win32' ? `start "" "${url}"`
            : `xdg-open "${url}"`;
    (0, child_process_1.exec)(cmd);
}
function buildBindPage(params) {
    const { userId, callbackPort, walletHint } = params;
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
.card{background:#111;border:1px solid #1e1e1e;border-radius:16px;padding:48px 40px;
      max-width:440px;width:100%;text-align:center}
.logo{font-size:40px;margin-bottom:20px}
h1{font-size:22px;font-weight:700;margin-bottom:8px}
.sub{font-size:14px;color:#555;margin-bottom:24px;line-height:1.6}
.node{font-size:11px;color:#38bdf8;font-family:ui-monospace,monospace;
      padding:6px 14px;background:rgba(56,189,248,.06);border:1px solid rgba(56,189,248,.15);
      border-radius:20px;display:inline-block;margin-bottom:32px}
.status{font-size:15px;color:#666;line-height:1.7;min-height:24px}
.status.ok{color:#4ade80}.status.err{color:#f87171}.status.info{color:#aaa}
.spinner{display:inline-block;width:18px;height:18px;
         border:2px solid #222;border-top-color:#38bdf8;
         border-radius:50%;animation:spin .7s linear infinite;
         margin-right:10px;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
.sign-btn{width:100%;height:52px;border-radius:10px;font-size:15px;font-weight:700;
           cursor:pointer;border:none;background:#fff;color:#000;
           margin-bottom:20px;transition:all .15s;letter-spacing:.01em}
.sign-btn:hover{background:#f0f0f0}
.sign-btn:disabled{background:#222;color:#555;cursor:not-allowed}
</style>
</head>
<body>
  <div class="card">
    <div class="logo">⚡</div>
    <h1>Binding to ClawMine</h1>
    <p class="sub">Phantom will pop up automatically.<br/>Click <strong>Sign</strong> to link your wallet to this node.</p>
    <div class="node">Node · ${userId.slice(0, 8)}&hellip;</div>
    <button class="sign-btn" id="signBtn" onclick="doSign()">
      <span>👻</span> Connect & Sign with Phantom
    </button>
    <div class="status" id="st"></div>
  </div>
<script>
// Challenge is fetched AFTER wallet connects (so real wallet address is embedded)
const USER_ID=${JSON.stringify(userId)};
const LOCAL='http://127.0.0.1:${callbackPort}';

function st(msg,cls){const e=document.getElementById('st');e.innerHTML=msg;e.className='status '+(cls||'');}
function b58(bytes){
  const A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let d=[],s='',j,c,n;
  for(let i=0;i<bytes.length;i++){j=0;c=bytes[i];s+=c===0&&s.length===0?'1':'';while(j<d.length||(c>0)){n=(d[j]||0)*256+c;d[j]=n%58;c=n/58|0;j++;}}
  while(d.length>0)s+=A[d.pop()];return s;
}
async function doSign(){
  const btn=document.getElementById('signBtn');
  btn.disabled=true;
  try{
    // Step 1: connect wallet
    st('<span class="spinner"></span>Connecting to Phantom…','info');
    const p=window.phantom?.solana;
    if(!p) throw new Error('Phantom not found. Install the Phantom extension and refresh.');
    const r=await p.connect();
    const pub=r.publicKey.toString();

    // Step 2: get challenge from local plugin server (plugin forwards to service)
    st('<span class="spinner"></span>Preparing signature request…','info');
    const cr=await fetch(LOCAL+'/challenge',{
      method:'POST',headers:{'Content-Type':'text/plain'},body:USER_ID+'|'+pub
    });
    const cd=await cr.json();
    if(!cd.nonce) throw new Error('Failed to get challenge: '+(cd.error||cr.status));

    // Step 3: sign with Phantom
    st('<span class="spinner"></span>Sign the message in the Phantom popup…','info');
    const sig=b58((await p.signMessage(new TextEncoder().encode(cd.challenge),'utf8')).signature);

    // Step 4: verify via local plugin
    st('<span class="spinner"></span>Verifying…','info');
    const vr=await fetch(LOCAL+'/callback',{
      method:'POST',headers:{'Content-Type':'text/plain'},
      body:cd.nonce+'|'+pub+'|'+sig
    });
    const vd=await vr.json();
    if(!vd.success) throw new Error(vd.error||'Verification failed');

    btn.style.cssText='background:#0f2a0f;color:#4ade80;border:1px solid #1a4a1a;cursor:default';
    btn.innerHTML='✅ Wallet Bound';
    // 成功后跳转到关闭页
    window.location.href = LOCAL + '/done?wallet=' + encodeURIComponent(pub);
  }catch(e){
    btn.disabled=false;
    const msg=e.message||String(e);
    const isDuplicate=msg.toLowerCase().includes('already bound');
    st('❌ '+msg+(isDuplicate
      ?'<br/><small style="color:#555">This wallet is already linked to a node.</small>'
      :'<br/><small style="color:#555">Click the button above to try again.</small>'
    ),'err');
  }
}
<\/script>
</body>
</html>`;
}
function startBindServer(params) {
    return new Promise((resolveStart) => {
        const { userId, apiUrl, walletHint, ttlMs = 5 * 60000 } = params;
        // challenge is now fetched dynamically via /challenge endpoint after wallet connects
        let port = 0;
        let resolved = false;
        let resolveResult;
        const resultPromise = new Promise(r => { resolveResult = r; });
        const finalize = (payload) => {
            if (resolved)
                return;
            resolved = true;
            resolveResult(payload);
        };
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://127.0.0.1:${port}`);
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }
            // /done — 绑定成功后跳转到此页，提示用户关闭页面
            if (req.method === 'GET' && url.pathname === '/done') {
                const wallet = url.searchParams.get('wallet') ?? '';
                const short = wallet ? wallet.slice(0, 6) + '…' + wallet.slice(-4) : '';
                const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Wallet Bound</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0a;color:#e5e5e5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
     display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{text-align:center;padding:48px 40px;max-width:400px}
.check{font-size:64px;margin-bottom:24px}
h1{font-size:22px;font-weight:700;color:#4ade80;margin-bottom:12px}
p{font-size:14px;color:#555;line-height:1.7}
.addr{font-family:monospace;color:#38bdf8;font-size:13px;
      background:rgba(56,189,248,.06);border:1px solid rgba(56,189,248,.15);
      border-radius:6px;padding:4px 10px;display:inline-block;margin:6px 0}
.hint{margin-top:20px;font-size:13px;color:#333}
</style></head><body>
<div class="card">
  <div class="check">✅</div>
  <h1>Wallet Bound!</h1>
  <p><span class="addr">${short}</span><br/>is now linked to your ClawMine node.</p>
  <p class="hint">You can close this tab.</p>
</div>
</body></html>`;
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(html);
                return;
            }
            // /challenge — 浏览器连上钱包后，用真实地址向 service 申请 challenge
            if (req.method === 'POST' && url.pathname === '/challenge') {
                let body = '';
                req.on('data', d => body += d);
                req.on('end', async () => {
                    try {
                        const [uid, walletAddress] = body.split('|');
                        const cr = await fetch(`${apiUrl}/api/wallet/challenge`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ user_id: uid, wallet_address: walletAddress }),
                        });
                        const cData = await cr.json();
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(cData));
                    }
                    catch (err) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: String(err) }));
                    }
                });
                return;
            }
            if (req.method === 'GET' && url.pathname === '/') {
                const html = buildBindPage({ userId, callbackPort: port, walletHint });
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(html);
                return;
            }
            if (req.method === 'POST' && url.pathname === '/callback') {
                let body = '';
                req.on('data', d => body += d);
                req.on('end', async () => {
                    try {
                        let n = '', wallet_address = '', signature = '';
                        const ct = req.headers['content-type'] ?? '';
                        if (ct.includes('application/json')) {
                            ({ nonce: n, wallet_address, signature } = JSON.parse(body));
                        }
                        else {
                            [n, wallet_address, signature] = body.split('|');
                        }
                        const vRes = await fetch(`${apiUrl}/api/wallet/verify`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ nonce: n, wallet_address, signature }),
                        });
                        const vData = await vRes.json();
                        const ok = vRes.ok && vData.success === true;
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: ok, error: vData.error }));
                        finalize({ success: ok, wallet: ok ? wallet_address : undefined, error: vData.error });
                        setTimeout(() => server.close(), 3000);
                    }
                    catch (err) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: String(err) }));
                    }
                });
                return;
            }
            res.writeHead(404);
            res.end();
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            port = addr.port;
            setTimeout(() => {
                server.close();
                finalize({ success: false, error: 'timeout' });
            }, ttlMs);
            resolveStart({ url: `http://127.0.0.1:${port}/`, result: resultPromise });
        });
    });
}
exports.default = definePluginEntry({
    id: "clawmine",
    name: "ClawMine",
    description: "Token usage tracking + Solana on-chain reward settlement",
    register(api) {
        const pluginConfig = api.pluginConfig;
        const apiUrl = pluginConfig.settlementApiUrl ?? "http://127.0.0.1:3100";
        const apiKey = pluginConfig.internalApiKey ?? "claw-settle-dev-key-2026";
        const secret = pluginConfig.serverSecret ?? "claw-settle-dev-secret-2026";
        const userId = loadOrCreateUserId();
        api.logger.info(`[ClawMine] userId=${userId}`);
        api.registerService({
            id: 'claw-settle-scanner',
            async start() {
                api.logger.info('[ClawMine] Session scanner started');
                await registerNode(apiUrl, apiKey, userId, api.logger);
                await scanAndReport(apiUrl, apiKey, secret, userId, api.logger);
                setInterval(() => {
                    scanAndReport(apiUrl, apiKey, secret, userId, api.logger).catch(err => api.logger.warn(`[ClawMine] scan error: ${err.message}`));
                }, 60000);
                setInterval(() => {
                    sendHeartbeat(apiUrl, apiKey, userId);
                }, 5 * 60000);
            },
        });
        api.registerCommand({
            name: "mine-bind",
            description: "Bind your Phantom wallet to this node. Usage: /mine-bind",
            acceptsArgs: false,
            async handler(_ctx) {
                try {
                    // 检查是否已绑定
                    const existing = await fetch(`${apiUrl}/api/wallet/${userId}`);
                    if (existing.ok) {
                        const w = await existing.json();
                        const addr = w.wallet_address;
                        return reply(`✅ **Already bound**\n\nThis node is already linked to wallet \`${addr.slice(0, 6)}...${addr.slice(-4)}\`.\n\nRun \`/mine-status\` to see your rewards.`);
                    }
                    const { url, result } = await startBindServer({ userId, apiUrl, walletHint: 'phantom' });
                    openBrowser(url);
                    // 先告知用户浏览器已打开，同时等待绑定结果（最多 5 分钟）
                    // Note: OpenClaw plugin-sdk 不支持异步推送，所以这里同步等待完成再返回
                    const bindResult = await Promise.race([
                        result,
                        new Promise(r => setTimeout(() => r({ success: false, error: 'timeout' }), 5 * 60000)),
                    ]);
                    if (bindResult.success) {
                        const addr = bindResult.wallet ?? '';
                        return reply([
                            `✅ **Wallet bound successfully!**`,
                            ``,
                            `\`${addr.slice(0, 6)}...${addr.slice(-4)}\` is now linked to this node.`,
                            `Rewards will accumulate from the next epoch.`,
                        ].join('\n'));
                    }
                    else if (bindResult.error === 'timeout') {
                        return reply(`⏰ **Binding timed out.** Run \`/mine-bind\` again to retry.`);
                    }
                    else {
                        return reply(`❌ **Binding failed:** ${bindResult.error}\n\nRun \`/mine-bind\` to retry.`);
                    }
                }
                catch (err) {
                    return reply(`❌ Failed: ${err.message}`);
                }
            },
        });
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
                    const lines = [`📊 **ClawMine Status**`, ``, `Node ID: \`${userId.slice(0, 8)}...\``];
                    if (epoch) {
                        const diff = new Date(epoch.end_time).getTime() - Date.now();
                        const mins = Math.max(0, Math.floor(diff / 60000));
                        lines.push(``, `Current Epoch #${epoch.epoch_id} · ${mins} min left · Reward Pool ${(BigInt(epoch.reward_pool) / 1000000n).toString()} CLAW`);
                    }
                    lines.push(``, `Reward history: ${rewardsData.rewards.length} records · \`/mine-rewards\` for details`);
                    return reply(lines.join('\n'));
                }
                catch (err) {
                    return reply(`❌ Failed to fetch status: ${err.message}`);
                }
            },
        });
        api.registerCommand({
            name: "mine-settle",
            description: "Submit pending epoch Merkle Roots to Solana chain (requires local keypair). Usage: /mine-settle",
            async handler(_ctx) {
                try {
                    // 1. 拉取待提交的 epoch（有 merkle_root 但无 solana_tx_hash）
                    const res = await fetch(`${apiUrl}/api/epochs/pending-chain-submit`, {
                        headers: { 'x-internal-key': apiKey },
                    });
                    if (!res.ok)
                        return reply(`❌ Failed to fetch pending epochs: ${res.status}`);
                    const { epochs } = await res.json();
                    if (epochs.length === 0)
                        return reply(`✅ **All epochs settled.** No pending chain submissions.`);
                    // 2. 加载本地私鑰
                    const keypairPath = process.env.SOLANA_KEYPAIR_PATH ?? path.join(os.homedir(), '.config', 'solana', 'id.json');
                    let keypairData;
                    try {
                        keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
                    }
                    catch {
                        return reply(`❌ Keypair not found at \`${keypairPath}\`.\n\nRun \`solana-keygen new\` or set \`SOLANA_KEYPAIR_PATH\`.`);
                    }
                    const lines = [`⛓️ **Chain Submit** \u2014 ${epochs.length} epoch(s) pending`, ``];
                    // 3. 动态 import chain-submit 逻辑（直接调用现有的 submitEpochToChain）
                    const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY, sendAndConfirmTransaction } = await Promise.resolve().then(() => __importStar(require('@solana/web3.js')));
                    const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, getAccount, TOKEN_PROGRAM_ID } = await Promise.resolve().then(() => __importStar(require('@solana/spl-token')));
                    const crypto = await Promise.resolve().then(() => __importStar(require('crypto')));
                    const solanaRpcUrl = pluginConfig.solanaRpcUrl ?? 'https://api.devnet.solana.com';
                    const rewardProgramId = pluginConfig.rewardProgramId ?? '2sw21aMVVodkuZinMpqk9EZSM5NFTpbtvFqb1K89wPy8';
                    const rewardMint = pluginConfig.rewardMint ?? '4vfddkdq6ZFnFKaKeHTSmja1P34GYoBvipycq5wmhqst';
                    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
                    const connection = new Connection(solanaRpcUrl, { commitment: 'confirmed' });
                    const keypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
                    function anchorDisc(name) {
                        return crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
                    }
                    for (const epoch of epochs) {
                        try {
                            const pid = new PublicKey(rewardProgramId);
                            const mint = new PublicKey(rewardMint);
                            const epochIdBuf = Buffer.alloc(8);
                            epochIdBuf.writeBigUInt64LE(BigInt(epoch.epoch_id));
                            const [epochConfigPDA] = PublicKey.findProgramAddressSync([Buffer.from('epoch_config'), epochIdBuf], pid);
                            const vault = await getAssociatedTokenAddress(mint, epochConfigPDA, true);
                            // 确保 vault ATA 存在
                            try {
                                await getAccount(connection, vault);
                            }
                            catch {
                                const createVaultTx = new Transaction().add(createAssociatedTokenAccountInstruction(keypair.publicKey, vault, epochConfigPDA, mint));
                                await sendAndConfirmTransaction(connection, createVaultTx, [keypair], { commitment: 'confirmed' });
                            }
                            // 构造 initialize_epoch 指令
                            const disc = anchorDisc('initialize_epoch');
                            const rootHex = epoch.merkle_root.startsWith('0x') ? epoch.merkle_root.slice(2) : epoch.merkle_root;
                            const rootBytes = Buffer.from(rootHex.padStart(64, '0'), 'hex');
                            const now = Math.floor(Date.now() / 1000);
                            const argsBuf = Buffer.alloc(8 + 32 + 8 + 8 + 8);
                            let off = 0;
                            argsBuf.writeBigUInt64LE(BigInt(epoch.epoch_id), off);
                            off += 8;
                            rootBytes.copy(argsBuf, off);
                            off += 32;
                            argsBuf.writeBigUInt64LE(BigInt(epoch.reward_pool), off);
                            off += 8;
                            argsBuf.writeBigInt64LE(BigInt(now), off);
                            off += 8;
                            argsBuf.writeBigInt64LE(BigInt(now + 300), off);
                            const data = Buffer.concat([Buffer.from(disc), argsBuf]);
                            const ix = new TransactionInstruction({
                                programId: pid,
                                keys: [
                                    { pubkey: epochConfigPDA, isSigner: false, isWritable: true },
                                    { pubkey: mint, isSigner: false, isWritable: false },
                                    { pubkey: vault, isSigner: false, isWritable: true },
                                    { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
                                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                                    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
                                ],
                                data,
                            });
                            const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [keypair], { commitment: 'confirmed' });
                            // 回调服务器更新 tx hash
                            await fetch(`${apiUrl}/api/epochs/${epoch.epoch_id}/tx-hash`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'x-internal-key': apiKey },
                                body: JSON.stringify({ tx_hash: sig }),
                            });
                            lines.push(`✅ Epoch #${epoch.epoch_id} → [${sig.slice(0, 12)}…](https://solscan.io/tx/${sig}?cluster=devnet)`);
                        }
                        catch (epochErr) {
                            lines.push(`❌ Epoch #${epoch.epoch_id} failed: ${epochErr.message.slice(0, 80)}`);
                        }
                    }
                    return reply(lines.join('\n'));
                }
                catch (err) {
                    return reply(`❌ /mine-settle error: ${err.message}`);
                }
            },
        });
        api.commands.register({
            name: "mine-rewards",
            description: "View your reward history",
            async handler(_ctx) {
                try {
                    const res = await fetch(`${apiUrl}/api/rewards/${userId}`);
                    const data = await res.json();
                    const rewards = data.rewards ?? [];
                    if (rewards.length === 0)
                        return reply(`💎 **Reward History**\n\nNo rewards yet.`);
                    const lines = [`💎 **Reward History**`, ``];
                    for (const r of rewards) {
                        const badge = r.claimed ? 'Claimed' : r.status === 'finalized' ? 'Claimable' : 'Pending';
                        lines.push(`#${r.epoch_id} · ${badge} · ${(Number(r.reward_amount) / 1000000).toFixed(6)} CLAW · ${Number(r.total_tokens).toLocaleString()} tokens`);
                    }
                    return reply(lines.join('\n'));
                }
                catch (err) {
                    return reply(`❌ Failed to fetch rewards: ${err.message}`);
                }
            },
        });
        api.logger.info("[ClawMine] Plugin loaded — session scanner active");
    },
});
