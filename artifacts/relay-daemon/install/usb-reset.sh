#!/bin/sh
# Resetea el driver snd_usb_audio antes del arranque del servicio.
# Se ejecuta como ExecStartPre en el .service (root).
#
# En VirtualBox, el IOCTL USBDEVFS_RESET falla con ENOTTY. El unbind/bind
# tampoco resuelve la corrupcion de estado interno de VirtualBox.
# La unica estrategia que funciona dentro del guest es descargar y recargar
# el modulo snd_usb_audio. Esto funciona aqui porque el daemon aun no ha
# arrancado: ningun proceso retiene el modulo, asi que modprobe -r tiene exito.

# 1. Matar procesos ALSA residuales (por si el servicio cayo de forma abrupta)
pkill -KILL -x aplay   2>/dev/null || true
pkill -KILL -x arecord 2>/dev/null || true
sleep 0.3

# 2. Descargar el modulo — libera todo el estado del driver ALSA para CM108
modprobe -r snd_usb_audio 2>/dev/null || true
sleep 0.5

# 3. Recargar el modulo — el kernel enumera de nuevo el device y lo deja limpio
modprobe snd_usb_audio 2>/dev/null || true
sleep 1.0
