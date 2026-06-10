---
name: Relay daemon audio setup — portátil Ubuntu con Sound Blaster Play! 3
description: Lecciones de puesta en marcha del relay daemon con tarjeta USB y radio CB en Ubuntu
---

## Conexión física (Sound Blaster Play! 3)

La SB Play! 3 tiene DOS jacks separados (no combo TRRS):
- Jack MIC (rosa) ← altavoz/auricular de la radio (entrada al PC)
- Jack AURICULARES (verde) → micrófono/entrada de la radio (salida del PC)

Cables TRS estándar de 3 polos funcionan correctamente con dos jacks separados.

**Why:** Un cable TRS en un jack TRRS combo no conecta el pin de micrófono (4º anillo), dando RMS=6 aunque ALSA esté al máximo. Siempre verificar con `arecord` + análisis de nivel antes de tocar umbrales VOX.

## Diagnóstico de RMS bajo

Si el log muestra RMS=6..10 con ALSA Capture al 100%:
1. El audio físico NO llega al pin de micrófono — problema de cable/conector
2. Verificar con: `arecord -D plughw:X,0 -f S16_LE -r 44100 -c 1 -d 5 /tmp/test.wav`
3. Analizar: RMS real del WAV con Python struct — NO confiar en "suena vacío" (aplay puede ir a dispositivo incorrecto)

## PTT serial ocupado por Chrome

Chrome abre el puerto serie via Web Serial API cuando el usuario conecta el PTT en el cliente web. El relay daemon y Chrome NO pueden compartir el mismo puerto.

**Solución**: desconectar el PTT serial en el cliente web ANTES de arrancar el relay daemon.
**Diagnóstico**: `sudo fuser /dev/ttyACM1` → si aparece chrome, ese es el culpable.

**Why:** En un mismo PC con cliente web + relay daemon, el serial PTT solo puede usarlo uno a la vez. El relay daemon es el que debe controlarlo cuando está corriendo.

## Path estable para el puerto serie PTT

Los dispositivos USB serie se enumeran como `/dev/ttyACMx` y el número cambia al reconectar o reiniciar. En el config del relay usar siempre el path estable por número de serie:

```
/dev/serial/by-id/usb-<vendor>_<product>_<serial>-if00
```

Este path lo crea automáticamente Ubuntu sin necesitar reglas udev personalizadas.

**How to apply:** `ls /dev/serial/by-id/` para ver el path real, luego `sudo nano /etc/eqso-relay/CB.json` y reemplazar `/dev/ttyACM0` por el path completo.

**Cable CH340 del portátil David:** `usb-1a86_USB_Single_Serial_5909039839-if00`

**Why:** Si el config tiene `ttyACM1` y el dispositivo se enumera como `ttyACM0`, `SerialPtt.set()` falla silenciosamente (sin log de error visible), la radio CB nunca recibe PTT de RX aunque el audio sí llega a aplay.

## Valores de config validados (Sound Blaster Play! 3 + radio CB)

```json
"voxThresholdRms": 500,
"inputGain": 0.5,
"outputGain": 2.0
```

Señal cruda de radio CB vía SB Play! 3: RMS ~11000-17000 a 8kHz.
Con inputGain=0.5 la señal procesada está bien por encima del umbral sin saturar.
