import { IncomingMessage, Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger";
import { roomManager, RemoteConnectionInfo } from "./room-manager";
import { inactivityManager } from "./inactivity-manager";
import {
  buildRoomList,
  buildUserList,
  buildUserJoined,
  buildUserLeft,
  buildPttStarted,
  buildPttReleased,
  buildErrorMessage,
  buildServerInfo,
  AUDIO_PAYLOAD_SIZE,
} from "./protocol";
import { EqsoProxy, ProxyEvent } from "./eqso-proxy";
import { validateSession } from "../lib/auth";
import { pcmToFloat32Normalized } from "./pcm-utils";
import { moderationManager } from "./moderation-manager";
import {
  FfmpegGsmEncoder,
  FfmpegGsmDecoder,
  GSM_FRAME_SAMPLES,
  FRAMES_PER_PACKET,
  GSM_PACKET_BYTES,
} from "./ffmpeg-gsm";

// Binary opcodes for browser ↔ server WebSocket protocol
const WS_AUDIO_LOCAL  = 0x01; // local relay: Uint8 unsigned PCM
const WS_AUDIO_REMOTE = 0x11; // remote RX:   Float32 PCM (decoded from GSM)
const WS_PCM_TX       = 0x05; // remote TX:   Int16 signed PCM (→ encode to GSM)

const PCM_CHUNK_SAMPLES = GSM_FRAME_SAMPLES * FRAMES_PER_PACKET; // 960 samples per GSM packet

const SERVER_VERSION = "eQSO Linux Server v1.0";
const KEEPALIVE_MS = 3_000;

interface WsMessage {
  type:
    | "select_server"
    | "join"
    | "ptt_start"
    | "ptt_end"
    | "ping";
  mode?: "local" | "remote";
  host?: string;
  port?: number;
  name?: string;
  room?: string;
  message?: string;
  password?: string;
  token?: string;
}

function sendJson(ws: WebSocket, obj: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }
}

function sendBin(ws: WebSocket, data: Buffer): void {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(data); } catch { /* ignore */ }
  }
}

