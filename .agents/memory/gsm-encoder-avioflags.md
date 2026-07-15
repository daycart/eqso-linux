---
name: GSM encoder crash -avioflags direct
description: El muxer GSM de salida de ffmpeg no soporta -avioflags direct — causa exit 1 silencioso inmediato si se incluye en el encoder.
---

## La regla

**Nunca usar `-avioflags direct` en el GsmEncoder** (s16le→gsm). Causa que ffmpeg termine con exit 1 inmediatamente al abrir el output pipe, sin emitir nada a stderr si `-loglevel quiet`.

**Sí se puede usar** en el GsmDecoder (gsm→s16le) porque el demuxer/decoder con salida raw s16le sí soporta flush directo.

## Por qué

El muxer GSM de ffmpeg escribe en un AVIOContext con seeking. `-avioflags direct` desactiva el buffer interno de AVIO, lo que es incompatible con muxers que requieren seek-back (como GSM al escribir headers). Resultado: ffmpeg abre el pipe, intenta inicializar el muxer y falla silenciosamente.

## Síntoma observado

- Servicio arranca sin errores visibles
- `ps aux | grep ffmpeg` muestra solo el proceso decoder (GSM→s16le)
- El encoder (s16le→GSM) no aparece en ps porque murió en <1s tras el spawn
- `txPackets` permanece 0 aunque VOX active PTT y arecord capture audio
- `rxPackets` y playback funcionan normalmente

## Cómo aplicar

En `gsm-codec.ts`, la clase `GsmEncoder`, el spawn de ffmpeg NO debe incluir `-avioflags direct`:

```typescript
// CORRECTO — sin -avioflags direct en el encoder
spawn("ffmpeg", [
  "-hide_banner", "-loglevel", "error",
  "-f", "s16le", "-ar", "8000", "-ac", "1",
  "-i", "pipe:0",
  "-f", "gsm", "-ar", "8000",
  "pipe:1",
])

// INCORRECTO — causa exit 1 silencioso
spawn("ffmpeg", [
  ...
  "-f", "gsm", "-ar", "8000",
  "-avioflags", "direct",  // ← NO
  "pipe:1",
])
```
