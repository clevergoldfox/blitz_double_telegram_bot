#!/usr/bin/env bash
# Instalacao em servidor Linux (Debian/Ubuntu). Rode como root.
set -euo pipefail

APP_DIR=/opt/blitz-double-bot
APP_USER=blitzbot

echo ">> instalando Node.js 22 (se preciso)"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo ">> criando usuario de servico"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

echo ">> preparando $APP_DIR"
mkdir -p "$APP_DIR/data"

echo ">> instalando dependencias e compilando"
cd "$APP_DIR"
npm ci --omit=dev || npm install --omit=dev
npm install --no-save typescript@5.7.2 @types/node@22.10.2 @types/ws@8.5.13
npm run build

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/.env" 2>/dev/null || true

echo ">> registrando o servico"
cp deploy/blitz-double-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now blitz-double-bot

echo
echo "pronto. acompanhe com:"
echo "  journalctl -u blitz-double-bot -f"
