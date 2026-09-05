import net from "net";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger";
import { roomManager, ClientInfo } from "./room-manager";
import { FfmpegGsmDecoder } from "./ffmpeg-gsm";
import { inactivityManager } from "./inactivity-manager";
import { moderationManager } from "./moderation-manager";
import { relayTelemetryStore } from "./relay-telemetry-store";
import {
  EQSO_COMMANDS,
  AUDIO_PAYLOAD_SIZE,
  TELEMETRY_PAYLOAD_SIZE,
  HANDSHAKE_CLIENT,
  HANDSHAKE_SERVER,
  buildServerInfo,
  buildRoomList,
  buildUserList,
  buildUserJoined,
  buildUserLeft,
  buildPttStarted,
  buildPttReleased,
  buildErrorMessage,
  tryParseJoin,
  KEEPALIVE_PACKET,
} from "./protocol";

const SERVER_VERSION = "eQSO Linux Server v1.0";
const LEGACY_AUDIO_PACE_MS = 120;

// One FFmpeg GSM decoder per TCP client (keyed by client UUID)
const tcpDecoders = new Map<string, FfmpegGsmDecoder>();

interface TcpClientState {
  id: string;
  socket: net.Socket;
  buf: Buffer;
  readMultiByte: boolean;
  multiByteCmd: number;
  handshakeDone: boolean;
  /** eQSO desktop v1.13 identifies itself with handshake [0x0a, 0x78, 0, 0, 0].
   *  It requires the original server's PTT owner and self-update responses in
   *  order to transmit again after releasing PTT. */
  legacyV113: boolean;
  /** Number of complete GSM blocks received in the current v1.13 TX.
   *  The original server acknowledges PTT after block 2, never between the
   *  one-byte VOICE opcode and its 198-byte payload. */
  legacyVoiceBlocksInTx: number;
  disconnected: boolean; // guard against double-disconnect (error + close both fire)
  /** Drena inmediatamente los paquetes GSM pendientes en el pace queue.
   *  Llamado desde processSingleByte cuando el cliente envía RELEASE_PTT (0x0d),
   *  así los últimos frames llegan al navegador sin el retardo de 120ms/paquete. */
  flushPaceQueue?: () => void;
  stopLegacyAudioQueue?: () => void;
}

function sendRoomList(state: TcpClientState): void {
  const rooms = roomManager.getRooms();
  const pkt = buildRoomList(rooms);
  safeWrite(state, pkt);
}

function sendServerInfo(state: TcpClientState): void {
  const pkt = buildServerInfo(SERVER_VERSION);
  safeWrite(state, pkt);
}

function sendRoomMembers(state: TcpClientState): void {
  const client = roomManager.getClient(state.id);
  if (!client || !client.room) return;

  const members = roomManager.getRoomMembers(client.room);
  const pkt = buildUserList(members.map((m) => ({ name: m.name, message: m.message })));
  safeWrite(state, pkt);
}

function safeWrite(state: TcpClientState, data: Buffer): void {
  try {
    if (!state.socket.destroyed) {
      state.socket.write(data);
    }
  } catch (err) {
    logger.warn({ err, id: state.id }, "TCP write error");
  }
}

function safeWriteLegacyVoice(state: TcpClientState, data: Buffer): void {
  try {
    if (state.socket.destroyed) return;

    // The original eQSO server writes the one-byte VOICE opcode first and the
    // 198-byte GSM payload in a second operation. v1.13's receive path depends
    // on that pattern even though TCP is formally a byte stream.
    state.socket.write(data.subarray(0, 1), () => {
      if (!state.socket.destroyed) {
        state.socket.write(data.subarray(1));
      }
    });
  } catch (err) {
    logger.warn({ err, id: state.id }, "TCP legacy voice write error");
  }
}

function buildLegacyPttOwnerPayload(name: string): Buffer {
  const nameBuf = Buffer.from(name, "ascii");
  return Buffer.concat([
    Buffer.from([nameBuf.length]),
    nameBuf,
  ]);
}

