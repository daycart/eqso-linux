# eQSO Relay Daemon — Radio Enlace CB ASORAPA

Daemon Node.js que conecta una radio CB física (Super Star 3900) al servidor eQSO de ASORAPA via internet. Corre en una VM Ubuntu bajo VirtualBox en el equipo de EA4IKU.

**Estado verificado: TX ✅ RX ✅ — Mayo 2026**

---

## Hardware

| Componente | Descripción | ID USB |
|---|---|---|
| Radio CB | President Super Star 3900 | — |
| Audio | CM108 (SP3002 USB) | `0d8c:0014` |
| PTT | CH340/CH341 (cable serie USB) | `1a86:55d3` → `/dev/eqso-ptt` |
| Host | VM Ubuntu 22.04 en VirtualBox | — |

### Conexiones
- **CM108**: entrada de micrófono de la radio → salida de altavoz del CM108 (RX). Micro del CM108 ← salida de audio de la radio (TX).
- **CH340**: RTS del cable → PTT de la radio (activa transmisión).

---

## Instalación

```bash
# Servicio systemd
sudo systemctl enable eqso-relay@CB
sudo systemctl start eqso-relay@CB

# Config activa
sudo nano /etc/eqso-relay/CB.json

# Logs en tiempo real
sudo journalctl -u eqso-relay@CB -f
```

---

## Configuración activa (`/etc/eqso-relay/CB.json`)

Esta es la configuración verificada que funciona con TX y RX en Mayo 2026:

```json
{
  "callsign": "0R-IN70WN",
  "room": "CB",
  "server": "193.152.83.229",
  "port": 2172,
  "audio": {
    "captureDevice": "plughw:1,0",
    "playbackDevice": "plughw:1,0",
    "vox": true,
    "voxThresholdRms": 1500,
    "voxHangMs": 5000,
    "inputGain": 0.3,
    "outputGain": 1.0,
    "postRxSuppressMs": 6000
  },
  "ptt": {
    "device": "/dev/eqso-ptt",
    "method": "rts",
    "inverted": false
  }
}
```

### Referencia de parámetros

| Parámetro | Valor activo | Descripción |
|---|---|---|
| `voxThresholdRms` | `1500` | Umbral RMS para detectar voz. Por debajo = silencio. |
| `voxHangMs` | `5000` | Tiempo que el PTT permanece activo tras bajar el nivel (ms). |
| `inputGain` | `0.3` | Ganancia de captura. `1.0` = sin cambio, `<1` atenúa. |
| `outputGain` | `1.0` | Ganancia de reproducción RX. `0` = desactivar altavoz. |
| `postRxSuppressMs` | `6000` | Tiempo de inhibición VOX tras fin de RX (ms). Evita falso VOX por eco del altavoz. |
| `ptt.device` | `/dev/eqso-ptt` | Symlink udev al CH340 (`/dev/ttyACM0`). |
| `ptt.method` | `rts` | Pin RTS del puerto serie controla el PTT de la radio. |

---

## Pipeline de audio

### TX (Radio CB → eQSO)

```
Micro radio CB
    │ (señal analógica)
    ▼
CM108 USB (captura)
    │ PCM S16LE 8kHz mono, --buffer-size=1024
    ▼ arecord -D plughw:1,0 -f S16_LE -r 8000 -c 1 -q --buffer-size=1024
Node.js (decimación + inputGain×tanh)
    │
    ▼ VOX → RMS > 1500 durante 2 chunks consecutivos
GsmEncoder (GSM 06.10, 33 bytes/frame, 6 frames/paquete = 198 bytes/120ms)
    │
    ▼ TCP
Servidor eQSO ASORAPA (193.152.83.229:2172)
```

### RX (eQSO → Radio CB)

```
Servidor eQSO ASORAPA
    │ TCP · paquetes GSM 33 bytes/frame
    ▼
GsmDecoder (ffmpeg: gsm → PCM S16LE 8kHz)
    │
    ▼ Jitter buffer: 4800 muestras = 600ms pre-roll
upsample6() · interpolación lineal ×6 → 48kHz
    │
    ▼ aplay -D plughw:1,0 -f S16_LE -r 48000 -c 1 -q --buffer-size=16384 --period-size=512
CM108 USB (reproducción a 48kHz — tasa nativa en VirtualBox)
    │ (señal analógica)
    ▼
Entrada de micrófono radio CB
    │ PTT serial activado via CH340 RTS
    ▼
Radio CB transmite en canal CB
    │
    ▼
Radio portátil recibe ✅
```

