#!/bin/bash
# vm-deploy.sh — Actualiza el relay-daemon desde GitHub y reinicia el servicio
# Uso: sudo /opt/eqso-asorapa/artifacts/relay-daemon/install/vm-deploy.sh

set -e

REPO_DIR="/opt/eqso-asorapa"
SERVICE="eqso-relay@CB"
CONFIG_FILE="/etc/eqso-relay/CB.json"
EQSO_SERVER="193.152.83.229"
EQSO_PORT=2172

echo "==> Actualizando desde GitHub..."
cd "$REPO_DIR"
git pull origin main

# Asegurar que la configuracion apunta al servidor eQSO correcto
if [ -f "$CONFIG_FILE" ]; then
  CURRENT_SERVER=$(python3 -c "import json,sys; d=json.load(open('$CONFIG_FILE')); print(d.get('server',''))" 2>/dev/null || echo "")
  CURRENT_PORT=$(python3 -c "import json,sys; d=json.load(open('$CONFIG_FILE')); print(d.get('port',0))" 2>/dev/null || echo "0")

  if [ "$CURRENT_SERVER" != "$EQSO_SERVER" ] || [ "$CURRENT_PORT" != "$EQSO_PORT" ]; then
    echo "==> Actualizando servidor en $CONFIG_FILE: $CURRENT_SERVER:$CURRENT_PORT → $EQSO_SERVER:$EQSO_PORT"
    python3 - <<PYEOF
import json
with open("$CONFIG_FILE") as f:
    d = json.load(f)
d["server"] = "$EQSO_SERVER"
d["port"] = $EQSO_PORT
with open("$CONFIG_FILE", "w") as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
print("  Config actualizada correctamente.")
PYEOF
  else
    echo "==> Servidor ya configurado correctamente: $EQSO_SERVER:$EQSO_PORT"
  fi
else
  echo "==> AVISO: $CONFIG_FILE no existe. Creando desde ejemplo..."
  cp "$REPO_DIR/artifacts/relay-daemon/install/config.example.json" "$CONFIG_FILE"
  echo "  Edita $CONFIG_FILE si necesitas cambiar callsign, audio, etc."
fi

echo "==> Reiniciando servicio $SERVICE..."
systemctl restart "$SERVICE"
sleep 4

echo "==> Estado del servicio:"
systemctl status "$SERVICE" --no-pager -n 15
