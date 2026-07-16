#!/bin/bash
# ============================================
# DocWellness Backend - Deploy Script
# Invoked over SSH by GitHub Actions:
#   - push to `main` -> deploy the `docwellness-backend` (prod) PM2 app
#   - push to `dev`  -> deploy the `docwellness-backend-dev` PM2 app
#
# Assumes each target directory is already a git checkout of this repo with
# an `origin` remote authenticated via an SSH deploy key (added once during
# VPS setup - see setup-vps.sh). No token is embedded in the remote URL.
# ============================================

set -e

PM2_APP_NAME="${1:?Usage: deploy.sh <pm2-app-name> <branch> <repo-dir>}"
BRANCH="${2:?Usage: deploy.sh <pm2-app-name> <branch> <repo-dir>}"
REPO_DIR="${3:?Usage: deploy.sh <pm2-app-name> <branch> <repo-dir>}"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
log() { echo -e "${GREEN}[DEPLOY]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

[[ -d "$REPO_DIR" ]] || error "Repo directory not found: $REPO_DIR"
cd "$REPO_DIR"

log "Fetching latest '$BRANCH' for $PM2_APP_NAME..."
git fetch origin "$BRANCH"

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [[ "$LOCAL" == "$REMOTE" ]]; then
  log "Already up to date. No deployment needed."
  exit 0
fi

log "Pulling latest changes..."
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

log "Installing dependencies..."
npm ci --omit=dev

log "Reloading PM2 process: $PM2_APP_NAME"
if pm2 describe "$PM2_APP_NAME" > /dev/null 2>&1; then
  pm2 reload ecosystem.config.js --only "$PM2_APP_NAME" --update-env
else
  pm2 start ecosystem.config.js --only "$PM2_APP_NAME"
fi

pm2 save

log "Deployment of $PM2_APP_NAME complete!"
pm2 status