function handleLocalMode(
  ws: WebSocket,
  id: string,
  keepaliveTimer: ReturnType<typeof setInterval>
): {
  onMessage: (msg: WsMessage, raw: Buffer | null) => void;
  onClose: () => void;
} {
  // FFmpeg GSM decoder for this client — same reference impl as remote mode.
  // Pre-warmed here so the first audio packet doesn't incur a 500 ms delay.
  const localDecoder = new FfmpegGsmDecoder();
  localDecoder.start();

  // FFmpeg GSM encoder for TX: browser Uint8 PCM → GSM → TCP relay-daemon.
  // Replaces the pure-JS gsm610.ts encoder which had LTP (long-term prediction)
  // bugs that corrupted voice audio, causing the CB radio to receive only noise.
  const localEncoder = new FfmpegGsmEncoder();
  localEncoder.start();

  // When the encoder produces a GSM packet, broadcast it to TCP relay-daemon
  // clients (and relay listeners). The room is looked up at emit time so we
  // always use the current room even if the client switched rooms.
  localEncoder.on("gsm", (gsm: Buffer) => {
    const client = roomManager.getClient(id);
    if (!client?.room) return;
    const gsmPkt = Buffer.allocUnsafe(1 + gsm.length);
    gsmPkt[0] = 0x01;
    gsm.copy(gsmPkt, 1);
    roomManager.broadcastToTcpAndRelays(client.room, gsmPkt, id);
  });

  localDecoder.on("pcm", (pcm: Int16Array) => {
    const float32 = pcmToFloat32Normalized(pcm);
    const payload = Buffer.from(float32.buffer);
    const out = Buffer.allocUnsafe(1 + payload.length);
    out[0] = WS_AUDIO_REMOTE;
    payload.copy(out, 1);
    sendBin(ws, out);
  });

  const clientInfo = {
    id,
    name: `_WS_${id.slice(0, 6)}`,
    room: "",
    message: "",
    protocol: "ws" as const,
    connectedAt: Date.now(),
    txBytes: 0,
    rxBytes: 0,
    pingMs: 0,
    send: (data: Buffer) => {
      clientInfo.txBytes += data.length;

      // GSM audio packet from inactivity manager or TCP relay: [0x01][198 bytes GSM]
      // Feed into the per-connection FFmpeg decoder (same reference impl as remote mode).
      if (data[0] === 0x01 && data.length === 1 + AUDIO_PAYLOAD_SIZE) {
        const gsmBuf = Buffer.from(data.buffer, data.byteOffset + 1, AUDIO_PAYLOAD_SIZE);
        localDecoder.decode(gsmBuf);
        return;
      }

      // eQSO 0x16 single-event packet — any action (user_joined / user_left / ptt_start / ptt_release).
      // The action byte lives at offset 5 (count=1 → bytes [0x16][0x01][0x00][0x00][0x00][action]…).
      // Convert ALL four actions to JSON so handleTextMessage picks them up — same path as remote mode.
      // Sanitize names to printable ASCII 0x20–0x7E to avoid garbled chars from Windows relay packets.
      if (data[0] === 0x16 && data.length > 1 && data[1] === 0x01 && data.length >= 10) {
        const action = data[5];
        if (action === 0x00 || action === 0x01 || action === 0x02 || action === 0x03) {
          const nameLen = data[9];
          if (nameLen > 0 && nameLen <= 32 && 10 + nameLen <= data.length) {
            let name = "";
            for (let i = 10; i < 10 + nameLen; i++) {
              const b = data[i];
              if (b >= 0x20 && b <= 0x7e) name += String.fromCharCode(b);
            }
            name = name.trim();
            if (name) {
              if (action === 0x00) {
                let off = 10 + nameLen;
                let message = "";
                if (off < data.length) {
                  const msgLen = data[off++];
                  if (msgLen > 0 && off + msgLen <= data.length) {
                    message = data.slice(off, off + msgLen).toString("ascii").trim();
                  }
                }
                sendJson(ws, { type: "user_joined", name, message });
              } else if (action === 0x01) {
                sendJson(ws, { type: "user_left", name });
              } else if (action === 0x02) {
                sendJson(ws, { type: "ptt_started", name });
              } else {
                sendJson(ws, { type: "ptt_released_remote", name });
              }
              return;
            }
          }
        }
      }

      sendBin(ws, data);
    },
    close: () => ws.close(),
  };
  roomManager.addClient(clientInfo);

  sendJson(ws, {
    type: "room_list",
    rooms: roomManager.getRooms(),
  });
  sendJson(ws, { type: "server_info", message: SERVER_VERSION + " (Local)" });

  const pingTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.ping();
    sendJson(ws, { type: "keepalive" });
  }, KEEPALIVE_MS);

  // Accumulate Uint8 PCM samples from browser until we have 960 (one GSM packet)
  let localPcmAccum = new Uint8Array(0);

  return {
    onMessage: (msg, rawBin) => {
      if (rawBin && rawBin.length > 0 && rawBin[0] === 0x01) {
        const client = roomManager.getClient(id);
        if (client?.room && !moderationManager.isMuted(client.name)) {
          // 1. Send raw Uint8 PCM to other WS browser clients (they handle it natively)
          roomManager.broadcastBinToLocalWsClients(client.room, rawBin, id);

          // 2. Encode Uint8 PCM → GSM and deliver proper 199-byte packets to TCP clients
          //    and relay listeners.  Without this, TCP clients receive wrong-size packets
          //    and reset the connection (ECONNRESET).
          const newSamples = rawBin.slice(1); // strip 0x01 opcode
          const merged = new Uint8Array(localPcmAccum.length + newSamples.length);
          merged.set(localPcmAccum);
          merged.set(newSamples, localPcmAccum.length);
          localPcmAccum = merged;

          while (localPcmAccum.length >= PCM_CHUNK_SAMPLES) {
            const chunk = localPcmAccum.slice(0, PCM_CHUNK_SAMPLES);
            localPcmAccum = localPcmAccum.slice(PCM_CHUNK_SAMPLES);

            // Uint8 unsigned (0–255) → Int16 signed (-32768..32767)
            const int16 = new Int16Array(PCM_CHUNK_SAMPLES);
            for (let i = 0; i < PCM_CHUNK_SAMPLES; i++) {
              int16[i] = (chunk[i] - 128) << 8;
            }

            // Feed to FFmpeg encoder; GSM packet is broadcast in localEncoder "gsm" event.
            // Using FFmpeg instead of gsm610.ts (pure JS) which had LTP bugs that
            // destroyed voice audio and made the CB radio receive only noise.
            localEncoder.encode(int16);
          }
        }
        return;
      }

      switch (msg.type) {
        case "join": {
          const room = (msg.room ?? "GENERAL").trim().toUpperCase();
          const message = (msg.message ?? "").trim();
          const password = (msg.password ?? "").trim();

          // Resolve callsign from session token or raw name
          let name = (msg.name ?? "").trim().toUpperCase();
          let isRelay = false;
          if (msg.token) {
            const session = validateSession(msg.token);
            if (!session) {
              sendJson(ws, { type: "error", message: "Sesión expirada. Vuelve a iniciar sesión." });
              ws.close();
              return;
            }
            name = session.callsign;
            isRelay = session.isRelay;
          }

          // Apply 0R- prefix for relay users, suffix up to 10 chars
          if (isRelay) {
            const prefix = "0R-";
            const withPrefix = name.startsWith(prefix) ? name : `${prefix}${name}`;
            name = withPrefix.slice(0, 13); // "0R-" (3) + 10 chars max
          }

          const serverPassword = process.env.EQSO_PASSWORD ?? "";
          if (serverPassword && password !== serverPassword) {
            sendJson(ws, { type: "error", message: "Acceso denegado: contraseña incorrecta" });
            logger.warn({ id, name }, "WS client rejected: wrong password");
            ws.close();
            return;
          }

          if (!name || name.length > 20) {
            sendJson(ws, { type: "error", message: "Indicativo inválido (máx 20 chars)" });
            return;
          }
          if (!room || room.length > 20) {
            sendJson(ws, { type: "error", message: "Sala inválida (máx 20 chars)" });
            return;
          }
          // Ban check
          if (moderationManager.isBanned(name)) {
            sendJson(ws, { type: "error", message: "Acceso denegado: indicativo baneado del servidor" });
            logger.warn({ id, name }, "WS client rejected: banned");
            ws.close();
            return;
          }
          if (roomManager.isNameTaken(name, id)) {
            sendJson(ws, { type: "error", message: `Indicativo "${name}" ya está en uso` });
            return;
          }

          const ci = roomManager.getClient(id);
          if (ci) { ci.name = name; ci.message = message; }

          const oldRoom = ci?.room ?? "";
          const oldMembers = oldRoom ? roomManager.getRoomMembers(oldRoom) : [];
          roomManager.joinRoom(id, room);

          if (oldRoom && oldRoom !== room) {
            const leftPkt = buildUserLeft(name);
            for (const m of oldMembers) { if (m.id !== id) m.send(leftPkt); }
          }

          const members = roomManager.getRoomMembers(room);
          const memberData = members.filter((m) => m.id !== id).map((m) => ({ name: m.name, message: m.message }));
          sendJson(ws, { type: "joined", room, name, members: memberData });

          const joinedPkt = buildUserJoined(name, message);
          for (const m of members) { if (m.id !== id) m.send(joinedPkt); }
          logger.info({ id, name, room }, "WS local client joined room");
          break;
        }

        case "ptt_start": {
          const client = roomManager.getClient(id);
          if (client?.room && client.name) {
            if (moderationManager.isMuted(client.name)) {
              sendJson(ws, { type: "ptt_denied", reason: "Silenciado por el administrador" });
              break;
            }
            const locked = roomManager.tryLockRoom(client.room, id);
            if (locked) {
              roomManager.broadcastToRoom(client.room, buildPttStarted(client.name), id);
              inactivityManager.recordActivity(client.room);
              sendJson(ws, { type: "ptt_granted" });
            } else {
              sendJson(ws, { type: "ptt_denied", reason: "Canal ocupado" });
            }
          }
          break;
        }

        case "ptt_end": {
          const client = roomManager.getClient(id);
          if (client?.room && client.name) {
            roomManager.broadcastToRoom(client.room, buildPttReleased(client.name), id);
            roomManager.unlockRoom(client.room, id);
            sendJson(ws, { type: "ptt_released" });
          }
          break;
        }

        case "ping":
          sendJson(ws, { type: "pong" });
          break;
      }
    },

    onClose: () => {
      clearInterval(pingTimer);
      localPcmAccum = new Uint8Array(0);
      localDecoder.stop();
      localEncoder.stop();
      const client = roomManager.getClient(id);
      if (client?.room && client.name) {
        roomManager.broadcastToRoom(client.room, buildUserLeft(client.name), id);
      }
      roomManager.removeClient(id);
    },
  };
}