function handleHandshake(state: TcpClientState, chunk: Buffer): void {
  if (
    chunk.length >= 5 &&
    chunk.slice(0, 5).equals(HANDSHAKE_CLIENT)
  ) {
    safeWrite(state, HANDSHAKE_SERVER);
    state.handshakeDone = true;
    sendServerInfo(state);
    logger.info({ id: state.id }, "eQSO TCP client handshake complete");
  }
}

function processSingleByte(state: TcpClientState, byte: number): void {
  const client = roomManager.getClient(state.id);

  switch (byte) {
    case EQSO_COMMANDS.VOICE:
      if (client?.room && !moderationManager.isMuted(client.name)) {
        // Solo emitir ptt_started en el PRIMER paquete de cada sesión TX.
        // tryLockRoom devuelve true tanto si acaba de bloquear como si ya estaba
        // bloqueado por este cliente, así que usamos isLockedBy para detectar
        // si el lock ya era nuestro antes de esta llamada.
        // Sin esta guarda, ptt_started se emitía cada 120ms (un broadcast por
        // cada paquete GSM), lo que hacía que los clientes eQSO externos
        // (Windows ASORAPA) los recibieran como ráfagas y desconectaran.
        const wasAlreadyOurs = roomManager.isLockedBy(client.room, state.id);
        roomManager.tryLockRoom(client.room, state.id);
        if (!wasAlreadyOurs) {
          const started = buildPttStarted(client.name);
          if (state.legacyV113) {
            // Defer the self-ack until complete GSM blocks have arrived.
            // Replying here interrupts v1.13 between its split VOICE opcode
            // and payload, causing it to transmit only GSM silence.
            state.legacyVoiceBlocksInTx = 0;
          }
          roomManager.broadcastToRoom(client.room, started, state.id);
        }
        inactivityManager.recordActivity(client.room);
      }
      state.readMultiByte = true;
      state.multiByteCmd = EQSO_COMMANDS.VOICE;
      state.buf = Buffer.alloc(0);
      break;

    case EQSO_COMMANDS.IGNORE:
      // [0x02] silence frame — el relay-daemon lo envía como 1 BYTE solo (cada 150ms).
      // Lo reenviamos inmediatamente a todos los demás miembros de la sala.
      // Los relays Windows eQSO usan este byte como indicador "servidor vivo":
      // si no reciben datos en ~10-15s, se desconectan. Con 7 frames/s (150ms)
      // el timer de desconexión Windows nunca se dispara.
      // NOTA: NO entramos en modo multi-byte — consumir los 4 [0x02] siguientes
      // como "payload" retrasaba el broadcast a 750ms y enviaba 4 bytes [0x00]
      // extra que podían corromper el parser de los relays Windows.
      if (client?.room) {
        roomManager.broadcastToRoom(
          client.room,
          Buffer.from([0x02]),
          state.id,
          // Relay daemons emit 0x02 every 150ms. Passing that flood to v1.13
          // keeps it in receive/busy state after releasing PTT. Modern relays
          // still receive it; v1.13 uses the server's proactive 0x0c keepalive.
          (target) => !target.legacyV113
        );
      }
      break;

    case EQSO_COMMANDS.KEEPALIVE:
      // El cliente nos envió [0x0c]: NO hacemos eco de vuelta.
      // El servidor envía [0x0c] PROACTIVO cada 8s (ver setInterval más abajo).
      // Hacer eco de vuelta del [0x0c] del cliente creaba un bucle de ping-pong
      // [0x0c]→[0x0c]→[0x0c] que causaba drops en los relays Windows cada 30-60s.
      break;

    case EQSO_COMMANDS.RELEASE_PTT:
      if (client?.room) {
        // v1.13 repeats 0x0d several times for one button release. The original
        // server emits the release sequence only once per active TX.
        if (!roomManager.isLockedBy(client.room, state.id)) break;
        const rel = buildPttReleased(client.name);
        roomManager.broadcastToRoom(client.room, rel, state.id);
        safeWrite(state, Buffer.from([0x08]));
        if (state.legacyV113) {
          // v1.13 needs the original server's clear-owner marker and its own
          // PTT-released update. Do not send these to 0x82 relay/gateway clients:
          // some Windows gateways interpret [0x06, 0x00] as removal from room.
          safeWrite(
            state,
            Buffer.concat([
              Buffer.from([EQSO_COMMANDS.PTT_RELEASE_2, 0x00]),
              rel,
            ])
          );
        }
        state.legacyVoiceBlocksInTx = 0;
        roomManager.unlockRoom(client.room, state.id);
        // Drena inmediatamente los paquetes GSM que quedaron en el pace queue.
        // Sin esto, los últimos 3-5 paquetes GSM del relay CB se entregan al
        // navegador 360-600ms tarde → suena como eco/cola de la voz.
        // Con flush: los paquetes llegan juntos (<1 tick de Node.js) y el
        // Web Audio del navegador los encola en nextPlayTimeRef sin solapamiento.
        state.flushPaceQueue?.();
      }
      break;

    case EQSO_COMMANDS.HANDSHAKE:
      state.readMultiByte = true;
      state.multiByteCmd = EQSO_COMMANDS.HANDSHAKE;
      state.buf = Buffer.from([byte]);
      break;

    case EQSO_COMMANDS.JOIN:
      state.readMultiByte = true;
      state.multiByteCmd = EQSO_COMMANDS.JOIN;
      state.buf = Buffer.alloc(0);
      break;

    case EQSO_COMMANDS.CLIENT_INFO:
      state.readMultiByte = true;
      state.multiByteCmd = EQSO_COMMANDS.CLIENT_INFO;
      state.buf = Buffer.from([byte]);
      break;

    case EQSO_COMMANDS.TELEMETRY:
      state.readMultiByte = true;
      state.multiByteCmd = EQSO_COMMANDS.TELEMETRY;
      state.buf = Buffer.alloc(0);
      break;

    default:
      break;
  }
}

