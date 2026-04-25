#!/bin/sh
# Resetea el CM108 antes del arranque del servicio.
# Orden correcto para evitar D-state:
#   1. Matar aplay/arecord residuales
#   2. Desvincular (unbind) el dispositivo USB → libera D-state si los habia
#   3. IOCTL USBDEVFS_RESET via python3 para reset electrico completo
#   4. Re-vincular (bind) → el driver vuelve a enumerar el dispositivo
#
# Si se usase USBDEVFS_RESET mientras arecord tiene el dispositivo abierto
# en D-state, python3 TAMBIEN entra en D-state. El unbind previo lo evita.

# 1. Matar procesos ALSA residuales
pkill -KILL -x aplay   2>/dev/null || true
pkill -KILL -x arecord 2>/dev/null || true
sleep 0.2

# 2. Desvincular CM108 del driver USB (libera cualquier D-state)
for dev_dir in /sys/bus/usb/devices/*/; do
    product_file="${dev_dir}product"
    if grep -qiE "audio|CM108|C-Media" "$product_file" 2>/dev/null; then
        devname=$(basename "$dev_dir")
        echo "$devname" > /sys/bus/usb/drivers/usb/unbind 2>/dev/null || true
    fi
done
sleep 0.3

# 3. IOCTL USBDEVFS_RESET: reset electrico del dispositivo USB
#    (ahora es seguro porque ya no hay procesos bloqueados en el)
python3 - <<'PYEOF'
import fcntl, subprocess, re, time

USBDEVFS_RESET = 21524

try:
    out = subprocess.check_output(["lsusb"]).decode()
except Exception:
    out = ""

for line in out.splitlines():
    m = re.search(r"Bus (\d+) Device (\d+)", line)
    if m and re.search(r"audio|CM108|C-Media", line, re.IGNORECASE):
        path = "/dev/bus/usb/{}/{}".format(m.group(1), m.group(2).zfill(3))
        try:
            fd = open(path, "wb")
            fcntl.ioctl(fd, USBDEVFS_RESET, 0)
            fd.close()
            print("USB reset OK: " + path)
            time.sleep(1)
        except Exception as e:
            print("USB reset error (no critico): " + str(e))
PYEOF

# 4. Re-vincular el dispositivo para que el kernel vuelva a enumerarlo
for dev_dir in /sys/bus/usb/devices/*/; do
    product_file="${dev_dir}product"
    if grep -qiE "audio|CM108|C-Media" "$product_file" 2>/dev/null; then
        devname=$(basename "$dev_dir")
        echo "$devname" > /sys/bus/usb/drivers/usb/bind 2>/dev/null || true
    fi
done

sleep 1
