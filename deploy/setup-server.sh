#!/bin/bash
# ClawMine Settlement Service — 一键部署脚本
# 适用：AWS Lightsail / 任意 Ubuntu 22.04 LTS 实例
# 用法：bash setup-server.sh
set -euo pipefail

REPO_SERVICE="https://github.com/herrcai/ClawMine-Service.git"
APP_DIR="/opt/clawmine"
DB_NAME="claw_settle"
DB_USER="clawmine"
NODE_VERSION="20"

echo "======================================================"
echo "  ClawMine Settlement Service — Server Setup"
echo "======================================================"

# ── 1. 系统包 ──────────────────────────────────────────────────────────────────
echo "[1/8] System packages..."
sudo apt-get update -qq
sudo apt-get install -y -qq \
  git curl wget nginx \
  postgresql postgresql-contrib \
  certbot python3-certbot-nginx \
  ufw openssl
echo "  done"

# ── 2. Node.js ─────────────────────────────────────────────────────────────────
echo "[2/8] Node.js $NODE_VERSION..."
if ! command -v node &>/dev/null || [[ "$(node --version)" != v${NODE_VERSION}* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs
fi
echo "  Node $(node --version) | npm $(npm --version)"

# ── 3. PostgreSQL ──────────────────────────────────────────────────────────────
echo "[3/8] PostgreSQL..."
sudo systemctl start postgresql
sudo systemctl enable postgresql

DB_PASS=$(openssl rand -hex 16)

# 幂等创建用户和数据库
sudo -u postgres psql -tc "SELECT 1 FROM pg_user WHERE usename='$DB_USER'" \
  | grep -q 1 \
  || sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" \
  | grep -q 1 \
  || sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"

sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;"
echo "  DB: $DB_NAME / user: $DB_USER"

# ── 4. 克隆代码 ────────────────────────────────────────────────────────────────
echo "[4/8] Clone / update repo..."
sudo mkdir -p "$APP_DIR"
sudo chown "$USER:$USER" "$APP_DIR"

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --quiet
else
  git clone --quiet "$REPO_SERVICE" "$APP_DIR"
fi
echo "  Repo at $APP_DIR"

# ── 5. 安装依赖 & 构建 ─────────────────────────────────────────────────────────
echo "[5/8] npm install & build..."
cd "$APP_DIR"
npm install --silent
npm run build 2>&1 | tail -5
echo "  Build OK"

# ── 6. 生成 .env ───────────────────────────────────────────────────────────────
echo "[6/8] .env setup..."
if [ ! -f "$APP_DIR/.env" ]; then
  IKEY=$(openssl rand -hex 32)
  SSEC=$(openssl rand -hex 32)

  cat > "$APP_DIR/.env" << EOF
PORT=3100
HOST=127.0.0.1
INTERNAL_API_KEY=$IKEY
SERVER_SECRET=$SSEC
DATABASE_URL=postgresql://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME
SOLANA_RPC_URL=https://api.devnet.solana.com
EPOCH_REWARD_POOL=1000000000
REWARD_PROGRAM_ID=2sw21aMVVodkuZinMpqk9EZSM5NFTpbtvFqb1K89wPy8
REWARD_MINT=4vfddkdq6ZFnFKaKeHTSmja1P34GYoBvipycq5wmhqst
SOLANA_KEYPAIR_PATH=/home/$USER/.config/solana/id.json
ALLOWED_ORIGINS=https://CHANGE_ME_YOUR_DOMAIN
EOF

  echo ""
  echo "  ╔══════════════════════════════════════════════════════════════╗"
  echo "  ║  ⚠️  Save these keys — required for plugin config!           ║"
  echo "  ║                                                              ║"
  echo "  ║  INTERNAL_API_KEY = $IKEY  ║"
  echo "  ║  SERVER_SECRET    = $SSEC  ║"
  echo "  ╚══════════════════════════════════════════════════════════════╝"
  echo ""
else
  echo "  .env already exists, skipping generation"
fi

# ── 7. 数据库迁移 ──────────────────────────────────────────────────────────────
echo "[7/8] DB migrations..."
cd "$APP_DIR"
node scripts/migrate.js

# ── 8. PM2 进程管理 ────────────────────────────────────────────────────────────
echo "[8/8] PM2 + Nginx..."
sudo npm install -g pm2 --silent 2>/dev/null

pm2 delete clawmine 2>/dev/null || true
cd "$APP_DIR"
pm2 start dist/server.js --name clawmine --time
pm2 save

# 注册开机自启（捕获错误，部分环境可能不支持）
pm2 startup 2>/dev/null | grep "sudo env" | bash 2>/dev/null || true

# ── Nginx 配置 ─────────────────────────────────────────────────────────────────
sudo tee /etc/nginx/sites-available/clawmine > /dev/null << 'NGINX'
server {
    listen 80;
    server_name _;

    # API 反代
    location ~ ^/(api|health) {
        proxy_pass         http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    # 前端静态（如部署在同一台机器）
    location / {
        root      /opt/clawmine-frontend;
        try_files $uri $uri/ /index.html;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/clawmine /etc/nginx/sites-enabled/clawmine
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# ── 防火墙 ─────────────────────────────────────────────────────────────────────
sudo ufw allow 22/tcp  2>/dev/null || true
sudo ufw allow 80/tcp  2>/dev/null || true
sudo ufw allow 443/tcp 2>/dev/null || true
sudo ufw --force enable 2>/dev/null || true

# ── 完成 ───────────────────────────────────────────────────────────────────────
echo ""
echo "======================================================"
echo "  ✅  部署完成！"
echo "======================================================"
echo ""
echo "  服务状态:    pm2 status"
echo "  服务日志:    pm2 logs clawmine"
echo "  健康检查:    curl http://localhost/health"
echo ""
echo "  ─── 下一步 ───────────────────────────────────────────"
echo "  1. 编辑 $APP_DIR/.env"
echo "     → 修改 ALLOWED_ORIGINS 为你的真实域名"
echo "     → Mainnet: 修改 SOLANA_RPC_URL"
echo ""
echo "  2. 配置 SSL（替换 yourdomain.xyz）："
echo "     sudo certbot --nginx -d api.yourdomain.xyz"
echo ""
echo "  3. 用户插件配置（openclaw.json 的 clawmine.config）："
echo "     settlementApiUrl: https://api.yourdomain.xyz"
echo "     internalApiKey:   <上面保存的 INTERNAL_API_KEY>"
echo "     serverSecret:     <上面保存的 SERVER_SECRET>"
echo ""
echo "  4. pm2 restart clawmine  （修改 .env 后重启）"
echo "======================================================"
