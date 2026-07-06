#!/bin/bash
# ============================================
# DocWellness VPS - First Time Setup
# Run this ONCE on your VPS to set everything up
# ============================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[SETUP]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

APP_DIR="/root/docwellness"
BACKEND_DIR="$APP_DIR/DocwellNess Backend"
LOG_DIR="$APP_DIR/logs"

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
mkdir -p "$LOG_DIR"

# --- Step 5: Install backend dependencies ---
log "Installing backend dependencies..."
cd "$BACKEND_DIR"
npm install --production

# --- Step 6: Check for .env file ---
if [[ ! -f "$BACKEND_DIR/.env" ]]; then
    warn "No .env file found in backend!"
    warn "Create one at: $BACKEND_DIR/.env"
    warn "The backend won't start properly without it."
    echo ""
fi

# --- Step 7: Start the backend with PM2 ---
log "Starting backend with PM2..."
cd "$BACKEND_DIR"
pm2 start ecosystem.config.js
pm2 save

echo ""
log "========================================="
log "  VPS Setup Complete!"
log "========================================="
log ""
log "Backend running on PM2 as 'docwellness-backend'"
log ""
log "Useful PM2 commands:"
log "  pm2 status          - Check process status"
log "  pm2 logs            - View live logs"
log "  pm2 restart all     - Restart"
log "  pm2 monit           - Monitor dashboard"
log ""
log "Next steps:"
log "  1. Ensure .env file exists in the backend folder"
log "  2. Add GitHub secrets to the repo (see SETUP below)"
log ""