function processMultiByte(state: TcpClientState, byte: number): void {
  state.buf = Buffer.concat([state.buf, Buffer.from([byte])]);

  switch (state.multiByteCmd) {
    case EQSO_COMMANDS.HANDSHAKE: {
      if (state.buf.length === 5) {
        // Accept any 5-byte handshake starting with 0x0a — different eQSO client
        // versions use different second bytes (0x82 for proxy, 0x78 for Windows client v1.13)
        if (state.buf[0] === EQSO_COMMANDS.HANDSHAKE) {
          state.legacyV113 = state.buf[1] === 0x78;
          const client = roomManager.getClient(state.id);
          if (client) client.legacyV113 = state.legacyV113;
          safeWrite(state, HANDSHAKE_SERVER);
          state.handshakeDone = true;
          logger.info(
            { id: state.id, hex: state.buf.toString("hex"), legacyV113: state.legacyV113 },
            "eQSO TCP handshake complete — sending room list"
          );
          sendRoomList(state);
        } else {
          logger.warn({ id: state.id, hex: state.buf.toString("hex") }, "eQSO TCP bad handshake bytes");
        }
        state.readMultiByte = false;
        state.multiByteCmd = 0;
        state.buf = Buffer.alloc(0);
      }
      break;
    }

    case EQSO_COMMANDS.CLIENT_INFO: {
      if (state.buf.length === 9) {
        state.readMultiByte = false;
        state.multiByteCmd = 0;
        state.buf = Buffer.alloc(0);
      }
      break;
    }

    case EQSO_COMMANDS.JOIN: {
      const parsed = tryParseJoin(state.buf);
      if (parsed) {
        logger.info(
          { id: state.id, name: parsed.name, room: parsed.room, bufLen: state.buf.length },
          "eQSO TCP JOIN parsed"
        );
        handleJoin(state, parsed.name, parsed.room, parsed.message, parsed.password);
        state.readMultiByte = false;
        state.multiByteCmd = 0;
        state.buf = Buffer.alloc(0);
      }
      break;
    }

    case EQSO_COMMANDS.TELEMETRY: {
      if (state.buf.length >= TELEMETRY_PAYLOAD_SIZE) {
        // Layout matches eqso-client.ts sendTelemetry (payload bytes, no opcode):
        //   [0]     voxActive
        //   [1-2]   rmsLevel uint16be
        //   [3-6]   txPackets uint32be
        //   [7-10]  rxPackets uint32be
        //   [11]    pttState
        //   [12-15] uptimeSeconds uint32be
        //   [16-17] voxThresholdRms uint16be
        const voxActive = state.buf[0] !== 0;
        const rmsLevel = state.buf.readUInt16BE(1);
        const txPackets = state.buf.readUInt32BE(3);
        const rxPackets = state.buf.readUInt32BE(7);
        const rawPttState = state.buf[11];
        const pttState: 0 | 1 | 2 = rawPttState === 1 ? 1 : rawPttState === 2 ? 2 : 0;
        const uptimeSeconds = state.buf.readUInt32BE(12);
        const voxThresholdRms = state.buf.readUInt16BE(16);
        const client = roomManager.getClient(state.id);
        if (client?.name) {
          relayTelemetryStore.update(client.name, { voxActive, rmsLevel, txPackets, rxPackets, pttState, uptimeSeconds, voxThresholdRms });
        }
        state.buf = state.buf.slice(TELEMETRY_PAYLOAD_SIZE);
        state.readMultiByte = false;
        state.multiByteCmd = 0;
      }
      break;
    }

    case EQSO_COMMANDS.VOICE: {
      if (state.buf.length >= AUDIO_PAYLOAD_SIZE) {
        const client = roomManager.getClient(state.id);
        if (client?.room && !moderationManager.isMuted(client.name)) {
          const gsmPayload = state.buf.slice(0, AUDIO_PAYLOAD_SIZE);

          // Send [0x01][GSM 198 bytes] to TCP clients and relay listeners
          const gsmPkt = Buffer.concat([Buffer.from([0x01]), gsmPayload]);
          roomManager.broadcastToTcpAndRelays(client.room, gsmPkt, state.id);

          // Feed to per-client FFmpeg decoder; WS broadcast happens in "pcm" event
          tcpDecoders.get(state.id)?.decode(Buffer.from(gsmPayload));

          if (
            state.legacyV113 &&
            roomManager.isLockedBy(client.room, state.id) &&
            state.legacyVoiceBlocksInTx < 2
          ) {
            state.legacyVoiceBlocksInTx += 1;
            if (state.legacyVoiceBlocksInTx === 1) {
              // The original server sends only the 0x06 opcode after block 1.
              safeWrite(state, Buffer.from([EQSO_COMMANDS.PTT_RELEASE_2]));
            } else {
              // After block 2 it completes the owner packet and appends the
              // self PTT update in the same write.
              safeWrite(
                state,
                Buffer.concat([
                  buildLegacyPttOwnerPayload(client.name),
                  buildPttStarted(client.name),
                ])
              );
            }
          }
        }
        state.buf = state.buf.slice(AUDIO_PAYLOAD_SIZE);
        if (state.buf.length === 0) {
          state.readMultiByte = false;
          state.multiByteCmd = 0;
        }
      }
      break;
    }

    default:
      break;
  }
}

