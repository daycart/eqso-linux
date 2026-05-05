#!/usr/bin/env bash
# =============================================================================
#  install-operator.sh — Instalador de radioenlace eQSO ASORAPA
#  Para operadores externos (ASORAPA, zonas de España, etc.)
#
#  Uso (como root o con sudo):
#    curl -fsSL https://raw.githubusercontent.com/daycart/eqso-linux-client/main/artifacts/relay-daemon/install/install-operator.sh | sudo bash
#
#  O descargando primero:
#    wget https://raw.githubusercontent.com/daycart/eqso-linux-client/main/artifacts/relay-daemon/install/install-operator.sh
#    sudo bash install-operator.sh
#
#  Requisitos hardware:
#    - Interfaz de audio USB CM108 o compatible (CM108, PCM2902, etc.)
#      para conectar la radio CB (audio TX/RX)
#    - Cable PTT serial USB CH340/CH341 o CM108 HID
#      para activar la emisión de la radio
#    - Ubuntu 20.04 / 22.04 / 24.04 (Debian también funciona)
# =============================================================================

set -euo pipefail

# ── Colores ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()      { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
header()  { echo -e "\n${BOLD}${CYAN}$*${NC}\n"; }

# ── Constantes ────────────────────────────────────────────────────────────────
REPO_URL="https://github.com/daycart/eqso-linux-client.git"
INSTALL_DIR="/opt/eqso-relay"
CONFIG_DIR="/etc/eqso-relay"
SERVICE_USER="eqso"
SERVER_HOST="193.152.83.229"
SERVER_PORT="2172"

# ── Verificar root ─────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  error "Este script debe ejecutarse como root: sudo bash $0"
  exit 1
fi

clear
echo -e "${BOLD}"
echo "╔══════════════════════════════════════════════════════╗"
echo "║      Instalador de Radioenlace eQSO ASORAPA          ║"
echo "║      Red de radio CB por internet — España           ║"
echo "╚══════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo "Este script instalará el demonio de radioenlace eQSO en"
echo "este equipo. Necesitarás:"
echo "  1. Tu indicativo de radioaficionado o CB"
echo "  2. El token de acceso (facilitado por el administrador)"
echo "  3. La radio conectada vía interfaz USB (CM108 o similar)"
echo ""
echo "Puedes interrumpir en cualquier momento con Ctrl+C."
echo ""

# ── Datos del operador ────────────────────────────────────────────────────────
header "► Datos del radioenlace"

