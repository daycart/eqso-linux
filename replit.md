# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **WebSockets**: ws library (eQSO bridge)

## Artifacts

### eQSO Linux Client (`artifacts/eqso-client`)
- React + Vite web app at `/`
- Web client for eQSO radio linking over internet
- Connects to eQSO server via WebSocket at `/ws`
- Push-to-talk (PTT) with Web Audio API (AudioWorklet, 8kHz PCM, ~122ms/chunk)
- Room management and user list

### API Server (`artifacts/api-server`)
- Express 5 HTTP server at `/api`
- **eQSO TCP Server** — listens on port 2171, fully compatible with existing eQSO Windows clients
- **eQSO WebSocket Bridge** — at `/ws`, serves the web client
- Both share the same RoomManager for cross-client audio relay

## eQSO Protocol

The eQSO server implements the binary protocol reverse-engineered from OSQe:
- `0x0a` handshake, `0x1a` join room, `0x01` + 198 bytes audio, `0x0d` PTT release
- `0x16` user list updates, `0x14` room list, `0x0c` keepalive
- TCP Windows clients and WebSocket Linux clients share the same room/audio bus

## TX Audio Pipeline (Browser)

Cadena: `MediaStream → micGain(×8) → WaveShaperNode(tanh soft-clip) → AnalyserNode → AudioWorkletNode(mic-processor)`

- **AudioWorklet** (`public/mic-worklet.js`): procesa bloques de 128 muestras en el hilo de audio (2.67ms@48kHz). **Anti-aliasing**: box-filter FIR (media de `ratio` muestras consecutivas antes de decimar, corte ≈3.5kHz para 48→8kHz). **Carry buffer entre bloques**: 128 mod 6 = 2 muestras sobrantes se propagaban al siguiente bloque. Sin esto, se descartan 2 muestras cada 2.67ms → discontinuidad a 375Hz → artefacto tonal audible ("voz distorsionada"). Con carry buffer, TODAS las muestras se usan y la tasa de salida es exactamente 8000Hz.
- **Warmup**: 0.5s descartado en el worklet (≈188 bloques) para que el hardware del micrófono se estabilice.
- **WaveShaperNode (soft-clipper tanh)**: curva tanh(2x)/tanh(2), oversample="4x". Reemplaza DynamicsCompressor (Chrome aplica make-up gain automático que empujaba la señal >1.0 Float32 → hard clipping severo al convertir a Int16). El tanh limita suavemente sin pumping ni artefactos. Gain ×8 (nivel suficiente para VOX de la radio receptora).
- **Cadena de timing**: PTT start → worklet warmup 500ms → chunks cada 122ms → servidor encode GSM → ASORAPA recibe audio a tiempo real.

## GSM 06.10 Codec

Audio uses GSM 06.10 (libgsm) codec: 198 bytes / 120ms / 8 kHz mono.

**TX Encoder**: `TsGsmEncoder` (`gsm610.ts` + `ffmpeg-gsm.ts`)
- Pure TypeScript, synchronous per-frame encoding using the `GsmEncoder` class.
- Emits `"gsm"` event immediately (no buffering). Critical for real-time TX.
- `FfmpegGsmEncoder` was abandoned: ffmpeg internal pipe requires ~50+ packets before flushing — unusable for real-time audio.

**RX Decoder**: `FfmpegGsmDecoder` (`ffmpeg-gsm.ts`)
- Streaming ffmpeg process (GSM → PCM Int16). Pre-started at connection.
- Peaks 2000–7480 (healthy speech levels). Pure-TS decoder had bugs (silent audio).
- ffmpeg command: `ffmpeg -probesize 32 -f gsm -ar 8000 -i pipe:0 -f s16le -ar 8000 pipe:1`

## PTT Race Condition Fix

`pttPendingRef` + `pendingAudioRef` (max 8 chunks) in `useEqsoClient.ts`:
- Audio chunks arriving before `ptt_granted` are buffered (not dropped).
- On `ptt_granted`: buffered chunks are flushed in order, then normal streaming continues.
- Buffer cleared on `ptt_released`, `ptt_denied`, disconnect, WS `onclose`.

## Production Deployment

- **API server**: Replit — `wss://code-translator-linux.replit.app/ws`
- **Web client**: GitHub Pages — `https://daycart.github.io/eqso-linux-client/`
  - Deployed via GitHub Actions CI/CD on push to `daycart/eqso-linux-client` main branch.
  - Client changes must be pushed via GitHub API (bash, not code_execution).
  - Build requires `PORT` and `BASE_PATH` env vars (handled by CI).