> **Nota crítica**: El CM108 en VirtualBox NO acepta reproducción a 8kHz via ALSA (`plughw`).
> `aplay -r 8000` arranca sin errores pero no produce audio.
> Solución: upsample ×6 en Node.js antes de enviar a aplay, que corre a 48kHz (tasa nativa).

---

## Parámetros internos del código

### `alsa-audio.ts`

| Constante | Valor | Descripción |
|---|---|---|
| `JITTER_PRE_BUFFER_SAMPLES` | `4800` | Muestras a acumular antes de abrir aplay (600ms a 8kHz) |
| `PLAYBACK_RATE` | `48000` | Tasa de aplay (tasa nativa CM108 en VirtualBox) |
| `UPSAMPLE_FACTOR` | `6` | Factor de upsample: 8kHz × 6 = 48kHz |
| arecord `--buffer-size` | `1024` | Buffer pequeño para baja latencia en TX |
| aplay `--buffer-size` | `16384` | Buffer grande para reproducción RX suave |
| aplay `--period-size` | `512` | Periodo de transferencia DMA |
| arecord rate | `8000 Hz` | Tasa nativa de captura (plughw hace conversión si necesario) |
| aplay rate | `48000 Hz` | Tasa nativa CM108 para reproducción |

### `main.ts`

| Constante | Valor | Descripción |
|---|---|---|
| `RX_HANG_MS` | `4000` | Timer de fin de RX: baja PTT 4s después del último paquete GSM |
| `POST_TX_SUPPRESS_MS` | `800` | Supresión post-TX propio: descarta paquetes entrantes 800ms tras endTx() |
| `POST_TX_VOX_SUPPRESS_MS` | `5000` | Supresión VOX tras TX propio: evita falso VOX por squelch/eco CB |

---

## Semi-duplex (CM108 half-duplex)

El CM108 no puede capturar Y reproducir simultáneamente en el mismo dispositivo ALSA.

**Flujo RX (al recibir el primer paquete GSM):**
1. `suspendRecorderForRx()` → SIGTERM a arecord (muere en ~46ms)
2. GSM se acumula en jitter buffer (mientras arecord cierra)
3. Cuando jitter buffer ≥ 4800 muestras (600ms): abrir aplay
4. PCM decodificado → upsample6() → aplay stdin
5. Al terminar RX (`RX_HANG_MS` = 4s sin paquetes): stdin.end() → drain 300ms → SIGTERM aplay
6. Reanudar arecord

**Supresiones VOX post-RX:**
- `postRxSuppressMs = 6000ms`: el VOX no dispara en los 6s posteriores al fin de RX
- Evita que el eco del altavoz CB active el PTT de TX

---

## Udev — symlink PTT

```
# /etc/udev/rules.d/99-eqso-ptt.rules
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="55d3", SYMLINK+="eqso-ptt"
```

Recarga udev: `sudo udevadm control --reload-rules && sudo udevadm trigger`

---

## Actualizar en la VM

```bash
cd /opt/eqso-asorapa
git stash push -m "backup $(date +%Y%m%d)"
git pull origin main
cd artifacts/relay-daemon
pnpm build
sudo systemctl restart eqso-relay@CB
sudo journalctl -u eqso-relay@CB -f
```

---

## Diagnóstico rápido

```bash
# Ver logs en tiempo real
sudo journalctl -u eqso-relay@CB -f

# Verificar dispositivos USB
lsusb | grep -E '0d8c|1a86'

# Test de reproducción (activa PTT manualmente primero)
aplay -D plughw:1,0 -f S16_LE -r 48000 -c 1 /dev/urandom &
sleep 2 && kill %1

# Nivel del mixer CM108
amixer -c 1

# Estado del servicio
sudo systemctl status eqso-relay@CB
```

---

## Historial de fixes

| Fecha | Fix | Efecto |
|---|---|---|
| Mayo 2026 | `alsa-audio.ts` reescrito (772→455 líneas): `aplay` por demanda, sin silencio inyectado | Elimina ruido/distorsión en RX |
| Mayo 2026 | `PLAYBACK_RATE=48000` + `upsample6()` (8kHz→48kHz lineal) | CM108 en VirtualBox no reproduce a 8kHz; upsample resuelve RX silencioso |
| Mayo 2026 | `RX_HANG_MS`: 400→4000ms | PTT serial estable entre paquetes GSM (120ms entre paquetes) |
| Mayo 2026 | `setRxActive()` antes del suppress check | PTT no baja mientras el remoto habla durante ventana de suppress |
| Abril 2026 | `suspendRecorderForRx()` al primer paquete GSM | arecord muere en 46ms, evita falso VOX por eco del altavoz |