function handleRemoteMode(
  ws: WebSocket,
  id: string,
  host: string,
  port: number
): {
  onMessage: (msg: WsMessage, raw: Buffer | null) => void;
  onClose: () => void;
} {
  const proxy = new EqsoProxy(host, port);
  let pttGranted = false;
  /** True when PTT was active at the moment the external proxy disconnected.
   *  Cleared on manual ptt_end or when auto-re-grant succeeds on reconnect.
   *  Allows seamless PTT recovery when the external server kicks the proxy mid-TX. */
  let pttWasActiveAtDisconnect = false;
  let pttTailTimer: ReturnType<typeof setTimeout> | null = null;
  let currentName = "";
  let currentRoom = "";
  let currentMessage = "";
  let currentPassword = "";

  // Auto-reconexión: cuando el servidor externo cierra la TCP, reintentamos
  // automáticamente sin cerrar el WS del browser.
  let proxyReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let proxyReconnectAttempts = 0;
  const MAX_PROXY_RECONNECT = 5;

  function scheduleProxyReconnect(): void {
    if (proxyReconnectTimer !== null) return;
    if (proxyReconnectAttempts >= MAX_PROXY_RECONNECT) {
      sendJson(ws, { type: "disconnected", message: "Servidor remoto no disponible tras varios intentos" });
      return;
    }
    proxyReconnectAttempts++;
    // Primer intento: inmediato (0ms) — el servidor puede cortar la TX cada ~10s
    // y queremos re-grant lo más rápido posible para minimizar el silencio.
    // Intentos sucesivos: backoff progresivo por si hay error de red real.
    const delay = proxyReconnectAttempts === 1 ? 0 : Math.min(300 * (proxyReconnectAttempts - 1), 5000);
    logger.info({ host, port, attempt: proxyReconnectAttempts, delay }, "Remote proxy: scheduling reconnect");
    sendJson(ws, { type: "server_info", message: `Reconectando a ${host}:${port}...` });
    proxyReconnectTimer = setTimeout(() => {
      proxyReconnectTimer = null;
      if (ws.readyState === WebSocket.OPEN) proxy.connect();
    }, delay);
  }

  // Register this outgoing connection in the room manager for monitoring
  const remoteConnInfo: RemoteConnectionInfo = {
    id, host, port, name: "", room: "",
    status: "connecting", connectedAt: Date.now(),
    txBytes: 0, rxBytes: 0, remoteMembers: [],
    wsSend: (data: object) => { try { sendJson(ws, data); } catch { /* ignore */ } },
    wsSendBin: (data: Buffer) => { try { sendBin(ws, data); } catch { /* ignore */ } },
  };
  roomManager.addRemoteConn(remoteConnInfo);

  // Local helpers to mutate the member list in place (no Map copy overhead)
  function rmAddMember(name: string, message: string): void {
    if (!remoteConnInfo.remoteMembers.find(m => m.name === name)) {
      remoteConnInfo.remoteMembers.push({ name, message, isTx: false });
    }
  }
  function rmRemoveMember(name: string): void {
    const idx = remoteConnInfo.remoteMembers.findIndex(m => m.name === name);
    if (idx !== -1) remoteConnInfo.remoteMembers.splice(idx, 1);
  }
  function rmSetTx(name: string, isTx: boolean): void {
    const m = remoteConnInfo.remoteMembers.find(m => m.name === name);
    if (m) m.isTx = isTx;
  }

  // PCM accumulation buffer for TX: browser sends Int16 PCM chunks
  let pcmAccum = new Int16Array(0);

  // PTT tail: flush FFmpeg encoder buffer before sending [0x0d] to eQSO.
  // GSM 06.10 encoding has ~120 ms pipeline latency; 300 ms tail ensures
  // the last voice frames make it through before the channel closes.
  const PTT_TAIL_MS = 300;

  // GSM frame rate limiter: eQSO protocol expects 1 frame every 20ms (50 fps).
  // ffmpeg batches 960 PCM samples → 6 GSM frames all at once (one burst per
  // browser AudioWorklet chunk = 120ms). Sending 6×33 bytes in a burst causes
  // Windows eQSO relay clients (e.g. 0R-ASORAPA) to disconnect.
  // Fix: queue frames and drain via setInterval at 20ms so each frame is
  // delivered at the correct protocol rate.
  const GSM_FRAME_INTERVAL_MS = 20;
  const gsmFrameQueue: Buffer[] = [];
  let gsmFrameTimer: ReturnType<typeof setInterval> | null = null;

  function startGsmFrameTimer(): void {
    if (gsmFrameTimer) return;
    gsmFrameTimer = setInterval(() => {
      const frame = gsmFrameQueue.shift();
      if (frame) {
        proxy.sendAudio(frame);
        roomManager.updateRemoteConn(id, {
          txBytes: (roomManager.getRemoteConn(id)?.txBytes ?? 0) + frame.length,
        });
        logger.info({ bytes: frame.length }, "Remote TX: sent GSM packet");
      } else {
        clearInterval(gsmFrameTimer!);
        gsmFrameTimer = null;
      }
    }, GSM_FRAME_INTERVAL_MS);
  }

  function stopGsmFrameTimer(): void {
    if (gsmFrameTimer) { clearInterval(gsmFrameTimer); gsmFrameTimer = null; }
    gsmFrameQueue.length = 0;
  }

  function releasePtt(): void {
    stopGsmFrameTimer();
    pttGranted = false;
    pttWasActiveAtDisconnect = false; // user explicitly released PTT — cancel any pending auto-re-grant
    pcmAccum = new Int16Array(0);
    proxy.sendPttEnd();
    logger.info({ name: currentName }, "Remote TX: PTT end sent to eQSO server");
    // Mirror PTT release to local relay daemon so the CB radio unkeys
    if (currentRoom && currentName) {
      roomManager.broadcastToRoom(currentRoom, buildPttReleased(currentName), id);
    }
  }

  // ── FFmpeg codec instances (pre-warmed at connection time) ──────────────────
  const decoder = new FfmpegGsmDecoder();
  const encoder = new FfmpegGsmEncoder();
  decoder.start();
  encoder.start();

  // When decoder produces a decoded PCM packet, send it to browser
  decoder.on("pcm", (pcm: Int16Array) => {
    const float32 = pcmToFloat32Normalized(pcm);
    const header = Buffer.alloc(1);
    header[0] = WS_AUDIO_REMOTE;
    const payload = Buffer.from(float32.buffer);
    sendBin(ws, Buffer.concat([header, payload]));
  });

  // When encoder produces a GSM packet, queue it for rate-limited delivery.
  // Do NOT call proxy.sendAudio() directly — that would burst 6 frames at once
  // and disconnect Windows eQSO relay clients (see rate limiter comment above).
  // ALSO mirror the frame to the local TCP relay daemon (same local room name
  // as the remote room) so the CB radio receives audio when the web client TXes.
  encoder.on("gsm", (gsm: Buffer) => {
    if (!pttGranted) return; // discard if PTT released mid-frame
    gsmFrameQueue.push(Buffer.from(gsm));
    startGsmFrameTimer();
    // Mirror to local relay daemon: build [0x01][GSM] and broadcast to TCP clients
    if (currentRoom) {
      const gsmPkt = Buffer.allocUnsafe(1 + gsm.length);
      gsmPkt[0] = 0x01;
      gsm.copy(gsmPkt, 1);
      roomManager.broadcastToTcpAndRelays(currentRoom, gsmPkt, id);
    }
  });

  proxy.on("event", (ev: ProxyEvent) => {
    switch (ev.type) {
      case "connected":
        roomManager.updateRemoteConn(id, { status: "connected", connectedAt: Date.now() });
        proxyReconnectAttempts = 0;
        sendJson(ws, { type: "server_info", message: `Conectado a ${host}:${port}` });
        // Si reconectamos automáticamente (currentRoom ya establecida), re-unirse a la sala
        if (currentRoom && currentName) {
          logger.info({ name: currentName, room: currentRoom }, "Remote proxy: auto-rejoining after reconnect");
          proxy.sendJoin(currentName, currentRoom, currentMessage, currentPassword);
        }
        break;
      case "server_info":
        // Informacion del servidor remoto (hello eQSO, nombre del servidor).
        // NO reenviar como "error" — era lo que causaba el texto garbled en el
        // panel rojo del cliente web cuando el servidor Windows eQSO mandaba
        // el paquete 0x0b de bienvenida al conectar en modo remoto.
        sendJson(ws, { type: "server_info", message: String(ev.data) });
        break;
      case "disconnected":
        roomManager.updateRemoteConn(id, { status: "disconnected" });
        remoteConnInfo.remoteMembers = [];
        // Si el TX estaba activo, liberarlo antes de reconectar
        if (pttGranted) {
          if (pttTailTimer) { clearTimeout(pttTailTimer); pttTailTimer = null; }
          stopGsmFrameTimer();
          // Remember PTT was active so we can auto-re-grant after reconnect
          // (user is still holding the button — don't force a re-press).
          pttWasActiveAtDisconnect = true;
          pttGranted = false;
          pcmAccum = new Int16Array(0);
          sendJson(ws, { type: "ptt_released" });
          // Unkey the local relay daemon's CB radio so it doesn't stay keyed
          if (currentRoom && currentName) {
            roomManager.broadcastToRoom(currentRoom, buildPttReleased(currentName), id);
          }
          logger.info({ name: currentName, room: currentRoom }, "Remote TX: PTT released on disconnect — will auto-re-grant on reconnect");
        }
        // Auto-reconexión: si estábamos en una sala, reintentar sin cerrar el WS
        if (currentRoom && currentName) {
          scheduleProxyReconnect();
        } else {
          sendJson(ws, { type: "disconnected", message: "Servidor desconectado" });
        }
        break;
      case "error":
        sendJson(ws, { type: "error", message: `Error de conexión: ${ev.data}` });
        break;
      case "room_list":
        // No reenviar la lista de salas del servidor externo al browser.
        // El browser sólo debe ver las salas locales (ya enviadas al conectar).
        // La lista del servidor externo puede contener entradas binarias/corruptas.
        break;
      case "members":
        sendJson(ws, {
          type: "joined",
          room: currentRoom,
          name: currentName,
          members: ev.data,
        });
        // Auto-re-grant PTT if the user was TX'ing when the proxy dropped.
        // This keeps TX seamless across the ~1.5s reconnect window without
        // requiring the user to release and re-press the PTT button.
        if (pttWasActiveAtDisconnect && currentRoom && currentName) {
          pttWasActiveAtDisconnect = false;
          pttGranted = true;
          pcmAccum = new Int16Array(0);
          proxy.startTransmitting();
          sendJson(ws, { type: "ptt_granted" });
          roomManager.broadcastToRoom(currentRoom, buildPttStarted(currentName), id);
          logger.info({ name: currentName, room: currentRoom }, "Remote TX: PTT auto-re-granted after reconnect");
        }
        break;
      case "user_joined": {
        const joined = ev.data as { name: string; message: string };
        rmAddMember(joined.name, joined.message ?? "");
        sendJson(ws, { type: "user_joined", ...(ev.data as object) });
        break;
      }
      case "user_left": {
        const left = ev.data as { name: string };
        rmRemoveMember(left.name);
        sendJson(ws, { type: "user_left", ...(ev.data as object) });
        break;
      }
      case "ptt_started": {
        const txer = ev.data as { name: string };
        rmSetTx(txer.name, true);
        sendJson(ws, { type: "ptt_started", ...(ev.data as object) });
        // Broadcast to all other proxy clients in the same room so they show the speaker animation
        if (currentRoom) {
          roomManager.broadcastJsonToRemoteRoom(currentRoom, { type: "ptt_started", name: txer.name }, id);
        }
        break;
      }
      case "ptt_released": {
        const txer = ev.data as { name: string };
        rmSetTx(txer.name, false);
        sendJson(ws, { type: "ptt_released_remote", ...(ev.data as object) });
        // Broadcast release to all other proxy clients in the same room
        if (currentRoom) {
          roomManager.broadcastJsonToRemoteRoom(currentRoom, { type: "ptt_released_remote", name: txer.name }, id);
        }
        break;
      }
      case "audio": {
        // Incoming GSM packet from remote eQSO server: [0x01][33 bytes GSM]
        const pkt = ev.data as Buffer;
        if (pkt.length < 1 + AUDIO_PAYLOAD_SIZE) break;
        roomManager.updateRemoteConn(id, {
          rxBytes: (roomManager.getRemoteConn(id)?.rxBytes ?? 0) + pkt.length,
        });
        // Feed 33-byte GSM frame into the streaming decoder
        const gsmBuf = Buffer.from(
          pkt.buffer,
          pkt.byteOffset + 1,
          Math.min(AUDIO_PAYLOAD_SIZE, GSM_PACKET_BYTES)
        );
        decoder.decode(gsmBuf);
        break;
      }
      case "keepalive":
        sendJson(ws, { type: "keepalive" });
        break;
    }
  });

  proxy.connect();

  return {
    onMessage: (msg, rawBin) => {
      // Handle TX audio: browser sends [0x05][Int16 PCM bytes]
      if (rawBin && rawBin.length > 1 && rawBin[0] === WS_PCM_TX) {
        if (!pttGranted) {
          logger.debug({ bytes: rawBin.length }, "Remote TX: dropped audio — pttGranted=false");
          return;
        }
        // Copy payload into a fresh ArrayBuffer (rawBin.slice has unaligned byteOffset)
        const payloadLen = rawBin.length - 1;
        const sampleCount = Math.floor(payloadLen / 2);
        const newSamples = new Int16Array(sampleCount);
        const view = new DataView(rawBin.buffer, rawBin.byteOffset + 1, payloadLen);
        for (let i = 0; i < sampleCount; i++) {
          newSamples[i] = view.getInt16(i * 2, true); // little-endian
        }

        // Log PCM peak to detect silence vs speech (once every ~10 packets)
        if (Math.random() < 0.1) {
          let peak = 0;
          for (let i = 0; i < newSamples.length; i++) {
            const a = Math.abs(newSamples[i]);
            if (a > peak) peak = a;
          }
          logger.info({ samples: newSamples.length, peak }, "Remote TX: PCM from browser");
        }

        // Merge into accumulation buffer
        const merged = new Int16Array(pcmAccum.length + newSamples.length);
        merged.set(pcmAccum);
        merged.set(newSamples, pcmAccum.length);
        pcmAccum = merged;

        // Feed complete 960-sample chunks to the encoder
        while (pcmAccum.length >= PCM_CHUNK_SAMPLES) {
          const chunk = pcmAccum.slice(0, PCM_CHUNK_SAMPLES);
          pcmAccum = pcmAccum.slice(PCM_CHUNK_SAMPLES);
          encoder.encode(chunk);
        }
        return;
      }

      // Ignore old-style [0x01] binary from browser (local PCM, not used in remote mode)
      if (rawBin && rawBin.length > 0 && rawBin[0] === WS_AUDIO_LOCAL) {
        return;
      }

      switch (msg.type) {
        case "join": {
          const room = (msg.room ?? "GENERAL").trim().toUpperCase();
          const message = (msg.message ?? "").trim();
          const password = (msg.password ?? "").trim();

          // Resolve callsign: prefer authenticated session over raw name
          let resolvedName = (msg.name ?? "").trim().toUpperCase();
          let isRelay = false;
          if (msg.token) {
            const session = validateSession(msg.token);
            if (!session) {
              sendJson(ws, { type: "error", message: "Sesión expirada. Vuelve a iniciar sesión." });
              return;
            }
            resolvedName = session.callsign;
            isRelay = session.isRelay;
          }

          // Apply 0R- prefix for relay users, suffix up to 10 chars
          if (isRelay) {
            const prefix = "0R-";
            const withPrefix = resolvedName.startsWith(prefix) ? resolvedName : `${prefix}${resolvedName}`;
            resolvedName = withPrefix.slice(0, 13); // "0R-" (3) + 10 chars max
          }

          currentName = resolvedName;
          currentRoom = room;
          currentMessage = message;
          currentPassword = password;
          proxyReconnectAttempts = 0; // nueva sala: resetear intentos de reconexión
          remoteConnInfo.remoteMembers = []; // reset list when joining a new room
          rmAddMember(resolvedName, message);    // add self to member list
          roomManager.updateRemoteConn(id, { name: resolvedName, room });
          logger.info({ id, name: resolvedName, room, host, port, isRelay }, "Remote proxy: join requested");
          proxy.sendJoin(resolvedName, room, message, password);
          sendJson(ws, { type: "joined", room, name: resolvedName, members: [] });
          logger.info({ id, name: resolvedName, room }, "Remote proxy: sent joined to browser");
          break;
        }
        case "ptt_start":
          // Cancel any pending tail timer from a previous PTT release
          if (pttTailTimer) { clearTimeout(pttTailTimer); pttTailTimer = null; }
          pttGranted = true;
          pcmAccum = new Int16Array(0); // reset accumulator
          rmSetTx(currentName, true);
          // No separate PTT-announce packet in eQSO — the first [0x01][198 GSM] frame
          // announces PTT implicitly. Just stop the silence heartbeat.
          proxy.startTransmitting();
          sendJson(ws, { type: "ptt_granted" });
          logger.info({ name: currentName, room: currentRoom }, "Remote TX: PTT start (first voice frame will open channel)");
          // Mirror PTT start to local relay daemon so the CB radio keys up
          if (currentRoom && currentName) {
            roomManager.broadcastToRoom(currentRoom, buildPttStarted(currentName), id);
          }
          break;
        case "ptt_end":
          rmSetTx(currentName, false);
          // Notify browser immediately so UI updates, then wait for the FFmpeg
          // encoder to flush its remaining frames before releasing the eQSO channel.
          sendJson(ws, { type: "ptt_released" });
          pttTailTimer = setTimeout(() => {
            pttTailTimer = null;
            releasePtt();
          }, PTT_TAIL_MS);
          break;
        case "ping":
          sendJson(ws, { type: "pong" });
          break;
      }
    },

    onClose: () => {
      // Cancelar cualquier reconexión pendiente (el usuario cerró la sesión)
      if (proxyReconnectTimer) { clearTimeout(proxyReconnectTimer); proxyReconnectTimer = null; }
      if (pttTailTimer) { clearTimeout(pttTailTimer); pttTailTimer = null; }
      stopGsmFrameTimer();
      if (pttGranted) proxy.sendPttEnd(); // release channel before disconnecting
      pttGranted = false;
      pcmAccum = new Int16Array(0);
      decoder.stop();
      encoder.stop();
      proxy.disconnect();
      roomManager.removeRemoteConn(id);
    },
  };
}