## Relay Management System (Radioenlaces)

Added April 2026. Persistent TCP connections from the server to external eQSO servers, managed independently of browser clients.

### Database schema (relay_connections table)
- id, label, callsign, server, port, local_room, remote_room, password, enabled, created_at

### relay-manager.ts
- Loads all `enabled=true` relays from DB on server startup
- For each relay: creates an `EqsoProxy` instance and connects to the remote eQSO server
- Uses `roomManager.addRoomListener()` to receive audio/PTT events from the local room (no virtual client registered, transparent to TCP Windows clients)
- Inbound (Remote→Local): proxy `audio` event → `roomManager.broadcastToRoom(localRoom, [0x01][GSM])` → TCP clients play natively, WS clients decode via FfmpegGsmDecoder
- Outbound (Local→Remote): 0x16 PTT start packet → proxy.startTransmitting(); [0x01][GSM] → proxy.sendAudio(); 0x16 PTT end → proxy.sendPttEnd()
- PTT safety timeout: auto-releases after 5s of audio inactivity
- Auto-reconnect with exponential backoff (2s, 4s, 8s... up to 30s)
- Admin can start/stop relays via API without server restart

### Admin API routes (/api/admin/relays)
- GET — list all relays + live status (status, remoteUsers, rxPackets, txPackets)
- POST — create relay
- PUT /:id — edit relay
- DELETE /:id — delete relay
- POST /:id/start — enable + connect
- POST /:id/stop — disable + disconnect

### room-manager.ts extension
- `addRoomListener(id, rooms, onData)` — subscribe to all broadcastToRoom calls for given rooms
- `removeRoomListener(id)` — unsubscribe
- Listeners receive `(room, data, senderId)` — senderId is the excludeId from broadcastToRoom

### UI (RelaysPanel.tsx)
- New tab "Radioenlaces" in AdminPanel between Servidores and Monitor
- List: label, callsign, server:port, local/remote rooms, status dot, remoteUsers, rx/tx counters
- Polled every 5s
- Form: add/edit relay with all fields including password

## User Authentication System

Added in April 2026. Only registered users can access the eQSO client.

### Database schema (users table)
- callsign (PK unique, max 20 chars — accepts CB like 30RCI184, amateur EA1ABC, etc.)
- password_hash (scrypt, 64-byte, random 16-byte salt), is_relay, active
- **status**: `pending` | `active` | `inactive` — controls access
- **role**: `admin` | `user` — controls admin panel access
- created_at, last_login

### Auth endpoints (`/api/auth/`)
- `POST /api/auth/register` — creates user with `status='pending'`. If no admin exists, first user becomes admin+active automatically.
- `POST /api/auth/login` — checks status: pending→403, inactive→403, active→token. Returns `{token, callsign, isRelay, role}`.

### Admin endpoints (`/api/admin/`) — require Bearer token + role='admin'
- `GET /api/admin/users` — list all users (no passwords)
- `POST /api/admin/users` — create user (immediately active)
- `PATCH /api/admin/users/:id/status` — approve (active) / deactivate (inactive) / re-activate
- `PATCH /api/admin/users/:id/role` — promote/demote admin
- `PATCH /api/admin/users/:id/password` — reset password
- `DELETE /api/admin/users/:id` — delete user

### Sessions
- UUID tokens (24h TTL), in-memory Map, pruned hourly.
- WS join auth: client sends token → server validates session → applies `0R-` + Maidenhead padding for relay users automatically.

### User types
- `is_relay = false`: normal user, any callsign format (CB, amateur, etc.), no prefix
- `is_relay = true`: relay/enlace, server prepends `0R-` + pads to 6-char Maidenhead format

### Client components
- `LoginPanel.tsx` — login/register tabs. Register shows "pendiente de aprobacion" message.
- `AdminPanel.tsx` — admin-only panel: list/filter by status, approve, activate, deactivate, delete, create, reset password, change role. Alert badge for pending users.
- `home.tsx` — shows admin button in header only if role='admin'. Space key disabled in admin panel.

## Radioenlaces (Relay Manager)

Added April 2026. Server maintains persistent TCP connections to remote eQSO servers (ASORAPA, etc.) independent of any browser session.

### How it works
- `relay-manager.ts` loads enabled `relay_connections` from DB at startup
- For each relay: creates an `EqsoProxy` TCP connection (handshake → sendJoin → keepalive)
- Audio from remote server (ASORAPA): GSM decoded via `FfmpegGsmDecoder` → Float32 → `broadcastBinToLocalWsClients(localRoom)`
- Auto-reconnect with exponential backoff (3s → 60s max)
- Status tracked in memory: connecting/connected/disconnected/stopped, usersInRoom, rxPackets

