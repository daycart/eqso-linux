---
name: ffmpeg-static vs sistema en Linux/alsa
description: El binario de ffmpeg-static instalado por pnpm carece de libgsm en Ubuntu; inyectar su PATH rompe gsm-codec.
---

## Regla

En Linux con backend `alsa`, NO inyectar ffmpeg-static en PATH. El ffmpeg del sistema (`/usr/bin/ffmpeg`) tiene libgsm compilado; el binario de ffmpeg-static del pnpm content-addressable store NO.

**Why:** pnpm instala ffmpeg-static en su store interno (no en `node_modules/ffmpeg-static/ffmpeg` directamente visible). `require("ffmpeg-static")` lo resuelve y devuelve una ruta válida. Si main.ts lo inyecta en PATH, ese binario sin libgsm queda por delante del sistema y gsm-codec falla con "Unknown encoder 'libgsm'" (exit 8).

**How to apply:** En `main.ts`, la inyección de PATH está condicionada a `cfg.backend === "ffmpeg"`. Para backend `alsa` (Linux/Raspi) no se toca PATH → sistema ffmpeg tiene prioridad → libgsm disponible.

En `gsm-codec.ts`, `FFMPEG_BIN = "ffmpeg"` (literal, no require ffmpeg-static). Así, en alsa usa el sistema; en ffmpeg-audio, usa lo que main.ts haya inyectado en PATH.
