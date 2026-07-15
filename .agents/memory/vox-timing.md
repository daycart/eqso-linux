---
name: VOX timing retardo TX→TX
description: Dos parámetros controlan el retardo entre transmisiones; uno era hardcoded a 5s y ahora es configurable.
---

## Parámetros que controlan el retardo TX→TX

| Parámetro | Dónde | Default actual | Efecto |
|---|---|---|---|
| `voxHangMs` | config.json `audio` | 800 ms | Tiempo desde que el audio baja del umbral hasta que suelta PTT |
| `postTxSuppressMs` | config.json `audio` | 1000 ms | Bloqueo VOX tras fin de TX propio (anti-eco inmediato) |
| `postRxSuppressMs` | config.json `audio` | 2500 ms | Bloqueo VOX tras recibir audio de la sala (anti-eco RX) |

**Why:** `POST_TX_VOX_SUPPRESS_MS` estaba hardcodeado a 5000 ms en `main.ts`. Junto con voxHangMs=1500ms causaba 2-6 segundos de retardo entre transmisiones consecutivas. Era excesivo para uso CB donde la pausa normal es <2s.

**How to apply:** Si el relay emite eco (se oye a sí mismo y vuelve a transmitir), subir `postTxSuppressMs`. Valores recomendados: 500-1000 ms para enlace punto a punto, 2000-3000 ms si hay mucho eco de altavoz. `voxHangMs` entre 500-1000 ms; valores menores dan PTT nervioso si la radio tiene squelch lento.