### DB schema (relay_connections table)
- id, label, callsign, server, port, room, password, message, localRoom, enabled, createdAt
- `callsign`: relay appears as `0R-CALLSIGN` on ASORAPA
- `localRoom`: local room where ASORAPA audio is forwarded (defaults to remote room name)

### Admin API endpoints (`/api/admin/relays`)
- `GET` — list with live status
- `POST` — create relay
- `PUT /:id` — update relay (restarts connection)
- `DELETE /:id` — stop and delete
- `POST /:id/start` — enable and connect
- `POST /:id/stop` — disable and disconnect

### Admin UI
- Pestaña "Radioenlaces" en AdminPanel (entre Servidores y Monitor)
- Lista con indicador verde/rojo, uptime, paquetes RX, usuarios en sala ASORAPA
- Formulario de alta/edicion con todos los campos

## Audio RX Quality Fix (April 2026)

### pcmToFloat32Normalized — eliminada normalización por paquete (pcm-utils.ts)
La versión anterior aplicaba normalización de pico **por paquete** (160 muestras = 20 ms).
Cuando el pico de un paquete caía bajo `MIN_PEAK` (pausa entre fonemas), se aplicaba
`scale=1.0`; el paquete siguiente con voz a 0.5 FS recibía `scale=0.9`. Ese salto a 50 Hz
hacía la voz completamente irreconocible ("no se identifica voz").
Fix: división fija `/32768` sin normalización por paquete + `GainNode.gain` bajado de 2 a 1.5.

### channelBusy safety timeout (useEqsoClient.ts)
Si el servidor remoto no enviaba el paquete de liberación de PTT (p.ej. relay se desconecta
sin enviar 0x03), `channelBusy` quedaba activo indefinidamente bloqueando el PTT del usuario.
Fix: timeout de 60 s que limpia `activeSpeaker`/`channelBusy` automáticamente si
`ptt_released_remote` no llega.

### nextPlayTimeRef stale reference (useAudio.ts)
Referencia a `nextPlayTimeRef` (eliminada en refactor anterior) causaba error TS en build.
Fix: eliminada la línea sobrante en el bloque catch de `doInit()`.

## Known Bugs Fixed (April 2026)

### Remote mode — no users visible + password not checked (1fd4a94)
Two bugs caused remote eQSO mode to silently fall back to local mode:

1. **`FfmpegGsmDecoder` missing import** in `ws-bridge.ts`. When a user selected a remote
   server, `handleRemoteMode()` threw `ReferenceError`, it was swallowed by the message
   handler try/catch, `handler` stayed null, and messages fell into the local-mode path.
   Fix: added `FfmpegGsmDecoder` to the import from `./ffmpeg-gsm`.

2. **JOIN packet dropped before TCP handshake**. `proxy.sendJoin()` was called immediately
   after `proxy.connect()` (which is async). `socketWrite()` checked `this.connected === false`
   and silently discarded the packet. The remote server never received the JOIN, never
   returned a user list, and never validated the password.
   Fix: `EqsoProxy.sendJoin()` now buffers `pendingJoin` if `handshakeDone === false`;
   the `0x0a` handshake handler flushes it immediately after the handshake completes.

3. **`buildErrorMessage` wrong opcode**. Used `0x16` (user-update) so the proxy parsed
   it as a user called `"!Error!"` joining the room. Now uses `0x0b` (server text message),
   which `EqsoProxy` correctly maps to `server_info` → `type: "error"` at the browser.

### Password architecture (clarification)
- `EQSO_PASSWORD` env var on VM: password for the **local TCP server** (ports 2171/8008).
  Controls access for Windows eQSO clients connecting to the local server.
- Remote eQSO server password (e.g. ASORAPA 193.152.83.229:8008): stored in
  `relay_connections.password` in the DB, managed via the admin Radioenlaces panel.
  For web users in remote mode, entered in the ConnectPanel UI and forwarded by
  `EqsoProxy` in the JOIN packet.

## Relay Daemon (artifacts/relay-daemon)

Daemon Node.js que corre en la VM Ubuntu como `eqso-relay@CB.service`. Conecta al api-server local (127.0.0.1:2171) como radioenlace físico con la radio CB via CM108 USB.

