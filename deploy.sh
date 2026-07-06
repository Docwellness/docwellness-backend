#!/bin/bash
# ============================================
# DocWellness Backend - Deploy Script
# Runs on VPS when triggered by GitHub Actions
# ============================================

set -e

APP_DIR="/root/docwellness"
BACKEND_DIR="$APP_DIR/DocwellNess Backend"
LOG_DIR="$APP_DIR/logs"
BRANCH="${1:-sahil}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[DEPLOY]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Check if GITHUB_TOKEN is set (required for pulling)
if [[ -z "$GITHUB_TOKEN" ]]; then
    # Try loading from file
    if [[ -f "$APP_DIR/.deploy-token" ]]; then
        GITHUB_TOKEN=$(cat "$APP_DIR/.deploy-token")
    else
        error "GITHUB_TOKEN not set and .deploy-token file not found. Cannot pull."
    fi
fi

cd "$APP_DIR"

# Configure git to use the token for this repo
git remote set-url origin "https://x-access-token:${GITHUB_TOKEN}@github.com/Particle14Infotech/docwellness.git"

log "Fetching latest code from branch: $BRANCH"
git fetch origin "$BRANCH"

# Check if there are actual changes in backend
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [[ "$LOCAL" == "$REMOTE" ]]; then
    log "Already up to date. No deployment needed."
    exit 0
fi

log "Pulling latest changes..."
git checkout "$BRANCH"
git pull origin "$BRANCH"

log "Installing backend dependencies..."
cd "$BACKEND_DIR"
npm ci --production 2>/dev/null || npm install --production

log "Restarting PM2 process..."
if pm2 describe docwellness-backend > /dev/null 2>&1; then
    pm2 reload ecosystem.config.js --update-env
else
    pm2 start ecosystem.config.js
fi

pm2 save

# Remove token from git remote URL after pull (security)
cd "$APP_DIR"
git remote set-url origin "https://github.com/Particle14Infotech/docwellness.git"

log "Deployment complete!"
pm2 status