function handleJoin(
  state: TcpClientState,
  name: string,
  room: string,
  message: string,
  password: string
): void {
  const existing = roomManager.getClient(state.id);
  const oldRoom = existing?.room ?? "";

  // Ban check
  if (moderationManager.isBanned(name)) {
    safeWrite(state, buildErrorMessage("Acceso denegado: indicativo baneado del servidor"));
    logger.warn({ id: state.id, name }, "TCP client rejected: banned");
    state.socket.destroy();
    return;
  }

  const isRelayCallsign = name.startsWith("0R-");
  const relayTokensRaw = process.env.RELAY_TOKENS ?? "";
  const validRelayTokens = relayTokensRaw
    ? relayTokensRaw.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  if (isRelayCallsign && validRelayTokens.length > 0) {
    if (!validRelayTokens.includes(password)) {
      safeWrite(state, buildErrorMessage("Acceso denegado: token de radioenlace invalido"));
      logger.warn({ id: state.id, name }, "TCP relay rejected: invalid relay token");
      state.socket.destroy();
      return;
    }
    logger.info({ id: state.id, name }, "TCP relay authenticated with relay token");
  } else {
    const serverPassword = process.env.EQSO_PASSWORD ?? "";
    if (serverPassword && password !== serverPassword) {
      safeWrite(state, buildErrorMessage("Acceso denegado: contrasena incorrecta"));
      logger.warn({ id: state.id, name }, "TCP client rejected: wrong password");
      state.socket.destroy();
      return;
    }
  }

  if (!name || name.length > 30) {
    safeWrite(state, buildErrorMessage("Indicativo invalido (max 30 chars)"));
    logger.warn({ id: state.id, name, len: name?.length }, "TCP client rejected: invalid callsign");
    state.socket.destroy();
    return;
  }
  if (!room || room.length > 30) {
    safeWrite(state, buildErrorMessage("Nombre de sala invalido (max 30 chars)"));
    logger.warn({ id: state.id, room }, "TCP client rejected: invalid room");
    state.socket.destroy();
    return;
  }
  if (roomManager.isNameTaken(name, state.id)) {
    safeWrite(state, buildErrorMessage(`Indicativo "${name}" ya en uso`));
    logger.warn({ id: state.id, name }, "TCP client rejected: callsign already in use — destroying socket");
    state.socket.destroy(); // destroy so the anonymous connection does not linger for 2 minutes
    return;
  }

  const client = roomManager.getClient(state.id);
  if (client) {
    client.name = name;
    client.message = message;
    if (isRelayCallsign) client.isRelay = true;
  }

  const oldMembers = oldRoom ? roomManager.getRoomMembers(oldRoom) : [];
  roomManager.joinRoom(state.id, room);

  if (oldRoom && oldRoom !== room) {
    const leftPkt = buildUserLeft(name);
    for (const m of oldMembers) {
      if (m.id !== state.id) m.send(leftPkt);
    }
  }

  const members = roomManager.getRoomMembers(room);
  const memberList = buildUserList(
    members.map((m) => ({ name: m.name, message: m.message }))
  );
  logger.info(
    { id: state.id, name, room, memberCount: members.length, members: members.map(m => m.name), hex: memberList.toString("hex") },
    "eQSO TCP sending user list to joining client"
  );
  safeWrite(state, memberList);

  const joinedPkt = buildUserJoined(name, message);
  for (const m of members) {
    if (m.id !== state.id) {
      logger.info({ to: m.name, joining: name }, "eQSO TCP notifying existing member of new join");
      m.send(joinedPkt);
    }
  }

  logger.info({ id: state.id, name, room, memberCount: members.length }, "TCP client joined room");
}

