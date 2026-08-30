---
name: Seleccion de ffmpeg-static por plataforma
description: Windows prioriza ffmpeg-static para DirectShow; Linux/alsa prioriza el FFmpeg del sistema con libgsm.
---

## Regla

En Windows con backend `ffmpeg`, priorizar `ffmpeg-static` para la captura DirectShow. En Linux con backend `alsa`, NO inyectar ffmpeg-static en PATH: el ffmpeg del sistema (`/usr/bin/ffmpeg`) tiene libgsm compilado y el binario estático puede no tenerlo.

**Why:** La VM Windows funcionaba con `ffmpeg-static`; al forzar el FFmpeg de Winget/Gyan mediante `FFMPEG_PATH`, abrir DirectShow provocó bloqueos de entrada en VirtualBox. En Linux, poner el binario estático por delante del sistema rompe el encoder GSM con "Unknown encoder 'libgsm'".

**How to apply:** Resolver primero `ffmpeg-static` en Windows y usar `FFMPEG_PATH` solo como fallback. Para backend `alsa` (Linux/Raspi), no tocar PATH: el FFmpeg del sistema debe conservar la prioridad.

En `gsm-codec.ts`, `FFMPEG_BIN = "ffmpeg"` (literal, no require ffmpeg-static). Así, en alsa usa el sistema; en ffmpeg-audio, usa lo que main.ts haya inyectado en PATH.