read -rp "  Indicativo (sin prefijo 0R-): " CALLSIGN
CALLSIGN="${CALLSIGN^^}"  # mayúsculas
if [[ -z "$CALLSIGN" || ${#CALLSIGN} -gt 8 ]]; then
  error "Indicativo inválido (max 8 caracteres)"
  exit 1
fi

read -rp "  Nombre/descripción del enlace (ej: ASORAPA Sevilla): " LABEL
LABEL="${LABEL:-Radioenlace CB}"

read -rp "  Sala a la que conectar [CB]: " ROOM
ROOM="${ROOM:-CB}"

read -rsp "  Token de acceso (dado por el admin): " TOKEN
echo ""
if [[ -z "$TOKEN" ]]; then
  error "El token no puede estar vacío"
  exit 1
fi

echo ""
echo "  Servidor: ${SERVER_HOST}:${SERVER_PORT}"
echo "  Indicativo en red: 0R-${CALLSIGN}"
echo "  Sala: ${ROOM}"
echo ""

# ── Dependencias del sistema ──────────────────────────────────────────────────
header "► [1/6] Instalando dependencias del sistema"

apt-get update -qq
apt-get install -y --no-install-recommends \
  git curl ffmpeg alsa-utils usbutils \
  build-essential ca-certificates gnupg 2>&1 | grep -E "^(Inst|Err)" || true
ok "Paquetes del sistema instalados"

# ── Node.js 20 ────────────────────────────────────────────────────────────────
header "► [2/6] Instalando Node.js 20"

if ! command -v node &>/dev/null || [[ "$(node --version | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  info "Instalando Node.js 20 via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - 2>&1 | tail -5
  apt-get install -y nodejs 2>&1 | grep -E "^(Inst|Err)" || true
  ok "Node.js $(node --version) instalado"
else
  ok "Node.js $(node --version) ya disponible"
fi

# pnpm
if ! command -v pnpm &>/dev/null; then
  info "Instalando pnpm..."
  npm install -g pnpm --silent
fi
ok "pnpm $(pnpm --version)"

# ── Usuario del sistema ───────────────────────────────────────────────────────
header "► [3/6] Creando usuario del sistema"

if ! id "$SERVICE_USER" &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin \
          --groups audio "$SERVICE_USER"
  ok "Usuario '$SERVICE_USER' creado"
else
  usermod -aG audio "$SERVICE_USER" 2>/dev/null || true
  ok "Usuario '$SERVICE_USER' ya existe"
fi

# ── Clonar/actualizar el repositorio ─────────────────────────────────────────
header "► [4/6] Descargando el software"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Actualizando repositorio existente..."
  git -C "$INSTALL_DIR" pull --ff-only
  ok "Repositorio actualizado"
else
  info "Clonando repositorio (solo rama main, sin historial)..."
  git clone --depth=1 --branch main "$REPO_URL" "$INSTALL_DIR"
  ok "Repositorio clonado en $INSTALL_DIR"
fi

chown -R "$SERVICE_USER:audio" "$INSTALL_DIR"

# ── Compilar el demonio ───────────────────────────────────────────────────────
header "► [5/6] Compilando el demonio de radioenlace"

DAEMON_DIR="$INSTALL_DIR/artifacts/relay-daemon"

info "Instalando dependencias npm..."
su -s /bin/bash "$SERVICE_USER" -c "
  cd '$DAEMON_DIR'
  pnpm install --frozen-lockfile 2>&1 | tail -3
"

info "Compilando TypeScript..."
su -s /bin/bash "$SERVICE_USER" -c "
  cd '$DAEMON_DIR'
  pnpm run build 2>&1 | tail -5
"

if [[ ! -f "$DAEMON_DIR/dist/main.mjs" ]]; then
  error "La compilación falló. Revisa los errores arriba."
  exit 1
fi
ok "Demonio compilado: $DAEMON_DIR/dist/main.mjs"

# ── Detectar dispositivos de audio ───────────────────────────────────────────
echo ""
header "► Detección de dispositivos de audio"
echo "  Dispositivos de captura (micrófonos) disponibles:"
arecord -l 2>/dev/null | grep -E "^card" | sed 's/^/    /' || echo "    (ninguno detectado)"
echo ""
echo "  Buscando interfaz CM108/C-Media USB..."
CM_LINE=$(aplay -l 2>/dev/null | grep -iE "CM108|C-Media|USB Audio|PCM2902" | head -1 || true)

CAPTURE_DEV="plughw:1,0"
PLAYBACK_DEV="plughw:1,0"

if [[ -n "$CM_LINE" ]]; then
  CARD_NUM=$(echo "$CM_LINE" | sed 's/.*card //;s/:.*//' | tr -d ' ')
  CAPTURE_DEV="plughw:${CARD_NUM},0"
  PLAYBACK_DEV="plughw:${CARD_NUM},0"
  ok "CM108 detectado en tarjeta $CARD_NUM → usando plughw:${CARD_NUM},0"
else
  warn "CM108 no detectado. Se usará 'plughw:1,0' por defecto."
  warn "Puedes cambiarlo después en $CONFIG_DIR/${ROOM}.json"
fi

# ── Crear configuración ───────────────────────────────────────────────────────
header "► [6/6] Creando configuración"

mkdir -p "$CONFIG_DIR"
chmod 750 "$CONFIG_DIR"

CONFIG_FILE="$CONFIG_DIR/${ROOM}.json"
INSTANCE_NAME="${ROOM}"

cat > "$CONFIG_FILE" << JSONEOF
{
  "callsign": "0R-${CALLSIGN}",
  "room": "${ROOM}",
  "password": "${TOKEN}",
  "message": "${LABEL}",

  "server": "${SERVER_HOST}",
  "port": ${SERVER_PORT},

  "reconnectMinMs": 3000,
  "reconnectMaxMs": 60000,

  "audio": {
    "captureDevice":     "${CAPTURE_DEV}",
    "playbackDevice":    "${PLAYBACK_DEV}",
    "vox":               true,
    "voxThresholdRms":   1500,
    "voxHangMs":         5000,
    "txGateRms":         50,
    "inputGain":         0.3,
    "outputGain":        1.0,
    "postRxSuppressMs":  6000
  },

  "control": {
    "enabled": true,
    "port":    8009,
    "host":    "127.0.0.1"
  },

  "ptt": {
    "device":   "/dev/eqso-ptt",
    "method":   "rts",
    "inverted": false
  }
}
JSONEOF

chown root:"$SERVICE_USER" "$CONFIG_FILE"
chmod 640 "$CONFIG_FILE"
ok "Config creada: $CONFIG_FILE"

# ── Instalar scripts auxiliares ───────────────────────────────────────────────
SCRIPTS_DIR="$DAEMON_DIR/install"
chmod +x "$SCRIPTS_DIR/usb-reset.sh" \
         "$SCRIPTS_DIR/alsa-setup.sh" \
         "$SCRIPTS_DIR/detect-ptt.sh" \
         "$SCRIPTS_DIR/stop-cleanup.sh"

# ── Instalar servicio systemd ─────────────────────────────────────────────────
UNIT_SRC="$SCRIPTS_DIR/eqso-relay@.service"
UNIT_DST="/etc/systemd/system/eqso-relay@.service"

sed "s|/opt/eqso-asorapa/artifacts/relay-daemon|${DAEMON_DIR}|g" \
    "$UNIT_SRC" > "$UNIT_DST"

# Ajustar el usuario del servicio
sed -i "s|^User=.*|User=${SERVICE_USER}|" "$UNIT_DST"

systemctl daemon-reload
systemctl enable "eqso-relay@${INSTANCE_NAME}"
ok "Servicio systemd instalado: eqso-relay@${INSTANCE_NAME}"

# ── Regla udev para /dev/eqso-ptt ────────────────────────────────────────────
UDEV_RULE="/etc/udev/rules.d/99-eqso-ptt.rules"
cat > "$UDEV_RULE" << 'UDEVEOF'
# CH340/CH341 USB serial → /dev/eqso-ptt (cable PTT)
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="55d3", SYMLINK+="eqso-ptt", MODE="0660", GROUP="dialout"
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523", SYMLINK+="eqso-ptt", MODE="0660", GROUP="dialout"
# CM108 HID como PTT (si se usa el HID en lugar del serial)
SUBSYSTEM=="tty", ATTRS{idVendor}=="0d8c", ATTRS{idProduct}=="0014", SYMLINK+="eqso-ptt-cm108", MODE="0660", GROUP="dialout"
UDEVEOF

usermod -aG dialout "$SERVICE_USER" 2>/dev/null || true
udevadm control --reload-rules
udevadm trigger
ok "Regla udev instalada: $UDEV_RULE"

# ── Arrancar el servicio ──────────────────────────────────────────────────────
info "Arrancando eqso-relay@${INSTANCE_NAME}..."
systemctl restart "eqso-relay@${INSTANCE_NAME}" || true

sleep 3
echo ""
if systemctl is-active --quiet "eqso-relay@${INSTANCE_NAME}"; then
  echo -e "${GREEN}${BOLD}"
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║   ✓  Radioenlace instalado y ACTIVO                  ║"
  echo "╚══════════════════════════════════════════════════════╝"
  echo -e "${NC}"
else
  echo -e "${YELLOW}${BOLD}"
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║   ⚠  Servicio instalado pero no está activo todavía  ║"
  echo "║   Revisa los logs con el comando de abajo            ║"
  echo "╚══════════════════════════════════════════════════════╝"
  echo -e "${NC}"
fi

echo ""
echo -e "${BOLD}Resumen de tu instalación:${NC}"
echo "  Indicativo en red : 0R-${CALLSIGN}"
echo "  Sala              : ${ROOM}"
echo "  Servidor          : ${SERVER_HOST}:${SERVER_PORT}"
echo "  Config            : $CONFIG_FILE"
echo "  Servicio          : eqso-relay@${INSTANCE_NAME}"
echo ""
echo -e "${BOLD}Comandos útiles:${NC}"
echo "  Ver logs en vivo  : journalctl -u eqso-relay@${INSTANCE_NAME} -f"
echo "  Estado            : systemctl status eqso-relay@${INSTANCE_NAME}"
echo "  Reiniciar         : systemctl restart eqso-relay@${INSTANCE_NAME}"
echo "  Estado HTTP       : curl http://127.0.0.1:8009/status"
echo "  PTT manual TX     : curl -X POST http://127.0.0.1:8009/ptt/start"
echo "  PTT manual stop   : curl -X POST http://127.0.0.1:8009/ptt/stop"
echo "  Reconectar        : curl -X POST http://127.0.0.1:8009/reconnect"
echo ""
echo -e "${BOLD}Ajuste de audio:${NC}"
echo "  Edita $CONFIG_FILE"
echo "  Parámetros clave:"
echo "    voxThresholdRms : umbral VOX (sube si dispara con ruido, baja si no capta)"
echo "    inputGain       : ganancia micrófono (0.1 a 1.5)"
echo "    outputGain      : ganancia altavoz (0.5 a 2.0)"
echo "    captureDevice   : dispositivo ALSA de entrada (arecord -l para ver)"
echo "    playbackDevice  : dispositivo ALSA de salida (aplay -l para ver)"
echo ""
echo "  Tras cambiar la config: systemctl restart eqso-relay@${INSTANCE_NAME}"
echo ""
echo -e "${CYAN}Para actualizaciones futuras:${NC}"
echo "  cd $INSTALL_DIR && git pull"
echo "  cd artifacts/relay-daemon && pnpm run build"
echo "  systemctl restart eqso-relay@${INSTANCE_NAME}"
echo ""
