#!/bin/bash
# ============================================
# DocWellness VPS - First Time Setup
# Run this ONCE on your VPS to set everything up
#
# NOTE: This VPS now only hosts the dev-branch Socket.io mirror. Production
# runs on a separate Oracle Cloud VPS via Coolify (Docker-based), not PM2 on
# this box - see docs/cron-setup.md for where the renewal-reminders cron
# lives now.
# ============================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[SETUP]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

DEV_DIR="/root/docwellness-dev/docwellness-backend"
DEV_LOG_DIR="/root/docwellness-dev/logs"

# --- Step 1: Install Node.js (if not installed) ---
if ! command -v node &> /dev/null; then
    log "Installing Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
log "Node: $(node -v)"

# --- Step 2: Install PM2 globally ---
if ! command -v pm2 &> /dev/null; then
    log "Installing PM2..."
    npm install -g pm2
fi
log "PM2: $(pm2 -v)"

# --- Step 3: Set PM2 to auto-start on boot ---
log "Configuring PM2 startup..."
pm2 startup systemd -u root --hp /root 2>/dev/null || true

# --- Step 4: Create log directory ---
mkdir -p "$DEV_LOG_DIR"

# --- Step 5: Check the dev checkout exists ---
if [[ ! -d "$DEV_DIR/.git" ]]; then
    warn "Dev checkout not found at $DEV_DIR"
    warn "Clone it there first: git clone git@github.com:Docwellness/docwellness-backend.git \"$DEV_DIR\" && (cd \"$DEV_DIR\" && git checkout dev)"
fi
warn "The checkout needs an SSH deploy key (GitHub repo Settings -> Deploy keys) added to this VPS's SSH agent for 'git fetch/pull' to work non-interactively."

# --- Step 6: Install dependencies ---
if [[ -d "$DEV_DIR" ]]; then
    log "Installing dependencies in $DEV_DIR..."
    (cd "$DEV_DIR" && npm install --omit=dev)
fi

# --- Step 7: Check for .env file ---
if [[ -d "$DEV_DIR" && ! -f "$DEV_DIR/.env" ]]; then
    warn "No .env file found in $DEV_DIR!"
    warn "Create one there before starting PM2 - the backend won't start properly without it."
fi

# --- Step 8: Start the dev app with PM2 ---
if [[ -f "$DEV_DIR/ecosystem.config.js" ]]; then
    log "Starting backend app with PM2..."
    (cd "$DEV_DIR" && pm2 start ecosystem.config.js && pm2 save)
else
    warn "ecosystem.config.js not found in $DEV_DIR - skipping PM2 start."
fi

echo ""
log "========================================="
log "  VPS Setup Complete!"
log "========================================="
log ""
log "One PM2 app is configured (see ecosystem.config.js):"
log "  docwellness-backend-dev  - dev, tracks 'dev', port 5001 (for realtime/Socket.io testing)"
log ""
log "Useful PM2 commands:"
log "  pm2 status                       - Check process status"
log "  pm2 logs docwellness-backend-dev - View live logs"
log "  pm2 restart all                  - Restart"
log "  pm2 monit                        - Monitor dashboard"
log ""
log "Next steps:"
log "  1. Add an SSH deploy key for this VPS to the checkout's GitHub repo"
log "  2. Ensure a .env file exists in $DEV_DIR"
log "  3. Add VPS_HOST/VPS_USER/VPS_SSH_KEY as GitHub Actions secrets so"
log "     deploy-dev-vps.yml can SSH in and run deploy.sh"
log "  4. Production setup/deploys now happen on the Oracle VPS via Coolify -"
log "     see docs/cron-setup.md for the renewal-reminders cron's new home"
log ""
