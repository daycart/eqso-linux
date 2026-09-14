#!/usr/bin/env bash
# update.sh — Actualiza eQSO en la VM (llamado por el GitHub Action de CI/CD)
#
# Uso:
#   bash /opt/eqso-asorapa/artifacts/api-server/install/update.sh
#
# El usuario que ejecuta este script (p.ej. "eqso") necesita permiso sudo
# solo para systemctl restart. Instala el sudoers snippet con:
#   sudo cp artifacts/api-server/install/sudoers-eqso /etc/sudoers.d/eqso
#   sudo chmod 440 /etc/sudoers.d/eqso

set -euo pipefail

INSTALL_DIR="/opt/eqso-asorapa"
SERVICE="eqso-api"
DEPLOY_LOG="$INSTALL_DIR/deploy.log"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$DEPLOY_LOG"; }

log "=== Deploy iniciado (commit: ${GITHUB_SHA:-local}) ==="

# ── 1. Actualizar repositorio ─────────────────────────────────────────────────
log "[1/5] git pull origin main…"
git -C "$INSTALL_DIR" fetch --prune origin
git -C "$INSTALL_DIR" reset --hard origin/main

# ── 2. Instalar dependencias ──────────────────────────────────────────────────
log "[2/5] pnpm install…"
cd "$INSTALL_DIR"
pnpm install --frozen-lockfile 2>&1 | tail -5

# ── 3. Compilar API server ────────────────────────────────────────────────────
log "[3/5] Compilando API server…"
pnpm --filter @workspace/api-server run build 2>&1 | tail -5

# ── 4. Compilar y copiar cliente web ─────────────────────────────────────────
log "[4/5] Compilando cliente web…"
BASE_PATH=/ pnpm --filter @workspace/eqso-client run build 2>&1 | tail -5

CLIENT_SRC="$INSTALL_DIR/artifacts/eqso-client/dist/public"
CLIENT_DST="$INSTALL_DIR/artifacts/api-server/dist/public"
mkdir -p "$CLIENT_DST"
rsync -a --delete "$CLIENT_SRC/" "$CLIENT_DST/"
log "  Cliente sincronizado en $CLIENT_DST"

# ── 5. Reiniciar servicio ─────────────────────────────────────────────────────
log "[5/5] Reiniciando $SERVICE.service…"
sudo systemctl restart "$SERVICE"

sleep 3
if sudo systemctl is-active --quiet "$SERVICE"; then
  log "=== Deploy completado OK — $SERVICE activo ==="
else
  log "ERROR: el servicio no arrancó. Últimos logs:"
  sudo journalctl -u "$SERVICE" -n 30 --no-pager
  exit 1
fi
