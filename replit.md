# eQSO ASORAPA Linux — Documentación del Proyecto

Puerto completo del sistema eQSO VoIP de radioenlace a Linux, compatible con el cliente Windows eQSO v1.13.
Permite a estaciones CB27 comunicarse por internet a través de salas de voz compartidas.

---

## Contenido

1. [Arquitectura general](#arquitectura-general)
2. [Stack y estructura del monorepo](#stack-y-estructura-del-monorepo)
3. [Puertos y red](#puertos-y-red)
4. [Protocolo TCP eQSO (binario)](#protocolo-tcp-eqso-binario)
5. [Run & Operate (desarrollo)](#run--operate-desarrollo)
6. [Deploy en la VM (asorapa.sytes.net)](#deploy-en-la-vm-asorapasytesnet)
7. [Relay Daemon — nodos de radioenlace](#relay-daemon--nodos-de-radioenlace)
8. [Gotchas y decisiones de arquitectura](#gotchas-y-decisiones-de-arquitectura)
9. [Limitaciones conocidas](#limitaciones-conocidas)
10. [User preferences](#user-preferences)

---

## Arquitectura general

```
 Radio CB ←→ USB soundcard + Serial PTT
      │
      ▼
 Relay Daemon (Node.js, cada nodo)
 artifacts/relay-daemon
      │  TCP :2171
      ▼
┌─────────────────────────────────────────────────────┐
│                  api-server (Node.js)               │
│                                                     │
│  ┌────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │ TCP Server │  │  WS Bridge  │  │  REST API   │  │
│  │:2171/:8008 │  │    /ws      │  │   /api/*    │  │
│  └─────┬──────┘  └──────┬──────┘  └──────┬──────┘  │
│        └────────────────┼─────────────────┘         │
│                         │                           │
│                  ┌──────▼──────┐                    │
│                  │ RoomManager │                    │
│                  │  (en RAM)   │                    │
│                  └─────────────┘                    │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │           EqsoProxy (saliente)              │    │
│  │  Browser WS → GSM encode → TCP eQSO externo│    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
         │ WebSocket /ws
         ▼
  Cliente web React (eqso-client)
  (HTTPS en asorapa.sytes.net)

  Cliente Windows eQSO v1.13
  (TCP :2171 / :8008)
```

**Componentes:**

| Artefacto | Descripción |
|---|---|
| `artifacts/api-server` | Servidor TCP eQSO + API REST + bridge WebSocket |
| `artifacts/eqso-client` | Cliente web React (eQSO ASORAPA) |
| `artifacts/relay-daemon` | Daemon de radioenlace físico (CB + USB soundcard) |

---

## Stack y estructura del monorepo

### Tecnologías

| Componente | Tecnología |
|---|---|
| Monorepo | pnpm workspaces |
| Runtime | Node.js 24, TypeScript 5.9 |
| Framework HTTP | Express 5 |
| WebSocket | `ws` library |
| TCP | Módulo `net` nativo Node.js |
| ORM / DB | Drizzle ORM + PostgreSQL |
| Validación | Zod (`zod/v4`), `drizzle-zod` |
| API Codegen | Orval (desde OpenAPI spec) |
| Build | esbuild (ESM bundle) |
| Codec audio | FFmpeg GSM 06.10 (proceso hijo, streaming) |

### Estructura de carpetas

```
artifacts/
  api-server/          — servidor Node.js (TCP + WS + REST)
  eqso-client/         — web app React + Vite
  relay-daemon/        — daemon de radioenlace físico
  relay-daemon/install/ — scripts e instalador
packages/
  db/                  — schema Drizzle + migraciones
  api-spec/            — contratos OpenAPI
public/                — assets estáticos (mic-worklet.js, etc.)
```

### Variables de entorno requeridas

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | Cadena de conexión PostgreSQL |
| `SESSION_SECRET` | Secreto para sesiones HTTP |
| `EQSO_PASSWORD` | Contraseña para clientes TCP Windows |
| `RELAY_TOKENS` | Tokens de autenticación para relay daemons (comma-separated) |
| `EQSO_TCP_PORT` | Puerto TCP eQSO (default: 2171) |

---

## Puertos y red

### En la VM (asorapa.sytes.net / VirtualBox)

| Puerto externo (router) | Destino interno LAN | Uso |
|---|---|---|
| `asorapa.sytes.net:80` | VM (192.168.1.25):80 | Web cliente HTTP |
| `asorapa.sytes.net:443` | VM (192.168.1.25):443 | Web cliente HTTPS + API REST + WS |
| `asorapa.sytes.net:2172` | VM (192.168.1.25):2171 | TCP eQSO — relay daemons externos y clientes Windows |
| `VM:2171` | — | Puerto TCP eQSO interno (solo LAN / relay local en la VM) |
| `VM:8008` | — | Puerto TCP alternativo ASORAPA-compatible (interno) |
| `VM:8009` | — | HTTP control del relay daemon (localhost only) |

> **Nota de convivencia**: El router NAT expone el puerto **2172** externamente y lo reenvía al puerto **2171** de la VM. El host físico (192.168.1.106) puede convivir usando otros puertos externos sin conflicto.

### Conexiones de los relay daemons

| Ubicación | Conecta a | Puerto externo |
|---|---|---|
| VM (relay local) | `127.0.0.1` | 2171 (interno, sin NAT) |
| Portátil / Raspi / PC externo | `asorapa.sytes.net` | **2172** (NAT → VM:2171) |

---

## Protocolo TCP eQSO (binario)

Protocolo binario propietario obtenido por ingeniería inversa del servidor ASORAPA (`193.152.83.229`).

### Opcodes

| Byte | Nombre | Dirección | Descripción |
|---|---|---|---|
| `0x01` | VOICE | C↔S | Trama de audio GSM (198 bytes de payload = 6 frames × 33 bytes) |
| `0x02` | SILENCE | C→S | Heartbeat de silencio (~150ms). Servidor responde `0x08` si el canal está ocupado |
| `0x06` | PTT_RELEASE_2 | S→C | `[0x06][nameLen][name]` — señal adicional de fin PTT |
| `0x08` | PTT_RELEASE_1 | S→C | 1 byte — fin PTT o canal ocupado |
| `0x09` | PTT_START | C→S | 1 byte — cliente solicita canal |
| `0x0a` | HANDSHAKE | C↔S | 5 bytes. Cliente: `[0x0a][var][0x00 0x00 0x00]`. Servidor: `[0x0a 0xfa 0x00 0x00 0x00]` |
| `0x0b` | SERVER_TEXT | S→C | `[0x0b][len][texto][0x03]` — mensaje de texto del servidor |
| `0x0c` | KEEPALIVE | C↔S | 1 byte — ping/pong, se devuelve tal cual |
| `0x0d` | RELEASE_PTT | C→S | 1 byte — cliente suelta el canal |
| `0x14` | ROOM_LIST | S→C | `[0x14][count][0x00 0x00 0x00][len name]*` |
| `0x15` | CLIENT_INFO | C→S | 9 bytes — información de versión (descartado por el servidor) |
| `0x16` | USER_UPDATE | S→C | Evento de usuarios (ver abajo) |
| `0x1a` | JOIN | C→S | `[0x1a][nickLen][nick][roomLen][room][msgLen][msg][pwdLen][pwd][0x00]` |

### Formato USER_UPDATE (0x16)

**Evento único (count=1):**
```
[0x16][0x01][0x00][0x00][0x00][action][0x00][0x00][0x00][nameLen][name]
  + si action=0x00: [msgLen][msg][0x00]
```

**Lista múltiple (count>1):** múltiples entradas concatenadas con mismo prefijo.

### Secuencia de handshake (orden crítico)

```
C→S: HANDSHAKE [0x0a][var][0x00 0x00 0x00]
S→C: HANDSHAKE [0x0a 0xfa 0x00 0x00 0x00]
S→C: ROOM_LIST
C→S: CLIENT_INFO
C→S: JOIN
S→C: USER_UPDATE (lista de usuarios en sala)
S→C: SERVER_TEXT (mensaje de bienvenida)
```

> El handshake acepta `0x78` (Windows v1.13) y `0x82` (proxy interno).

### Modo relay (prefijo `0R-`)

Los relay daemons se identifican con callsign `0R-CALLSIGN` (formato Maidenhead opcional: `0R-IN70WN`).
El servidor los autentica con un token de `RELAY_TOKENS`. El servidor NO devuelve su propio audio al relay emisor (se excluye del broadcast con `excludeId`).

---

## Run & Operate (desarrollo)

```bash
# Typecheck todos los paquetes
pnpm run typecheck

# Build todos los paquetes
pnpm run build

# Generar hooks React Query y schemas Zod desde OpenAPI
pnpm --filter @workspace/api-spec run codegen

# Push schema DB (solo dev)
pnpm --filter @workspace/db run push

# Arrancar servidor API en local
pnpm --filter @workspace/api-server run dev
```

---

## Deploy en la VM (asorapa.sytes.net)

El servicio `eqso.service` (systemd) sirve los estáticos del cliente React desde
`artifacts/api-server/dist/public`. **nginx NO es el servidor de estáticos** — hace
reverse proxy a Node.js (puerto 8080). Para actualizar el cliente:

```bash
cd /opt/eqso-asorapa
git pull
BASE_PATH=/ pnpm --filter @workspace/eqso-client run build
sudo cp -r artifacts/eqso-client/dist/public/* artifacts/api-server/dist/public/
sudo find artifacts/api-server/dist/public/assets/ -name "*.js" -not -name "index-<NEWHASH>.js" -delete
sudo systemctl restart eqso.service
```

Para actualizar el servidor API + relay daemon:
```bash
cd /opt/eqso-asorapa
git pull
pnpm install
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/relay-daemon run build
sudo systemctl restart eqso.service
sudo systemctl restart eqso-relay@CB
```

**nginx** — evitar caché del navegador en `index.html`:
```nginx
location = /index.html {
    add_header Cache-Control "no-store, no-cache, must-revalidate";
}
```

---

## Relay Daemon — nodos de radioenlace

### Concepto

Cada nodo de radioenlace es una instancia del relay daemon conectada a una radio CB física vía:
- **USB soundcard** (audio): captura voz de la radio → sala eQSO / reproduce sala eQSO → radio
- **Cable serie USB** (PTT): activa RTS/DTR para que la radio emita en RF

El daemon hace VOX automático: detecta audio de la radio y abre el canal sin intervención humana.

### Backends de audio

| Backend | Plataforma | Configuración |
|---|---|---|
| `alsa` (default) | Linux, Raspberry Pi | `captureDevice: "plughw:X,0"` |
| `ffmpeg` | Windows, Linux sin ALSA | `captureDevice: "USB Audio Device"`, `captureFormat: "dshow"`, `playbackFormat: "wasapi"` |

### Instalación en Linux / Raspberry Pi — script automático

Un solo comando instala todo de forma interactiva (pnpm, Node.js, compilación, config y servicio systemd):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/daycart/eqso-linux-client/main/artifacts/relay-daemon/install/install-relay.sh)
```

O si ya tienes el repo clonado:
```bash
bash artifacts/relay-daemon/install/install-relay.sh
```

El script:
1. Instala `ffmpeg`, `git`, `curl` vía apt si faltan
2. Instala `pnpm` y `Node.js LTS` en el home del usuario (sin tocar el sistema)
3. Clona o actualiza el repositorio en `~/eqso-linux-client`
4. Compila el relay daemon
5. Detecta tarjetas de audio USB y puertos serie disponibles
6. Pregunta callsign, sala, servidor, token y dispositivos
7. Crea `/etc/eqso-relay/<SALA>.json` con la configuración
8. Instala y activa el servicio systemd `eqso-relay@<SALA>`

**Instalación manual paso a paso** (si se prefiere):
```bash
git clone https://github.com/daycart/eqso-linux-client
cd eqso-linux-client
curl -fsSL https://get.pnpm.io/install.sh | sh -
source ~/.bashrc
pnpm env use --global lts
pnpm install
pnpm --filter @workspace/relay-daemon run build

# Identificar tarjeta USB: aplay -l  →  "plughw:X,0"
# Identificar puerto serie: ls /dev/ttyACM* /dev/ttyUSB*

sudo apt install ffmpeg
sudo mkdir -p /etc/eqso-relay
sudo cp artifacts/relay-daemon/install/config.example.json /etc/eqso-relay/CB.json
sudo nano /etc/eqso-relay/CB.json

# Instalar servicio systemd (ajustar User= y rutas según el equipo)
sudo nano /etc/systemd/system/eqso-relay@.service
sudo systemctl daemon-reload
sudo systemctl enable --now eqso-relay@CB
sudo journalctl -u eqso-relay@CB -f
```

### Configuración mínima (Linux/Raspi)

```json
{
  "callsign": "0R-CALLSIGN",
  "room": "CB",
  "password": "TOKEN-DEL-ADMIN",
  "server": "asorapa.sytes.net",
  "port": 2172,
  "audio": {
    "captureDevice": "plughw:1,0",
    "playbackDevice": "plughw:1,0",
    "vox": true,
    "voxThresholdRms": 1500,
    "voxHangMs": 800,
    "inputGain": 0.3,
    "outputGain": 1.0,
    "postRxSuppressMs": 2500,
    "postTxSuppressMs": 1000
  },
  "ptt": { "device": "/dev/ttyACM0", "method": "rts", "inverted": false }
}
```

### Instalación en Windows — script automático

PowerShell como **Administrador**, un solo comando:

```powershell
irm https://raw.githubusercontent.com/daycart/eqso-linux/main/artifacts/relay-daemon/install/install-relay.ps1 | iex
```

O clonando el repo primero:
```powershell
git clone https://github.com/daycart/eqso-linux
powershell -ExecutionPolicy Bypass -File eqso-linux\artifacts\relay-daemon\install\install-relay.ps1
```

El script:
1. Instala `git`, `Node.js LTS` y `ffmpeg` via `winget` si no están presentes
2. Instala `pnpm` via npm
3. Clona o actualiza el repositorio en `%USERPROFILE%\eqso-linux`
4. Compila el relay daemon (backend `ffmpeg` para Windows)
5. Lista dispositivos de audio (dshow) y puertos COM disponibles
6. Pregunta callsign, sala, servidor, token y dispositivos
7. Crea `C:\eqso-relay\<SALA>.json` con la configuración
8. Registra una **tarea programada de Windows** que arranca el relay al iniciar sesión y se reinicia automáticamente si falla

Comandos útiles tras la instalación:
```powershell
# Ver logs en tiempo real
Get-Content "C:\eqso-relay\relay-CB.log" -Wait -Tail 20

# Parar / Reiniciar
Stop-ScheduledTask  -TaskName "eQSO Relay CB"
Start-ScheduledTask -TaskName "eQSO Relay CB"

# Desinstalar
Unregister-ScheduledTask -TaskName "eQSO Relay CB" -Confirm:$false
```

### Configuración para Windows

```json
{
  "backend": "ffmpeg",
  "callsign": "0R-CALLSIGN",
  "room": "CB",
  "password": "TOKEN-DEL-ADMIN",
  "server": "asorapa.sytes.net",
  "port": 2172,
  "audio": {
    "captureDevice": "USB Audio Device",
    "playbackDevice": "USB Audio Device",
    "captureFormat": "dshow",
    "playbackFormat": "wasapi",
    "vox": true,
    "voxThresholdRms": 1500,
    "voxHangMs": 800,
    "inputGain": 0.3,
    "outputGain": 1.0,
    "postRxSuppressMs": 2500,
    "postTxSuppressMs": 1000
  },
  "ptt": { "device": "COM3", "method": "rts", "inverted": false }
}
```

> Para listar dispositivos en Windows: `ffmpeg -list_devices true -f dshow -i dummy`

### Referencia completa de parámetros `audio`

| Parámetro | Default | Descripción |
|---|---|---|
| `captureDevice` | `"plughw:1,0"` | Dispositivo de captura ALSA (Linux) o nombre dshow/wasapi (Windows) |
| `playbackDevice` | `"plughw:1,0"` | Dispositivo de reproducción |
| `captureFormat` | _(auto)_ | Solo backend `ffmpeg`: `"dshow"` (Win), `"alsa"`, `"avfoundation"` (Mac) |
| `playbackFormat` | _(auto)_ | Solo backend `ffmpeg`: `"wasapi"` (Win), `"alsa"`, `"coreaudio"` (Mac) |
| `vox` | `true` | Activar VOX automático |
| `voxThresholdRms` | `800` | Umbral RMS para abrir el canal. Ver logs `[nivel] pico RMS=XXX` para calibrar |
| `voxHangMs` | `800` | Cola del VOX: ms con audio bajo umbral antes de soltar PTT |
| `txGateRms` | `50` | Umbral mínimo de RMS para enviar un paquete (filtra silencio de fondo) |
| `inputGain` | `0.5` | Ganancia de captura (0.1–2.0). Subir si el nivel es bajo; bajar si hay distorsión |
| `outputGain` | `1.0` | Ganancia de reproducción hacia la radio |
| `postRxSuppressMs` | `2500` | Bloqueo VOX tras recibir audio de la sala (anti-feedback de altavoz) |
| `postTxSuppressMs` | `1000` | Bloqueo VOX tras fin de TX propio (anti-eco inmediato). Ver nota abajo |

> **Calibrar `voxThresholdRms`**: observar la línea `[nivel] pico RMS=XXX` en los logs durante silencio y durante transmisión. El umbral debe quedar entre ambos valores (ruido de fondo típico: <200; voz CB: >3000).
>
> **`postTxSuppressMs`**: si el relay retransmite solo justo al soltar el PTT (eco de altavoz que retriggeriza el VOX), subir a 2000–3000 ms. Con antena y altavoz bien separados, 500–1000 ms es suficiente.

### Actualizar config existente desde versiones anteriores

Si ya tienes un `/etc/eqso-relay/CB.json` de antes de Julio 2026, añade estos campos en la sección `audio` para aprovechar los nuevos defaults:

```json
"audio": {
  "voxHangMs": 800,
  "postRxSuppressMs": 2500,
  "postTxSuppressMs": 1000
}
```

Los parámetros que no aparezcan en tu JSON toman el valor del default del código.

### Diagnóstico del relay

```bash
# Estado HTTP (localhost) — muestra txPackets, rxPackets, estado conexión, etc.
curl http://127.0.0.1:8009/status | python3 -m json.tool

# PTT manual (prueba sin radio)
curl -X POST http://127.0.0.1:8009/ptt/start
curl -X POST http://127.0.0.1:8009/ptt/stop

# Forzar reconexión al servidor
curl -X POST http://127.0.0.1:8009/reconnect

# Ver nivel RMS en logs (cada 5s) para calibrar voxThresholdRms
# [nivel] pico RMS=XXX (XX.X dBFS)  VOXumbral=800

# Verificar que txPackets sube al hablar (confirma que el encoder GSM funciona)
watch -n2 'curl -s http://127.0.0.1:8009/status | python3 -m json.tool | grep -E "txPackets|rxPackets|state"'
```

---

## Gotchas y decisiones de arquitectura

### Audio

- **PTT Race Condition**: Audio chunks que llegan antes de `ptt_granted` se bufferean y envían, no se descartan.
- **CM108 USB 8kHz Playback en VirtualBox**: El CM108 no acepta 8kHz en ALSA bajo VirtualBox. `AlsaAudio` hace upsample ×6 (8kHz→48kHz) en Node.js antes de enviar a `aplay`. En hardware real (portátil, Raspi) `plughw` hace la conversión automáticamente.
- **VirtualBox USB Audio Cuts (TX)**: El controlador USB 1.1/2.0 de VirtualBox provoca dropouts ~80-100ms en el stream CM108. **Solución**: cambiar a **xHCI (USB 3.0)** en Configuración → USB de la VM. No intentar frame-hold/concealment por software (la amplitud natural de la voz confunde el detector RMS).
- **Relay Daemon `arecord` stability**: `arecord` puede crashear en VirtualBox. El backoff de 2s y el reinicio automático en `alsa-audio.ts` es crítico.
- **Soft-clipping TX**: `WaveShaperNode` con función `tanh` en el cliente web reemplaza `DynamicsCompressor` para evitar hard clipping severo.
- **PCM to Float32 Normalization**: División fija por `/32768` en lugar de normalización per-packet, evita artefactos de distorsión en pausas.
- **Semi-duplex ALSA**: El CM108 USB no soporta captura y reproducción simultánea en el mismo dispositivo ALSA. `AlsaAudio` / `FfmpegAudio` implementan half-duplex: SIGTERM a `arecord` antes de abrir `aplay`, y viceversa.

### Cliente web

- **PTT Serial Context**: `usePTTSerial` debe ser un React Context compartido (`PTTSerialProvider` en `hooks/PTTSerialProvider.tsx`), no un hook independiente. Si `PTTConfigModal` y `home.tsx` llaman `usePTTSerial()` por separado, cada uno obtiene una instancia diferente — el modal abre el puerto y lo cierra al desmontarse, dejando `home.tsx` con `portRef = null`. El provider mantiene una referencia compartida durante toda la vida de la app.
- **AudioWorklet**: El `mic-worklet.js` implementa anti-aliasing y carry buffer para PCM 8kHz suave, evitando discontinuidades de muestra en PTT.

### Servidor

- **RoomManager unificado**: TCP server, WS bridge y Relay Manager comparten el mismo `RoomManager`. El relay emisor se excluye del broadcast (`excludeId`) para que no reciba su propio eco.
- **GSM Codec**: `GsmEncoder` / `GsmDecoder` (ffmpeg) para cliente web. El relay daemon usa los mismos codecs vía procesos ffmpeg hijo.
- **Handshake flexible**: Acepta `0x78` (Windows v1.13) y `0x82` (proxy interno EqsoProxy).
- **EqsoProxy.sendJoin()**: Bufferiza el paquete JOIN hasta que el handshake con el servidor externo esté completo.
- **InactivityManager**: Detecta silencio por sala (timer configurable, default admin panel). Genera audio WAV → GSM y lo emite como transmisor `SERVIDOR` a todos los clientes.

### Backend ffmpeg multiplataforma

- `FfmpegAudio` (`artifacts/relay-daemon/src/ffmpeg-audio.ts`) usa el binario de `ffmpeg-static` (ya dependencia del proyecto), no requiere instalación adicional.
- `resolveFfmpegBin()` en `ffmpeg-audio.ts` inyecta el directorio del binario en `PATH`, pero **solo cuando `backend = "ffmpeg"`** (Windows/macOS). En Linux/alsa NO se inyecta: el pnpm content-store de `ffmpeg-static` puede carecer de `libgsm` aunque el `/usr/bin/ffmpeg` del sistema sí lo tenga. Inyectarlo siempre lo pondría por delante del sistema y rompería el encoder GSM.
- `gsm-codec.ts` usa `spawn("ffmpeg", ...)` literal (no `ffmpeg-static`). En Linux/alsa encuentra el ffmpeg del sistema; en Windows/ffmpeg-audio, el PATH inyectado por `main.ts` apunta a `ffmpeg-static`.
- Si `backend` no se especifica en el JSON → usa `"alsa"` (comportamiento anterior sin cambios).

### VOX timing — retardo entre transmisiones

El retardo TX→TX está controlado por dos parámetros acumulativos:

| Parámetro config | Descripción | Default |
|---|---|---|
| `voxHangMs` | Cola del VOX: tiempo desde que el audio baja del umbral hasta soltar PTT | 800 ms |
| `postTxSuppressMs` | Bloqueo VOX tras fin de TX propio (anti-eco inmediato) | 1000 ms |
| `postRxSuppressMs` | Bloqueo VOX tras recibir audio de la sala (anti-feedback) | 2500 ms |

- Si el relay empieza a "eco-loopearse" (se oye a sí mismo y retransmite), subir `postTxSuppressMs` a 2000–3000 ms.
- `voxHangMs` por debajo de 500 ms da PTT nervioso si la radio tiene squelch lento.

---

## Limitaciones conocidas

| Limitación | Detalle |
|---|---|
| Sesiones en RAM | Las sesiones de usuario se pierden al reiniciar el servidor |
| Audio requiere HTTPS | `getUserMedia` no disponible en HTTP puro (aviso amarillo en el cliente web) |
| Un transmisor por sala | Canal half-duplex; solo una estación puede transmitir simultáneamente |
| Web Serial solo Chromium | El PTT por puerto serie solo funciona en Chrome/Edge |
| GSM sin VAD | No hay detección de actividad de voz; el cliente envía audio siempre que PTT esté activo |

---

## User preferences

- _Populate as you build_

---

## Changelog

### v1.3 — Julio 2026
- **Fix GsmEncoder en Linux**: `ffmpeg-static` del pnpm store carecía de `libgsm`; se inyectaba en PATH delante del sistema → encoder fallaba silenciosamente con exit 8 (`txPackets=0`). Fix: inyección de PATH condicionada a `backend="ffmpeg"` (solo Windows/macOS).
- **`postTxSuppressMs` configurable**: bloqueo VOX tras TX propio, antes hardcodeado a 5000 ms. Ahora campo en `audio` config (default 1000 ms). Reduce el retardo entre transmisiones de ~6 s a ~1-2 s.
- **`voxHangMs` default ajustado**: 1500 ms → 800 ms. Cola de VOX más corta para CB.

### Relay Daemon — Backend multiplataforma (Junio 2026)
- Nuevo `FfmpegAudio` (`ffmpeg-audio.ts`): backend multiplataforma (Windows/Linux/Raspi/macOS)
- Campo `backend: "alsa" | "ffmpeg"` en config (opcional, default "alsa" — sin cambios en VM)
- Campos `captureFormat` / `playbackFormat` para seleccionar formato ffmpeg por plataforma
- Config de ejemplo para Windows (`install/config-windows.example.json`)

### v1.2 — Abril 2026
- **InactivityManager**: detecta silencio por sala y reproduce aviso de audio (WAV→GSM)
  - Timer por sala configurable (1-120 min), emite como transmisor `SERVIDOR`
- **Admin API inactividad**: `GET/PATCH /api/admin/inactivity`, upload WAV, trigger manual
- **Panel admin** — pestaña "Inactividad": toggle, tiempo configurable, subida WAV, prueba por sala

### v1.1 — Abril 2026
- `PATCH /api/admin/users/:id/relay` — cambiar tipo radio-enlace de un usuario
- Botón "Hacer enlace / Quitar enlace" en panel de admin (color naranja para enlaces)

### v1.0 — Abril 2026
- Servidor TCP eQSO compatible con Windows eQSO v1.13 (ingeniería inversa)
- Cliente web React (eQSO ASORAPA)
- Soporte puertos 2171 (estándar) y 8008 (ASORAPA)
- Handshake flexible: `0x78` (Windows v1.13) y `0x82` (proxy interno)
- Sistema autenticación: registro, aprobación admin, roles (user/admin/relay)
- EqsoProxy: conexión a servidores externos con transcoding GSM↔PCM
- Despliegue en VM Ubuntu + systemd + nginx