### Arquitectura de audio
- **Captura**: `arecord` a 48kHz nativo (plughw:, sin rate-plugin) con `--period-size=960 --buffer-size=48000`
  - buffer=48000 (1s) necesario para absorber xruns del CM108 USB en VirtualBox sin crashes
  - Decimación ×6 en Node.js (FIR box): 48kHz → 8kHz para GSM
  - `captureRingBuf` + `captureTimer` (20ms) suaviza las ráfagas de 500-800ms de VirtualBox
- **Reproducción**: `aplay` PCM S16LE 8kHz (semi-duplex con arecord)
- **Codec**: GSM 06.10, 198 bytes/paquete, 20ms/frame
- **PTT serial**: RTS en /dev/eqso-ptt (symlink → /dev/ttyACM1)

### Semi-duplex RX — Fixes Mayo 2026

**Problema original**: Cuando EA4IKU transmitía, el relay disparaba falso VOX / audio distorsionado porque:
1. `arecord` tardaba 1.6s en morir → captaba audio del altavoz → subía PTT → servidor respondía `[0x08]`
2. `RX_HANG_MS=400ms` era insuficiente → el PTT serial ciclaba entre paquetes GSM (cada ~120ms)
3. `alsa-audio.ts` VM tenía arquitectura incorrecta: `startPlayerPermanent` + inyección de silencio (8000 bytes cada 40ms) llenaba el buffer ALSA antes del audio real → ruido/distorsión total

**Fixes aplicados** (Replit source + VM):
- **`alsa-audio.ts` completamente reemplazado** en la VM vía `curl` desde GitHub raw. Versión limpia de Replit (455 líneas): `aplay` por demanda (solo durante RX), `JITTER_PRE_BUFFER_SAMPLES=4800`, `--buffer-size=16384`, `--period-size=512`, sin inyección de silencio. **Este fue el fix definitivo del RX.**
- **`RX_HANG_MS` →4000ms** (`main.ts`): cubre gaps de jitter de red de hasta 800ms sin cortar el final del audio.
- **`setRxActive()` antes del suppress check** (`main.ts`): el timer RX se resetea con cada paquete entrante aunque el audio se descarte por `postTxSuppressUntil`. Evita que el PTT serial baje mientras el remoto sigue hablando.
- **`suspendRecorderForRx()`** en `setRxActive()` (`main.ts`): al primer paquete GSM entrante, se mata `arecord` inmediatamente (46ms) antes de activar el altavoz.
- **`[0x08]` descartado silenciosamente** (`eqso-client.ts` parser): broadcasts del servidor — no son error, se descartan sin log.

**Resultado verificado**:
- EA4IKU oye el audio TX del relay correctamente ✅
- EA4IKU al transmitir: relay activa PTT serial, reproduce audio limpio en radio CB ✅
- Sin falso VOX, sin ruido, sin distorsión ✅

### VOX y supresión de falsos disparos
- **startupVoxSuppressMs: 4000** — bloquea el VOX los primeros 4s tras iniciar arecord (burst ALSA alto)
- **recorder_restarted event** — cuando arecord crashea y se reinicia, el suppress se resetea 4s para cubrir el nuevo burst de inicialización
- **postRxVoxSuppressUntil** — suprime VOX durante y después de reproducir audio del servidor
- **postTxVoxSuppressUntil** — suprime VOX 2.5s tras TX propio (squelch/carrier residual CB)
- **voxDebounceChunks: 2** — requiere 2 chunks consecutivos sobre umbral para activar PTT

### Config `/etc/eqso-relay/CB.json` (activa en VM)
- `voxThresholdRms: 1500` — umbral VOX (ajustado para PCM2902/Super Star 3900)
- `inputGain: 0.15` — ganancia de captura
- `postRxSuppressMs: 6000` — supresión VOX tras RX (6s de margen anti-feedback)

### CM108 USB VirtualBox — Fix modprobe (Abril 2026)

**Problema**: Al cerrar `aplay` (fin de RX), el driver USB de VirtualBox deja el CM108 en estado corrupto. `arecord` falla con "Unable to install hw params" en bucle infinito (code 1 cada 2s). El delay de 800ms no es suficiente.

**Fix aplicado en alsa-audio.ts**: Método `resetUsbAudio()` que tras cada cierre de `aplay` ejecuta `modprobe -r snd_usb_audio && modprobe snd_usb_audio` (espera ~1.5s) antes de reiniciar `arecord`. Funciona sin sudo porque el servicio corre como root (sin `User=` en el .service).

**Para aplicar en la VM**: Usar el script de parche:
```bash
sudo node /opt/eqso-asorapa/artifacts/relay-daemon/install/vm-patch-usb-reset.mjs
```
O copiar el dist/main.mjs compilado directamente desde Replit (más fiable).