function handleData(state: TcpClientState, data: Buffer): void {
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if (!state.readMultiByte) {
      processSingleByte(state, byte);
    } else {
      processMultiByte(state, byte);
    }
  }
}

function handleDisconnect(state: TcpClientState): void {
  if (state.disconnected) return; // guard: error event is always followed by close event
  state.disconnected = true;
  state.stopLegacyAudioQueue?.();

  const decoder = tcpDecoders.get(state.id);
  if (decoder) {
    decoder.stop();
    tcpDecoders.delete(state.id);
  }

  const client = roomManager.getClient(state.id);
  if (client?.room) {
    const leftPkt = buildUserLeft(client.name);
    roomManager.broadcastToRoom(client.room, leftPkt, state.id);
    logger.info({ id: state.id, name: client.name, room: client.room }, "TCP eQSO client left room");
  }
  if (client?.name) {
    relayTelemetryStore.remove(client.name);
  }
  roomManager.removeClient(state.id);
  logger.info({ id: state.id }, "TCP eQSO client disconnected");
}

export function startTcpServer(port: number): net.Server {
  const server = net.createServer((socket) => {
    const id = randomUUID();
    // Legacy eQSO clients are sensitive to multiple 199-byte voice messages
    // being coalesced into one TCP read. Send each write immediately instead
    // of letting Nagle combine adjacent GSM packets or control messages.
    socket.setNoDelay(true);
    logger.info({ id, addr: socket.remoteAddress }, "New TCP eQSO connection");

    const state: TcpClientState = {
      id,
      socket,
      buf: Buffer.alloc(0),
      readMultiByte: false,
      multiByteCmd: 0,
      handshakeDone: false,
      legacyV113: false,
      legacyVoiceBlocksInTx: 0,
      disconnected: false,
    };

    if (!roomManager.isEnabled()) {
      socket.write(buildErrorMessage("Servidor desactivado temporalmente"));
      socket.destroy();
      return;
    }

    const legacyAudioQueue: Buffer[] = [];
    let legacyAudioTimer: ReturnType<typeof setTimeout> | null = null;

    const sendNextLegacyVoice = () => {
      const packet = legacyAudioQueue.shift();
      if (!packet || state.disconnected) {
        legacyAudioTimer = null;
        return;
      }

      safeWriteLegacyVoice(state, packet);
      legacyAudioTimer = setTimeout(sendNextLegacyVoice, LEGACY_AUDIO_PACE_MS);
    };

    const queueLegacyVoice = (packet: Buffer) => {
      legacyAudioQueue.push(Buffer.from(packet));
      if (!legacyAudioTimer) sendNextLegacyVoice();
    };

    state.stopLegacyAudioQueue = () => {
      if (legacyAudioTimer) {
        clearTimeout(legacyAudioTimer);
        legacyAudioTimer = null;
      }
      legacyAudioQueue.length = 0;
    };

    const clientInfo: ClientInfo = {
      id,
      name: `_ANON_${id.slice(0, 6)}`,
      room: "",
      message: "",
      protocol: "tcp",
      connectedAt: Date.now(),
      txBytes: 0,
      rxBytes: 0,
      pingMs: 0,
      send: (data: Buffer) => {
        clientInfo.txBytes += data.length;
        if (
          state.legacyV113 &&
          data.length === AUDIO_PAYLOAD_SIZE + 1 &&
          data[0] === EQSO_COMMANDS.VOICE
        ) {
          queueLegacyVoice(data);
        } else {
          safeWrite(state, data);
        }
      },
      close: () => socket.destroy(),
    };

    roomManager.addClient(clientInfo);
    logger.info({ id, addr: socket.remoteAddress }, "eQSO TCP client registered — waiting for handshake");

    // Spawn per-client FFmpeg GSM decoder.  The 500ms startup warmup happens here
    // so the process is ready by the time the client starts transmitting audio.
    const decoder = new FfmpegGsmDecoder();
    tcpDecoders.set(id, decoder);

    // Cola de paquetes PCM con limitador de tasa: un paquete cada AUDIO_PACE_MS.
    // Sin esto, FFmpeg puede emitir varios paquetes en el mismo tick de Node.js
    // (rafaga), el navegador los recibe todos a la vez y el scheduler Web Audio
    // API desborda → solapamiento / "bucle".
    // 120ms = duración exacta de un paquete GSM (960 samples a 8000 Hz).
    // Usar 110ms causaba que el scheduler del navegador se adelantara ~10ms por
    // paquete → en 12 segundos = ~1s de "cola fantasma" que se reproducía como
    // eco de lo ya hablado tras terminar la transmisión.
    const AUDIO_PACE_MS = 120; // igual a la duración real del paquete GSM
    const audioPaceQueue: Buffer[] = [];
    let audioPaceTimer: ReturnType<typeof setTimeout> | null = null;

    const sendNextAudioPkt = () => {
      const pkt = audioPaceQueue.shift();
      if (!pkt) { audioPaceTimer = null; return; }
      const room = roomManager.getClient(id)?.room;
      if (room) roomManager.broadcastBinToLocalWsClients(room, pkt, id);
      audioPaceTimer = setTimeout(sendNextAudioPkt, AUDIO_PACE_MS);
    };

    // Cuando el cliente envía RELEASE_PTT (0x0d), drenamos el pace queue sin
    // esperar los 120ms entre paquetes. Los últimos N paquetes GSM del relay CB
    // llegan en el mismo tick de Node.js; el navegador los encola secuencialmente
    // en su nextPlayTimeRef (sin solapamiento) pero sin el retardo del pace timer.
    // Efecto: el final de la transmisión llega al cliente sin cola de eco.
    state.flushPaceQueue = () => {
      if (audioPaceTimer) { clearTimeout(audioPaceTimer); audioPaceTimer = null; }
      const room = roomManager.getClient(id)?.room;
      if (!room) { audioPaceQueue.length = 0; return; }
      while (audioPaceQueue.length > 0) {
        const pkt = audioPaceQueue.shift()!;
        roomManager.broadcastBinToLocalWsClients(room, pkt, id);
      }
    };

    decoder.on("pcm", (pcm: Int16Array) => {
      const cli = roomManager.getClient(id);
      if (!cli?.room) return;
      const float32 = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        float32[i] = Math.max(-0.45, Math.min(0.45, pcm[i] / 32768.0));
      }
      const wsPkt = Buffer.concat([Buffer.from([0x11]), Buffer.from(float32.buffer)]);
      audioPaceQueue.push(wsPkt);
      if (!audioPaceTimer) sendNextAudioPkt(); // primer paquete sale inmediatamente
    });
    decoder.start();

    // TCP keepalive a nivel kernel: tras 30s de inactividad de aplicacion, el
    // OS envía probes TCP al extremo remoto. Si este responde (connection alive),
    // el kernel resetea el timer y el socket permanece abierto indefinidamente
    // aunque no haya trafico eQSO durante horas (caso habitual en CB con poca
    // actividad). Si el remoto no responde a los probes (maquina apagada, red
    // cortada), el kernel cierra el socket tras ~9 reintentos × 75s ≈ 11 min.
    //
    // IMPORTANTE: socket.setTimeout() mide inactividad a nivel de aplicacion
    // (datos Node.js) — los probes TCP del kernel NO lo resetean. Por eso NO
    // usamos setTimeout: un relay silencioso horas enteras dispararía el timeout
    // aunque la conexion TCP este perfectamente viva gracias al keepalive OS.
    socket.setKeepAlive(true, 30_000);

    // Keepalive proactivo [0x0c] cada 8s: los relays Windows eQSO (JN11BK,
    // IN53SI, ASORAPA) desconectan si no reciben ningún dato durante ~13s.
    // El relay-daemon envía [0x02] cada 150ms pero esos son cliente→servidor;
    // lo que los Windows relays necesitan es datos SERVIDOR→cliente.
    // [0x0c] = keepalive estándar eQSO; lo enviamos cada 8s sin esperar
    // respuesta (el eco del cliente se silencia en el case KEEPALIVE arriba).
    const keepaliveInterval = setInterval(() => {
      if (!state.disconnected) safeWrite(state, KEEPALIVE_PACKET);
    }, 8_000);

    socket.on("data", (data: Buffer) => {
      const ci = roomManager.getClient(id);
      if (ci) ci.rxBytes += data.length;
      handleData(state, data);
    });

    socket.on("close", () => {
      clearInterval(keepaliveInterval);
      handleDisconnect(state);
    });

    socket.on("error", (err) => {
      clearInterval(keepaliveInterval);
      logger.warn({ err, id }, "TCP socket error");
      handleDisconnect(state);
    });
  });

  server.listen(port, "0.0.0.0", () => {
    logger.info({ port }, "eQSO TCP server listening");
  });

  server.on("error", (err) => {
    logger.error({ err }, "eQSO TCP server error");
  });

  return server;
}
