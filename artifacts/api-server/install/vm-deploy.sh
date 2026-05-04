#!/usr/bin/env bash
# vm-deploy.sh — Instala/actualiza el API server eQSO en la VM Ubuntu
#
# Uso:
#   sudo bash vm-deploy.sh
#
# Requisitos previos:
#   - Node.js 20+, pnpm, ffmpeg, nginx, postgresql-client
#   - Usuario "eqso" existente (sudo useradd -r -m -s /bin/bash eqso)
#   - /etc/eqso-api/env configurado (ver vm-deploy.sh --env para plantilla)
#
# Lo que hace:
#   1. Actualiza el repo desde GitHub
#   2. Instala dependencias (pnpm install)
#   3. Compila API server y web client
#   4. Instala unidad systemd eqso-api.service
#   5. Instala config nginx
#   6. Reinicia servicios

set -euo pipefail

INSTALL_DIR="/opt/eqso-asorapa"
API_DIR="$INSTALL_DIR/artifacts/api-server"
CLIENT_DIR="$INSTALL_DIR/artifacts/eqso-client"
CONFIG_DIR="/etc/eqso-api"
SERVICE="eqso-api"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Plantilla de env ──────────────────────────────────────────────────────────
if [[ "${1:-}" == "--env" ]]; then
  cat <<'EOF'
# /etc/eqso-api/env
# Rellena los valores y guarda como /etc/eqso-api/env (chmod 600)

PORT=3000
EQSO_TCP_PORT=2172
EQSO_TCP_PORT_ALT=8008

# Cadena de conexion PostgreSQL (puede ser la de Replit si esta accesible)
DATABASE_URL=postgresql://usuario:password@host:5432/dbname

# Clave secreta para sesiones (genera con: openssl rand -hex 32)
SESSION_SECRET=cambia-esto-por-un-valor-secreto-aleatorio

# Tokens de radioenlace autorizados (separados por coma)
# El relay daemon los envia como "password" en el JOIN
# Genera con: openssl rand -hex 16
RELAY_TOKENS=token1-aqui,token2-aqui

# Puerto del servidor eQSO de Windows en el host (para referencia, no usar aqui)
# EQSO_WINDOWS_PORT=2171

NODE_ENV=production
EOF
  exit 0
fi

echo "========================================"
echo "  Desplegando eQSO API Server en VM"
echo "========================================"

# ── Verificar que corremos como root ─────────────────────────────────────────
if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: Ejecuta con sudo"
  exit 1
fi

# ── Dependencias ──────────────────────────────────────────────────────────────
echo "[1/6] Verificando dependencias…"
for cmd in node pnpm ffmpeg nginx; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "  ERROR: '$cmd' no encontrado."
    case "$cmd" in
      node)   echo "  Instala: curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs" ;;
      pnpm)   echo "  Instala: npm install -g pnpm" ;;
      ffmpeg) echo "  Instala: apt-get install -y ffmpeg" ;;
      nginx)  echo "  Instala: apt-get install -y nginx" ;;
    esac
    exit 1
  fi
  echo "  OK: $cmd"
done

# ── Actualizar repo ───────────────────────────────────────────────────────────
echo "[2/6] Actualizando repositorio desde GitHub…"
if [[ ! -d "$INSTALL_DIR/.git" ]]; then
  echo "  Clonando repositorio…"
  git clone https://github.com/daycart/eqso-linux-client.git "$INSTALL_DIR"
  chown -R eqso:eqso "$INSTALL_DIR"
else
  sudo -u eqso git -C "$INSTALL_DIR" pull origin main
fi

# ── Instalar dependencias y compilar ─────────────────────────────────────────
echo "[3/6] Instalando dependencias y compilando…"
sudo -u eqso bash -c "cd $INSTALL_DIR && pnpm install --frozen-lockfile"

echo "  Compilando API server…"
sudo -u eqso bash -c "cd $INSTALL_DIR && pnpm --filter @workspace/api-server run build 2>&1 | tail -5"

echo "  Compilando web client (BASE_PATH=/)…"
sudo -u eqso bash -c "cd $INSTALL_DIR && BASE_PATH=/ pnpm --filter @workspace/eqso-client run build 2>&1 | tail -5"

# ── Crear directorio de configuracion ────────────────────────────────────────
echo "[4/6] Configurando entorno…"
mkdir -p "$CONFIG_DIR"
chmod 750 "$CONFIG_DIR"

if [[ ! -f "$CONFIG_DIR/env" ]]; then
  echo ""
  echo "  AVISO: no existe $CONFIG_DIR/env"
  echo "  Genera la plantilla con:"
  echo "    sudo bash $0 --env > $CONFIG_DIR/env"
  echo "    sudo nano $CONFIG_DIR/env"
  echo "    sudo chmod 600 $CONFIG_DIR/env"
  echo ""
  echo "  Luego vuelve a ejecutar este script."
  exit 1
fi
chmod 600 "$CONFIG_DIR/env"
chown eqso:eqso "$CONFIG_DIR/env"

# ── Instalar systemd ──────────────────────────────────────────────────────────
echo "[5/6] Instalando unidad systemd $SERVICE.service…"
UNIT_DST="/etc/systemd/system/${SERVICE}.service"
cp "$SCRIPT_DIR/eqso-api.service" "$UNIT_DST"
sed -i "s|/opt/eqso-asorapa|${INSTALL_DIR}|g" "$UNIT_DST"
systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

sleep 2
if systemctl is-active --quiet "$SERVICE"; then
  echo "  SERVICIO ACTIVO en puerto $(grep PORT $CONFIG_DIR/env | head -1 | cut -d= -f2)"
else
  echo "  ERROR al arrancar. Logs:"
  journalctl -u "$SERVICE" -n 30 --no-pager
  exit 1
fi

# ── Instalar nginx ────────────────────────────────────────────────────────────
echo "[6/6] Configurando nginx…"
NGINX_DST="/etc/nginx/sites-available/asorapa"
cp "$SCRIPT_DIR/nginx-asorapa.conf" "$NGINX_DST"
sed -i "s|__CLIENT_DIST__|${CLIENT_DIR}/dist|g" "$NGINX_DST"

PORT=$(grep "^PORT=" "$CONFIG_DIR/env" | cut -d= -f2 | tr -d ' ')
sed -i "s|__API_PORT__|${PORT:-3000}|g" "$NGINX_DST"

ln -sf "$NGINX_DST" /etc/nginx/sites-enabled/asorapa
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo ""
echo "========================================"
echo "  Instalacion completa"
echo ""
echo "  Comandos utiles:"
echo "    Ver logs API:   journalctl -u $SERVICE -f"
echo "    Estado API:     systemctl status $SERVICE"
echo "    Reiniciar API:  systemctl restart $SERVICE"
echo "    Test HTTP:      curl http://localhost/api/healthz"
echo "    Test TCP:       nc -z localhost 2172 && echo OK"
echo "========================================"