### Despliegue en la VM
```bash
# Ruta raíz del proyecto en la VM: /opt/eqso-asorapa
# Servicio systemd: eqso-relay@CB.service   (¡OJO: NOT eqso-relay.service!)
cd /opt/eqso-asorapa && git pull && sudo systemctl restart eqso-relay@CB.service
sudo journalctl -u eqso-relay@CB -f
```

## VM Infrastructure (Ubuntu 192.168.1.25 / 193.152.83.229)

> **ARQUITECTURA CLAVE — NO OLVIDAR:**
> `193.152.83.229` ES NUESTRO PROPIO SERVIDOR. El router de EA4IKU hace port-forwarding:
> - `193.152.83.229:2172` → VM:2171 (nuestro api-server Node.js, código en este repo)
> - `193.152.83.229:8008` → VM:8008 (Windows eQSO server, software separado)
>
> Todo lo que pase en 193.152.83.229 lo controlamos nosotros. El TOT de TX, las salas,
> los límites de tiempo, los mensajes del servidor — TODO es configurable.
> Los cambios al api-server se despliegan con: `git pull && pnpm run build && sudo systemctl restart eqso`

Servidor físico de producción ASORAPA en red local de EA4IKU.

### Servicios systemd en la VM
| Servicio | Descripción | Comando restart |
|---|---|---|
| `eqso.service` | **API Server** (Node.js, puerto 8080 HTTP + 2171 TCP) | `sudo systemctl restart eqso` |
| `eqso-relay@CB.service` | Relay daemon CB físico (CM108 USB audio) | `sudo systemctl restart eqso-relay@CB` |

### Puertos
- `2171` — TCP eQSO interno (VM localhost)
- `2172` — Port forwarding router externo → VM:2171
- `8008` — Windows eQSO server (requiere contraseña, NO tocar)
- `8080` — HTTP admin API (solo localhost)

### Rutas en la VM
- `/opt/eqso-asorapa/` — raíz del proyecto
- `/opt/eqso-asorapa/artifacts/relay-daemon/` — directorio de trabajo del relay daemon
- `/opt/eqso-asorapa/artifacts/relay-daemon/dist/main.mjs` — binario compilado del relay daemon
- `/etc/eqso-relay/CB.json` — config del relay daemon
- `/dev/eqso-ptt` — symlink udev → /dev/ttyACM0 (cable PTT serial USB, CH340/CH341 idVendor=1a86 idProduct=55d3)
- `/etc/udev/rules.d/99-eqso-ptt.rules` — regla udev que crea el symlink automáticamente

### Flujo de desarrollo con "VM ASORAPA desarrollo"

**IMPORTANTE**: El modo "VM ASORAPA desarrollo" del web client conecta DIRECTAMENTE al api-server de la VM via TCP proxy. El servidor Replit solo hace de puente WebSocket — toda la lógica (salas, PTT, usuarios, audio) corre en la VM. Los cambios de código hechos en Replit NO tienen efecto en este modo hasta que se despliegan en la VM.

Flujo de trabajo:
1. Hacer cambios en Replit (api-server)
2. Hacer git push desde Replit al repositorio
3. En la VM: `git pull` + build + restart
4. Solo entonces los cambios son visibles en "VM ASORAPA desarrollo"

### Fix único de permisos (ejecutar solo una vez)
El proyecto fue creado con root, por lo que dist/ y node_modules/ son de root.
Ejecutar esto UNA SOLA VEZ para ceder propiedad al usuario david:
```bash
sudo chown -R david:david /opt/eqso-asorapa
```
Después de esto, el build ya no necesita sudo.

### Actualizar código en la VM
```bash
cd /opt/eqso-asorapa
git pull
cd artifacts/api-server
pnpm run build
sudo systemctl restart eqso
```

### Solo reiniciar (sin cambios de código)
```bash
sudo systemctl restart eqso
```

### Expulsar indicativo desde la VM (vía SSH)
```bash
TOKEN=$(curl -s -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"callsign":"EA4IKU","password":"PASSWORD"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

curl -X POST http://localhost:8080/api/admin/moderation/kick-callsign \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"callsign":"0R-IN70WN"}'
```

### Watchdog PTT (anti stuck-PTT)
- El api-server tiene un watchdog que fuerza PTT release a los **30 segundos** si un relay no suelta el canal
- Se activa automáticamente sin intervención manual
- Requiere código actualizado en la VM (ver "Actualizar código" arriba)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
