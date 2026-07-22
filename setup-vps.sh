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

PROD_DIR="/root/docwellness/docwellness-backend"
DEV_DIR="/root/docwellness-dev/docwellness-backend"
PROD_LOG_DIR="/root/docwellness/logs"
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

# --- Step 4: Create log directories (prod + dev) ---
mkdir -p "$PROD_LOG_DIR" "$DEV_LOG_DIR"

# --- Step 5: Check both repo checkouts exist ---
if [[ ! -d "$PROD_DIR/.git" ]]; then
    warn "Prod checkout not found at $PROD_DIR"
    warn "Clone it there first: git clone git@github.com:Docwellness/docwellness-backend.git \"$PROD_DIR\" (checked out on 'main')"
fi
if [[ ! -d "$DEV_DIR/.git" ]]; then
    warn "Dev checkout not found at $DEV_DIR"
    warn "Clone it there first: git clone git@github.com:Docwellness/docwellness-backend.git \"$DEV_DIR\" && (cd \"$DEV_DIR\" && git checkout dev)"
fi
warn "Both checkouts need an SSH deploy key (GitHub repo Settings -> Deploy keys) added to this VPS's SSH agent for 'git fetch/pull' to work non-interactively."

# --- Step 6: Install dependencies for whichever checkouts exist ---
for dir in "$PROD_DIR" "$DEV_DIR"; do
    if [[ -d "$dir" ]]; then
        log "Installing dependencies in $dir..."
        (cd "$dir" && npm install --omit=dev)
    fi
done

# --- Step 7: Check for .env files ---
for dir in "$PROD_DIR" "$DEV_DIR"; do
    if [[ -d "$dir" && ! -f "$dir/.env" ]]; then
        warn "No .env file found in $dir!"
        warn "Create one there before starting PM2 - the backend won't start properly without it."
    fi
done

# --- Step 8: Start both apps with PM2 (from the prod checkout's ecosystem.config.js) ---
if [[ -f "$PROD_DIR/ecosystem.config.js" ]]; then
    log "Starting backend apps with PM2..."
    (cd "$PROD_DIR" && pm2 start ecosystem.config.js && pm2 save)
else
    warn "ecosystem.config.js not found in $PROD_DIR - skipping PM2 start."
fi

# --- Step 9: Membership-renewal reminder cron (prod only) ---
# This is the ONLY trigger path that reaches real patients - vercel.json's
# "crons" entry for the same route only ever runs against the Vercel-hosted
# `dev` deployment (see docs/cron-setup.md), since prod runs on this VPS via
# PM2, not Vercel. Requires CRON_SECRET to already be set in
# $PROD_DIR/.env (add it there first if this is the first time).
CRON_MARKER="docwellness-renewal-reminders"
if [[ -f "$PROD_DIR/.env" ]] && grep -q '^CRON_SECRET=' "$PROD_DIR/.env"; then
    CRON_SECRET_VALUE=$(grep '^CRON_SECRET=' "$PROD_DIR/.env" | head -1 | cut -d= -f2-)
    CRON_LINE="0 3 * * * curl -fsS -X POST -H \"x-cron-secret: ${CRON_SECRET_VALUE}\" http://localhost:5000/api/internal/cron/renewal-reminders >> $PROD_LOG_DIR/renewal-reminders.log 2>&1 # ${CRON_MARKER}"
    if ! crontab -l 2>/dev/null | grep -q "$CRON_MARKER"; then
        log "Adding daily renewal-reminder cron entry (03:00 server time)..."
        (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
    else
        log "Renewal-reminder cron entry already present - skipping."
    fi
else
    warn "CRON_SECRET not found in $PROD_DIR/.env - skipping renewal-reminder crontab setup."
    warn "Add CRON_SECRET=<a-random-secret> to $PROD_DIR/.env, then re-run this script (or add the crontab line manually - see docs/cron-setup.md)."
fi

echo ""
log "========================================="
log "  VPS Setup Complete!"
log "========================================="
log ""
log "Two PM2 apps are configured (see ecosystem.config.js):"
log "  docwellness-backend      - prod, tracks 'main', port 5000"
log "  docwellness-backend-dev  - dev,  tracks 'dev',  port 5001 (for realtime/Socket.io testing)"
log ""
log "Useful PM2 commands:"
log "  pm2 status                     - Check process status"
log "  pm2 logs docwellness-backend   - View live logs for prod"
log "  pm2 logs docwellness-backend-dev - View live logs for dev"
log "  pm2 restart all                - Restart"
log "  pm2 monit                      - Monitor dashboard"
log ""
log "Next steps:"
log "  1. Add an SSH deploy key for this VPS to both checkouts' GitHub repo"
log "  2. Ensure .env files exist in both $PROD_DIR and $DEV_DIR"
log "  3. Add VPS_HOST/VPS_USER/VPS_SSH_KEY as GitHub Actions secrets so"
log "     deploy-prod.yml and deploy-dev-vps.yml can SSH in and run deploy.sh"
log "  4. Set up Nginx reverse proxy + Cloudflare DNS once a domain exists"
log "     (api.<domain> -> :5000, api-dev.<domain> -> :5001)"
log "  5. See docs/cron-setup.md for the renewal-reminder cron - it only"
log "     actually reaches production via this VPS's crontab, not Vercel"
log ""
