---
name: FfmpegAudio cross-platform backend
description: Nuevo backend de audio multiplataforma para el relay daemon — usa ffmpeg en lugar de arecord/aplay
---

## Regla
El relay daemon tiene dos backends de audio seleccionables por config:
- `"alsa"` (default): usa `arecord`/`aplay` — solo Linux/Raspi, no requiere cambios
- `"ffmpeg"`: usa ffmpeg para captura y playback — Windows/Linux/Raspi/macOS

## Why
El backend ALSA es específico de Linux y no funciona en Windows. El backend ffmpeg usa el binario de `ffmpeg-static` (ya dependencia del proyecto) sin compilación nativa adicional.

## How to apply
- VM y Raspi/Linux: no añadir `backend` al JSON → usa "alsa" automáticamente
- Windows: añadir `"backend": "ffmpeg"` + `captureFormat: "dshow"` + `playbackFormat: "wasapi"`
- Linux con PulseAudio: `"backend": "ffmpeg"` + `captureFormat: "pulse"` + `playbackFormat: "pulse"`
- El campo `captureDevice` en dshow = nombre legible del device ("USB Audio Device"), en alsa = "plughw:1,0"

## Archivos clave
- `artifacts/relay-daemon/src/ffmpeg-audio.ts` — implementación FfmpegAudio
- `artifacts/relay-daemon/src/config.ts` — `backend?`, `captureFormat?`, `playbackFormat?` añadidos
- `artifacts/relay-daemon/src/main.ts` — factory + PATH injection de ffmpeg-static

## Gotcha: PATH injection
En `main.ts`, al arrancar se añade el directorio del binario ffmpeg-static al PATH del proceso. Esto hace que `gsm-codec.ts` (que usa `spawn("ffmpeg", ...)`) también encuentre el binario sin PATH del sistema. No-op en Linux con ffmpeg del sistema.
