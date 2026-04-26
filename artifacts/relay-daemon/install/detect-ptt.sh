#!/bin/sh
# detect-ptt.sh — Detecta el dispositivo ttyACM del CM108 y crea /dev/eqso-ptt
#
# Estrategia (por orden de fiabilidad):
#   1. Busca el ttyACM cuyo dispositivo USB padre también tiene interfaz de sonido
#      (el CM108 es un dispositivo compuesto: sonido + HID/serial en el mismo USB)
#   2. Si no puede confirmar, usa el primer ttyACM disponible como fallback
#
# Crea el symlink /dev/eqso-ptt → /dev/ttyACMx
# El relay lee siempre /dev/eqso-ptt, independientemente del número asignado.

SYMLINK="/dev/eqso-ptt"

rm -f "$SYMLINK"

found=""

# --- Estrategia 1: ttyACM cuyo USB parent tiene tarjeta de sonido ---
for dev in /dev/ttyACM*; do
    [ -e "$dev" ] || continue
    USB_PATH=$(udevadm info "$dev" 2>/dev/null | grep -m1 "^P:" | sed 's/^P: //')
    [ -z "$USB_PATH" ] && continue
    USB_PARENT=$(dirname "$USB_PATH")
    # ¿Ese mismo dispositivo USB tiene una tarjeta de sonido?
    if ls /sys${USB_PARENT}/*/sound/card* 2>/dev/null | grep -q card; then
        found="$dev"
        echo "PTT detect: $dev confirmado (mismo USB que tarjeta de sonido)"
        break
    fi
done

# --- Estrategia 2: ttyACM cuyo USB vendor sea C-Media (0d8c) ---
if [ -z "$found" ]; then
    for dev in /dev/ttyACM*; do
        [ -e "$dev" ] || continue
        VENDOR=$(udevadm info "$dev" 2>/dev/null | grep "ID_VENDOR_ID" | head -1 | cut -d= -f2)
        if [ "$VENDOR" = "0d8c" ]; then
            found="$dev"
            echo "PTT detect: $dev por VID C-Media (0d8c)"
            break
        fi
    done
fi

# --- Fallback: primer ttyACM disponible ---
if [ -z "$found" ]; then
    for dev in /dev/ttyACM*; do
        [ -e "$dev" ] || continue
        found="$dev"
        echo "PTT detect: fallback a $dev (sin confirmar origen USB)"
        break
    done
fi

if [ -z "$found" ]; then
    echo "PTT detect: ERROR — no se encontro ningun /dev/ttyACM*"
    echo "PTT detect: verifica que el CM108 esta conectado y el modulo cdc-acm cargado"
    exit 1
fi

ln -sf "$found" "$SYMLINK"
echo "PTT detect: symlink creado: $SYMLINK -> $found"
exit 0
