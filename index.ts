/**
 * ClawMine Plugin for OpenClaw
 *
 * Features:
 * 1. Token usage tracking via session file scanning
 * 2. Wallet binding with Solana wallet
 * 3. Epoch status and reward history
 * 4. Automatic on-chain settlement
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { definePluginEntry } = require("./node_modules/openclaw/dist/plugin-sdk/plugin-entry.js") as typeof import("./node_modules/openclaw/dist/plugin-sdk/plugin-entry");
import { createHmac, randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import * as http from 'http';
import { exec as execChild } from 'child_process';
import type { PluginCommandContext } from "./node_modules/openclaw/dist/plugin-sdk/plugin-entry";

const OPENCLAW_DIR   = path.join(process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(), '.openclaw');
const SESSIONS_BASE  = path.join(OPENCLAW_DIR, 'agents');
const USER_ID_FILE   = path.join(OPENCLAW_DIR, 'clawmine-user.json');

function loadOrCreateUserId(): string {
  try {
    if (fs.existsSync(USER_ID_FILE)) {
      const data = JSON.parse(fs.readFileSync(USER_ID_FILE, 'utf-8'));
      if (data.user_id && typeof data.user_id === 'string') return data.user_id;
    }
  } catch {}
  const userId = randomUUID();
  fs.writeFileSync(USER_ID_FILE, JSON.stringify({ user_id: userId, created_at: new Date().toISOString() }, null, 2));
  return userId;
}

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

const scannedMessages = new Map<string, Set<string>>();

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

    const recent = sessionFiles.filter(f => {
      try {
        const stat = fs.statSync(f);
        return Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000;
      } catch { return false; }
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

  if (records.length === 0) return;

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
      } else {
        const data = await res.json() as { accepted: number };
        accepted += data.accepted;
      }
    } catch (err) {
      logger.warn(`[ClawMine] metering write failed: ${(err as Error).message}`);
    }
  }
  logger.info(`[ClawMine] Reported ${accepted}/${records.length} records OK`);
}

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
    if (res.ok) logger.info(`[ClawMine] Node registered (userId=${userId})`);
    else logger.warn(`[ClawMine] Node registration returned ${res.status}`);
  } catch (err) {
    logger.warn(`[ClawMine] Node registration failed: ${(err as Error).message}`);
  }
}

async function sendHeartbeat(
  apiUrl: string,
  apiKey: string,
  userId: string,
) {
  try {
    await fetch(`${apiUrl}/api/users/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: JSON.stringify({ user_id: userId, ts: Date.now() }),
    });
  } catch {}
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? `open "${url}"`
             : platform === 'win32' ? `start "" "${url}"`
             : `xdg-open "${url}"`;
  execChild(cmd);
}

function buildBindPage(params: {
  userId: string;
  callbackPort: number;
  walletHint: 'phantom' | 'solflare' | 'auto';
}): string {
  const { userId, callbackPort, walletHint } = params;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>ClawMine Wallet Binding</title>
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
    st('<span class="spinner"></span>Connecting to Phantom...','info');
    const p=window.phantom?.solana;
    if(!p) throw new Error('Phantom not found. Install the Phantom extension and refresh.');
    const r=await p.connect();
    const pub=r.publicKey.toString();

    // Step 2: get challenge from local plugin server (plugin forwards to service)
    st('<span class="spinner"></span>Preparing signature request...','info');
    const cr=await fetch(LOCAL+'/challenge',{
      method:'POST',headers:{'Content-Type':'text/plain'},body:USER_ID+'|'+pub
    });
    const cd=await cr.json();
    if(!cd.nonce) throw new Error('Failed to get challenge: '+(cd.error||cr.status));

    // Step 3: sign with Phantom
    st('<span class="spinner"></span>Sign the message in the Phantom popup...','info');
    const sig=b58((await p.signMessage(new TextEncoder().encode(cd.challenge),'utf8')).signature);

    // Step 4: verify via local plugin
    st('<span class="spinner"></span>Verifying...','info');
    const vr=await fetch(LOCAL+'/callback',{
      method:'POST',headers:{'Content-Type':'text/plain'},
      body:cd.nonce+'|'+pub+'|'+sig
    });
    const vd=await vr.json();
    if(!vd.success) throw new Error(vd.error||'Verification failed');

    btn.style.cssText='background:#0f2a0f;color:#4ade80;border:1px solid #1a4a1a;cursor:default';
    btn.innerHTML='✅ Wallet Bound';
    // Redirect to success page
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

// Submit on-chain settlement (runs in plugin process)
async function runChainSubmit(
  _epochs: unknown,
  keypairPath: string,
  apiUrl: string,
  _pluginConfig: unknown,
  logger: { info: (m: string) => void; warn: (m: string) => void }
): Promise<Array<{ epochId: number; sig?: string; error?: string }>> {
  return new Promise((resolve) => {
    const scriptPath = path.join(
      os.homedir(), '.openclaw', 'workspace', 'claw-settle',
      'settlement-service', 'scripts', 'chain-submit-cli.js'
    );
    if (!fs.existsSync(scriptPath)) {
      logger.warn(`[ClawMine] chain-submit-cli.js not found at ${scriptPath}`);
      resolve([{ epochId: 0, error: 'chain-submit-cli.js not found' }]);
      return;
    }
    const { execFile } = require('child_process');
    let stdout = '';
    const child = execFile(
      process.execPath,
      [scriptPath, apiUrl, keypairPath],
      { timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024 },
      (