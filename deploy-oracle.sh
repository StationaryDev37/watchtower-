#!/usr/bin/env bash
# Idempotent one-shot deploy for Oracle Always Free (Ubuntu 22.04, arm64 or x64).
# Safe to re-run; each step no-ops if already satisfied.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/watchtower}"
APP_USER="${APP_USER:-ubuntu}"
NODE_MAJOR=20
PORT="${PORT:-3847}"

log() { printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }

log "System deps"
sudo apt-get update -y
sudo apt-get install -y curl git build-essential python3 ufw ca-certificates

if ! command -v node >/dev/null || [[ "$(node -v)" != v${NODE_MAJOR}* ]]; then
  log "Node ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if ! command -v pm2 >/dev/null; then
  log "PM2"
  sudo npm i -g pm2@latest
fi

log "App code at ${APP_DIR}"
sudo mkdir -p "${APP_DIR}"
sudo chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

if [ -d "${APP_DIR}/.git" ]; then
  git -C "${APP_DIR}" fetch --all --prune
  git -C "${APP_DIR}" reset --hard "${DEPLOY_REF:-origin/main}"
else
  git clone "${REPO_URL:?set REPO_URL}" "${APP_DIR}"
  git -C "${APP_DIR}" checkout "${DEPLOY_REF:-main}"
fi

cd "${APP_DIR}"
log "Install"
npm ci --omit=dev
# Rebuild better-sqlite3 if prebuild missed (rare on Oracle arm64).
if ! node -e "require('better-sqlite3')" 2>/dev/null; then
  npm rebuild better-sqlite3 --build-from-source
fi

log "Firewall"
sudo ufw allow OpenSSH || true
sudo ufw allow "${PORT}/tcp" || true
yes | sudo ufw enable || true

log "PM2 up"
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u "${APP_USER}" --hp "/home/${APP_USER}" | tail -n1 | bash || true

log "Health"
sleep 3
curl -fsS "http://127.0.0.1:${PORT}/health" | head -c 400 && echo
log "Done."
