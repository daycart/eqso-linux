#!/bin/sh
# Limpieza de parada: desvincula el CM108 del bus USB para rescatar procesos
# arecord/aplay en D-state, los mata, y reconecta el dispositivo.
#
# Se llama desde ExecStop (ANTES de SIGTERM al proceso principal) y tambien
# desde ExecStopPost como red de seguridad final.
#
# Por que unbind y no authorized 0/1:
#   "authorized" corta alimentacion pero el kernel no desbloquea los
#   file-descriptors abiertos → los procesos siguen en D-state.
#   "unbind" desregistra el dispositivo del driver USB: el kernel marca todos
#   los URBs pendientes como cancelados, devuelve error a arecord/aplay y los
#   despierta del D-state para que puedan morir.

# 1. Desvincular CM108 del driver USB (libera D-state inmediatamente)
for dev_dir in /sys/bus/usb/devices/*/; do
    product_file="${dev_dir}product"
    if grep -qiE "audio|CM108|C-Media" "$product_file" 2>/dev/null; then
        devname=$(basename "$dev_dir")
        echo "$devname" > /sys/bus/usb/drivers/usb/unbind 2>/dev/null || true
        sleep 0.4
        # Reconectar para que el siguiente arranque encuentre el dispositivo
        echo "$devname" > /sys/bus/usb/drivers/usb/bind   2>/dev/null || true
        sleep 0.2
    fi
done

# 2. Matar cualquier proceso ALSA residual (ya deben haber salido del D-state)
pkill -KILL -x aplay   2>/dev/null || true
pkill -KILL -x arecord 2>/dev/null || true

# 3. Matar python3 si sigue vivo (usb-reset.sh puede haberse quedado colgado)
pkill -KILL -f "usb-reset" 2>/dev/null || true

exit 0