export function startWsBridge(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    if (!roomManager.isEnabled()) {
      sendJson(ws, { type: "error", message: "Servidor desactivado temporalmente" });
      ws.close();
      return;
    }
    const id = randomUUID();
    logger.info({ id }, "New WS eQSO client");

    let handler: {
      onMessage: (msg: WsMessage, raw: Buffer | null) => void;
      onClose: () => void;
    } | null = null;

    const keepaliveTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(keepaliveTimer);
        return;
      }
      ws.ping();
      sendJson(ws, { type: "keepalive" });
    }, KEEPALIVE_MS);

    sendJson(ws, {
      type: "room_list",
      rooms: roomManager.getRooms(),
    });
    sendJson(ws, { type: "server_info", message: SERVER_VERSION });

    ws.on("message", (raw) => {
      try {
        if (raw instanceof Buffer) {
          const ci = roomManager.getClient(id);
          if (ci) ci.rxBytes += raw.length;
        }
        // Binary frames: local audio (0x01) or remote PCM TX (0x05)
        const isBin = raw instanceof Buffer && raw.length > 0 &&
          (raw[0] === WS_AUDIO_LOCAL || raw[0] === WS_PCM_TX);

        if (isBin) {
          handler?.onMessage({} as WsMessage, raw as Buffer);
          return;
        }

        const msg: WsMessage = JSON.parse(raw.toString());

        if (msg.type === "select_server") {
          handler?.onClose();
          handler = null;

          if (msg.mode === "remote" && msg.host) {
            const port = msg.port ?? 2171;
            logger.info({ id, host: msg.host, port }, "WS client selecting remote server");
            handler = handleRemoteMode(ws, id, msg.host, port);
          } else {
            logger.info({ id }, "WS client selecting local server");
            handler = handleLocalMode(ws, id, keepaliveTimer);
          }
          return;
        }

        if (!handler) {
          handler = handleLocalMode(ws, id, keepaliveTimer);
        }

        handler.onMessage(msg, null);
      } catch (err) {
        logger.warn({ err, id }, "WS message error");
      }
    });

    ws.on("close", () => {
      clearInterval(keepaliveTimer);
      handler?.onClose();
      handler = null;
      logger.info({ id }, "WS client disconnected");
    });

    ws.on("error", (err) => {
      logger.warn({ err, id }, "WS error");
    });
  });

  logger.info("eQSO WebSocket bridge ready on /ws");
  return wss;
}
