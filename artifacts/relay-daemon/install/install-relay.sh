#!/usr/bin/env bash
# ============================================================
#  eQSO ASORAPA — Instalador automático de Relay Daemon
#  Compatible con Ubuntu / Debian / Raspberry Pi OS
#
#  Instalación con un solo comando:
#    bash <(curl -fsSL https://raw.githubusercontent.com/daycart/eqso-linux-client/main/artifacts/relay-daemon/install/install-relay.sh)
#
#  O clonando el repo primero:
#    git clone https://github.com/daycart/eqso-linux-client
#    bash eqso-linux-client/artifacts/relay-daemon/install/install-relay.sh
# ============================================================

set -euo pipefail

REPO_URL="https://github.com/daycart/eqso-linux-client"
INSTALL_DIR="$HOME/eqso-linux-client"
CONFIG_DIR="/etc/eqso-relay"
CURRENT_USER="$(id -un)"

# ── Colores ────────────────────────────────────────────────
R='\033[0;31m'; G='\033[0;32m'; Y='\033[1;33m'; B='\033[1;34m'; N='\033[0m'
ok()   { echo -e "${G}✓${N} $1"; }
info() { echo -e "${B}→${N} $1"; }
warn() { echo -e "${Y}!${N} $1"; }
die()  { echo -e "${R}✗ ERROR:${N} $1"; exit 1; }
ask()  { printf "${Y}?${N} %s " "$1"; }

header() {
  echo ""
  echo -e "${B}══════════════════════════════════════════════${N}"
  echo -e "${B}  $1${N}"
  echo -e "${B}══════════════════════════════════════════════${N}"
}

# ── Verificar usuario ──────────────────────────────────────
[ "$(id -u)" -eq 0 ] && die "No ejecutes como root. Usa tu usuario normal (con sudo disponible)."

header "eQSO ASORAPA — Instalador de Relay Daemon"
echo "  Instala y configura el nodo de radioenlace eQSO en este equipo."
echo "  Se necesitará contraseña sudo para instalar paquetes y el servicio."
echo ""

# ── Paso 1: Dependencias del sistema ──────────────────────
header "1/6  Dependencias del sistema"

PKGS=""
command -v ffmpeg &>/dev/null || PKGS="$PKGS ffmpeg"
command -v git    &>/dev/null || PKGS="$PKGS git"
command -v curl   &>/dev/null || PKGS="$PKGS curl"

if [ -n "$PKGS" ]; then
  info "Instalando:$PKGS"
  sudo apt-get update -qq
  sudo apt-get install -y $PKGS -qq
fi
ok "ffmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"

# ── Grupos del sistema (audio + dialout para serial PTT) ──
GROUPS_CHANGED=0
for grp in audio dialout; do
  if ! id -nG "$CURRENT_USER" | grep -qw "$grp"; then
    info "Añadiendo usuario al grupo $grp..."
    sudo usermod -aG "$grp" "$CURRENT_USER"
    GROUPS_CHANGED=1
  fi
done
[ "$GROUPS_CHANGED" -eq 1 ] && warn "Se añadieron grupos. Cierra y abre sesión si hay problemas de permisos."

# ── Paso 2: pnpm ───────────────────────────────────────────
header "2/6  Instalando pnpm"

export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$PNPM_HOME:$PATH"

if ! command -v pnpm &>/dev/null; then
  info "Descargando pnpm..."
  curl -fsSL https://get.pnpm.io/install.sh | sh -
  export PATH="$PNPM_HOME:$PATH"
fi
ok "pnpm $(pnpm --version 2>/dev/null | head -1)"

# ── Paso 3: Node.js ────────────────────────────────────────
header "3/6  Instalando Node.js"

if ! command -v node &>/dev/null; then
  info "Instalando Node.js LTS..."
  pnpm env use --global lts 2>/dev/null || pnpm runtime set node lts -g 2>/dev/null || true
fi

NODE_BIN="$(command -v node 2>/dev/null || true)"
[ -z "$NODE_BIN" ] && die "Node.js no encontrado. Reinicia la terminal y vuelve a ejecutar el script."
ok "node $("$NODE_BIN" --version) en $NODE_BIN"

