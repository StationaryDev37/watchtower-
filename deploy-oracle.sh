#!/usr/bin/env bash
# Watchtower Framework — Oracle Cloud Always Free bootstrap
# Single-source install: Node + PM2 + app + env template.
#
#   curl -fsSL https://raw.githubusercontent.com/StationaryDev37/watchtower-/main/deploy-oracle.sh | bash
#
set -euo pipefail

REPO_URL="${WATCHTOWER_REPO_URL:-https://github.com/StationaryDev37/watchtower-.git}"
INSTALL_DIR="${WATCHTOWER_HOME:-$HOME/watchtower}"
NODE_MAJOR="${WATCHTOWER_NODE_MAJOR:-20}"

echo "============================================"
echo "  Watchtower Framework · Oracle deployer"
echo "  Single source · alerts + Stripe · \$0 infra"
echo "============================================"
echo "Install dir: $INSTALL_DIR"
echo "Repo:        $REPO_URL"
echo

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=""
else
  SUDO="sudo"
fi

export DEBIAN_FRONTEND=noninteractive

echo "[1/7] System packages..."
$SUDO apt-get update -y
$SUDO apt-get install -y curl ca-certificates gnupg git build-essential ufw

echo "[2/7] Node.js ${NODE_MAJOR}.x..."
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v//;s/\..*//')" -lt "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi
node -v && npm -v

echo "[3/7] PM2..."
if ! command -v pm2 >/dev/null 2>&1; then
  $SUDO npm install -g pm2
fi
pm2 -v

echo "[4/7] Clone / update..."
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" fetch --all --prune
  git -C "$INSTALL_DIR" pull --ff-only || true
else
  rm -rf "$INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

echo "[5/7] Dependencies..."
if [[ -f watchtower-package.json && ! -f package.json ]]; then
  cp watchtower-package.json package.json
fi
npm install --omit=dev

mkdir -p "$INSTALL_DIR/data"

echo "[6/7] Environment..."
if [[ ! -f .env ]]; then
  cp .env.example .env
  # Best-effort public IP for PUBLIC_BASE_URL
  PUB_IP="$(curl -fsSL https://api.ipify.org || true)"
  if [[ -n "${PUB_IP}" ]]; then
    sed -i "s|PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=http://${PUB_IP}:3847|" .env || true
  fi
  echo "Created $INSTALL_DIR/.env — add Telegram, Twitter, Stripe keys."
else
  echo ".env exists — left untouched."
fi

echo "[7/7] Firewall..."
if command -v ufw >/dev/null 2>&1; then
  $SUDO ufw allow OpenSSH || true
  $SUDO ufw allow 3847/tcp || true
  $SUDO ufw --force enable || true
fi

cat <<EOF

============================================
  Framework installed.
============================================

Day-0 path (hours, not months):

  1) nano $INSTALL_DIR/.env
       TELEGRAM_*  TWITTER_*  STRIPE_SECRET_KEY
       TELEGRAM_PREMIUM_INVITE_LINK  AFFILIATE_EXCHANGE_URL

  2) pm2 start watchtower.js --name watchtower
     pm2 startup && pm2 save

  3) Open http://YOUR_IP:3847
       Free alerts → Twitter/Telegram
       /checkout → Stripe Premium (same process)

  4) Stripe webhook → http://YOUR_IP:3847/webhook/stripe
       event: checkout.session.completed

Oracle Always Free ARM = \$0 forever.
Revenue paths live in the same binary from minute one.

EOF