# ── Paso 4: Código fuente ──────────────────────────────────
header "4/6  Código fuente"

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Repositorio existente → actualizando..."
  git -C "$INSTALL_DIR" pull --quiet
  ok "Código actualizado"
else
  info "Clonando repositorio en $INSTALL_DIR ..."
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
  ok "Repositorio clonado"
fi

info "Instalando dependencias npm..."
cd "$INSTALL_DIR"
pnpm install --reporter=silent 2>&1 | grep -v "^$\|WARN\|onlyBuiltDependencies\|pnpm field" || true

info "Compilando relay daemon..."
pnpm --filter @workspace/relay-daemon run build
ok "Compilación completada"

# ── Paso 5: Configuración interactiva ─────────────────────
header "5/6  Configuración del relay"
echo ""

echo "Dispositivos de audio detectados (busca tu tarjeta USB):"
aplay -l 2>/dev/null | grep -E "tarjeta [0-9]+:|card [0-9]+:" || echo "  (ninguno)"
echo ""

ask "Callsign del relay (formato 0R-NOMBRE, ej: 0R-PORTATIL):"
read -r CALLSIGN
[[ "$CALLSIGN" =~ ^0R- ]] || warn "Se recomienda el formato 0R-NOMBRE para relays"

ask "Número de tarjeta USB de audio (el número X de 'tarjeta X' arriba, ej: 1):"
read -r CARD_NUM
AUDIO_DEVICE="plughw:${CARD_NUM},0"

echo ""
echo "Puertos serie detectados (para PTT):"

# Preferir paths estables /dev/serial/by-id/ — no cambian al reiniciar ni al
# reconectar el cable USB. Si no hay by-id, mostrar los paths ttyACMx como fallback.
BYID_LIST=()
if [ -d /dev/serial/by-id ]; then
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    target=$(readlink -f "/dev/serial/by-id/$entry" 2>/dev/null || echo "?")
    BYID_LIST+=("/dev/serial/by-id/$entry")
    echo "  /dev/serial/by-id/$entry  →  $target"
  done < <(ls /dev/serial/by-id/ 2>/dev/null)
fi

if [ "${#BYID_LIST[@]}" -eq 0 ]; then
  # No hay by-id — mostrar ttyACM/ttyUSB como alternativa
  RAW_LIST=$(ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null || true)
  if [ -n "$RAW_LIST" ]; then
    echo "$RAW_LIST" | sed 's/^/  /'
    warn "Estos paths pueden cambiar al reiniciar. Conecta el cable y vuelve a ejecutar el script para obtener el path estable."
  else
    echo "  (ninguno detectado)"
  fi
fi
echo ""

PTT_DEVICE=""
if [ "${#BYID_LIST[@]}" -eq 1 ]; then
  # Un solo dispositivo — ofrecer como default
  PTT_DEFAULT="${BYID_LIST[0]}"
  ask "Puerto serie PTT [Enter = $PTT_DEFAULT | escribe otro | vacío para desactivar]:"
  read -r PTT_INPUT
  PTT_DEVICE="${PTT_INPUT:-$PTT_DEFAULT}"
elif [ "${#BYID_LIST[@]}" -gt 1 ]; then
  ask "Puerto serie PTT (copia uno de los paths /dev/serial/by-id/... de arriba) [Enter si no hay PTT]:"
  read -r PTT_DEVICE
else
  ask "Puerto serie PTT (ej: /dev/ttyACM0) [Enter si no hay cable PTT]:"
  read -r PTT_DEVICE
fi

ask "Token/contraseña del relay (facilitado por el administrador):"
read -r -s RELAY_TOKEN
echo ""

ask "Sala eQSO [default: CB]:"
read -r ROOM
ROOM="${ROOM:-CB}"

ask "Servidor eQSO [default: asorapa.sytes.net]:"
read -r SERVER
SERVER="${SERVER:-asorapa.sytes.net}"

ask "Puerto del servidor [default: 2172]:"
read -r PORT
PORT="${PORT:-2172}"

# ── Crear fichero de configuración ────────────────────────
sudo mkdir -p "$CONFIG_DIR"

cat << ENDJSON | sudo tee "$CONFIG_DIR/$ROOM.json" > /dev/null
{
  "callsign": "$CALLSIGN",
  "room": "$ROOM",
  "password": "$RELAY_TOKEN",
  "message": "Radio Enlace CB",
  "server": "$SERVER",
  "port": $PORT,
  "audio": {
    "captureDevice":  "$AUDIO_DEVICE",
    "playbackDevice": "$AUDIO_DEVICE",
    "vox": true,
    "voxThresholdRms": 1500,
    "voxHangMs": 5000,
    "txGateRms": 50,
    "inputGain": 0.3,
    "outputGain": 1.0,
    "postRxSuppressMs": 6000
  },
  "ptt": {
    "device": "$PTT_DEVICE",
    "method": "rts",
    "inverted": false
  }
}
ENDJSON

ok "Configuración guardada en $CONFIG_DIR/$ROOM.json"

# ── Paso 6: Servicio systemd ───────────────────────────────
header "6/6  Servicio systemd"

cat << ENDSVC | sudo tee "/etc/systemd/system/eqso-relay@.service" > /dev/null
[Unit]
Description=eQSO Radioenlace — sala %i
After=network-online.target sound.target
Wants=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
User=$CURRENT_USER
Group=audio
Environment=RELAY_INSTANCE=%i
Environment=NODE_ENV=production
WorkingDirectory=$INSTALL_DIR/artifacts/relay-daemon
ExecStart=$NODE_BIN --enable-source-maps dist/main.mjs
Restart=always
RestartSec=5s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=eqso-relay-%i
PrivateTmp=true
ProtectSystem=full
NoNewPrivileges=true
SupplementaryGroups=audio
KillMode=control-group
KillSignal=SIGTERM
TimeoutStopSec=8

[Install]
WantedBy=multi-user.target
ENDSVC

sudo systemctl daemon-reload
sudo systemctl enable "eqso-relay@$ROOM"
sudo systemctl start  "eqso-relay@$ROOM"

sleep 2

# ── Verificar estado ────────────────────────────────────────
STATUS=$(sudo systemctl is-active "eqso-relay@$ROOM" 2>/dev/null || echo "unknown")

echo ""
if [ "$STATUS" = "active" ]; then
  echo -e "${G}══════════════════════════════════════════════${N}"
  echo -e "${G}  ✓  INSTALACIÓN COMPLETADA — Servicio ACTIVO${N}"
  echo -e "${G}══════════════════════════════════════════════${N}"
else
  echo -e "${Y}══════════════════════════════════════════════${N}"
  echo -e "${Y}  ! INSTALACIÓN COMPLETADA — Verifica el estado${N}"
  echo -e "${Y}══════════════════════════════════════════════${N}"
  warn "El servicio no arrancó automáticamente. Comprueba los logs."
fi

echo ""
echo "  Callsign : $CALLSIGN"
echo "  Servidor : $SERVER:$PORT"
echo "  Sala     : $ROOM"
echo "  Audio    : $AUDIO_DEVICE"
[ -n "$PTT_DEVICE" ] && echo "  PTT      : $PTT_DEVICE" || echo "  PTT      : deshabilitado"
echo "  Config   : $CONFIG_DIR/$ROOM.json"
echo "  Código   : $INSTALL_DIR"
echo ""
echo "  Comandos útiles:"
echo "    Estado    : sudo systemctl status eqso-relay@$ROOM"
echo "    Logs      : sudo journalctl -u eqso-relay@$ROOM -f"
echo "    Parar     : sudo systemctl stop eqso-relay@$ROOM"
echo "    Reiniciar : sudo systemctl restart eqso-relay@$ROOM"
echo ""
echo "  Calibración VOX (ver nivel RMS en los logs):"
echo "    sudo journalctl -u eqso-relay@$ROOM -f | grep nivel"
echo "    Sube voxThresholdRms si dispara con ruido (edita $CONFIG_DIR/$ROOM.json)"
echo ""

echo "  Últimas líneas del log:"
sudo journalctl -u "eqso-relay@$ROOM" -n 12 --no-pager 2>/dev/null || true
