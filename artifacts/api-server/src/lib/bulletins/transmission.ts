import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { getAudioPath, createBulletinTransmission, updateBulletinTransmission, type BulletinTransmission, type StoredBulletin } from "./storage";
import { roomManager } from "../../eqso/room-manager";
import {
  AUDIO_PAYLOAD_SIZE,
  buildPttReleased,
  buildPttStarted,
  buildUserJoined,
  buildUserLeft,
} from "../../eqso/protocol";
import { logger } from "../logger";

const PACKET_INTERVAL_MS = 120;
const REMOTE_CHUNK_SAMPLES = 960;
export const BULLETIN_CALLSIGN = "INFO-SIERRA";

export interface TransmissionResult {
  record: BulletinTransmission;
  rejected: boolean;
}

function runFfmpeg(args: string[], label: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stderr.on("data", () => {});
    process.once("error", reject);
    process.once("close", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`ffmpeg ${label} exit ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

async function convertWavToGsm(filePath: string): Promise<Buffer[]> {
  const raw = await runFfmpeg([
    "-i", filePath, "-ar", "8000", "-ac", "1", "-f", "gsm", "pipe:1",
  ], "GSM");
  const packets: Buffer[] = [];
  for (let offset = 0; offset < raw.length; offset += AUDIO_PAYLOAD_SIZE) {
    const payload = Buffer.alloc(AUDIO_PAYLOAD_SIZE);
    raw.copy(payload, 0, offset, Math.min(offset + AUDIO_PAYLOAD_SIZE, raw.length));
    if (offset + AUDIO_PAYLOAD_SIZE <= raw.length || raw.length % AUDIO_PAYLOAD_SIZE !== 0) {
      packets.push(Buffer.concat([Buffer.from([0x01]), payload]));
    }
  }
  return packets;
}

async function convertWavToWsAudio(filePath: string): Promise<Buffer[]> {
  const raw = await runFfmpeg([
    "-i", filePath, "-ar", "8000", "-ac", "1", "-f", "s16le", "pipe:1",
  ], "PCM");
  const bytesPerChunk = REMOTE_CHUNK_SAMPLES * 2;
  const packets: Buffer[] = [];
  for (let offset = 0; offset + bytesPerChunk <= raw.length; offset += bytesPerChunk) {
    const pcm = new Int16Array(raw.buffer, raw.byteOffset + offset, REMOTE_CHUNK_SAMPLES);
    const float32 = new Float32Array(REMOTE_CHUNK_SAMPLES);
    for (let index = 0; index < REMOTE_CHUNK_SAMPLES; index++) {
      float32[index] = Math.max(-0.85, Math.min(0.85, pcm[index] / 32768));
    }
    packets.push(Buffer.concat([Buffer.from([0x11]), Buffer.from(float32.buffer)]));
  }
  return packets;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function transmitBulletin(
  bulletin: StoredBulletin,
  room: string,
  requestedBy: string | null,
): Promise<TransmissionResult> {
  const requestedAt = new Date().toISOString();
  const attempt: BulletinTransmission = {
    id: randomUUID(),
    bulletinId: bulletin.id,
    bulletinGeneratedAt: bulletin.generatedAt,
    room,
    requestedAt,
    startedAt: null,
    completedAt: null,
    status: "failed",
    error: null,
    packetCount: 0,
    durationMs: 0,
    requestedBy,
  };
  await createBulletinTransmission(attempt);

  const failBeforeTransmission = async (error: unknown): Promise<TransmissionResult> => {
    const message = error instanceof Error ? error.message : "Error al preparar el audio";
    const record = await updateBulletinTransmission(attempt.id, {
      completedAt: new Date().toISOString(),
      status: "failed",
      error: message,
      durationMs: Date.now() - new Date(requestedAt).getTime(),
    });
    logger.error({ err: error, bulletinId: bulletin.id, room }, "Falló la preparación del boletín");
    return { record, rejected: false };
  };

  // Resolve and prepare all audio before touching the room. This keeps a
  // missing file or a failed required GSM conversion from briefly occupying
  // a live room or advertising a virtual sender.
  let audioPath: string;
  let gsmPackets: Buffer[];
  try {
    audioPath = getAudioPath(bulletin);
    gsmPackets = await convertWavToGsm(audioPath);
  } catch (error) {
    return failBeforeTransmission(error);
  }

  let wsPackets: Buffer[] = [];
  try {
    wsPackets = await convertWavToWsAudio(audioPath);
  } catch (error) {
    // WebSocket decoded audio is an optional enhancement; GSM is the
    // required eQSO payload and has already been prepared successfully.
    logger.warn({ err: error, bulletinId: bulletin.id }, "No se pudo preparar el audio WebSocket del boletín");
  }

  const owner = `bulletin-${randomUUID()}`;
  if (!roomManager.tryLockRoom(room, owner)) {
    const completedAt = new Date().toISOString();
    const record = await updateBulletinTransmission(attempt.id, {
      completedAt,
      status: "rejected",
      error: "La sala está ocupada por otra transmisión",
      durationMs: Date.now() - new Date(requestedAt).getTime(),
    });
    return { record, rejected: true };
  }

  let joined = false;
  let pttStarted = false;
  const startedAt = new Date().toISOString();
  const startedClock = Date.now();
  try {
    await updateBulletinTransmission(attempt.id, { startedAt });
    const joinedMessage = "Boletín eQSO Sierra Noroeste";
    joined = true;
    roomManager.broadcastToRoom(room, buildUserJoined(BULLETIN_CALLSIGN, joinedMessage));
    roomManager.broadcastJsonToRemoteRoom(room, {
      type: "user_joined", name: BULLETIN_CALLSIGN, message: joinedMessage,
    });

    pttStarted = true;
    roomManager.broadcastToRoom(room, buildPttStarted(BULLETIN_CALLSIGN));
    roomManager.broadcastJsonToRemoteRoom(room, { type: "ptt_started", name: BULLETIN_CALLSIGN });

    for (let index = 0; index < gsmPackets.length; index++) {
      await wait(PACKET_INTERVAL_MS);
      roomManager.broadcastToTcpAndRelays(room, gsmPackets[index]);
      const wsPacket = wsPackets[index];
      if (wsPacket) {
        roomManager.broadcastBinToLocalWsClients(room, wsPacket);
        roomManager.broadcastBinToRemoteRoom(room, wsPacket);
      }
    }

    const completedAt = new Date().toISOString();
    const record = await updateBulletinTransmission(attempt.id, {
      completedAt,
      status: "completed",
      packetCount: gsmPackets.length,
      durationMs: Date.now() - startedClock,
    });
    logger.info({ bulletinId: bulletin.id, room, packetCount: gsmPackets.length }, "Boletín transmitido");
    return { record, rejected: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error de transmisión";
    const record = await updateBulletinTransmission(attempt.id, {
      completedAt: new Date().toISOString(),
      status: "failed",
      error: message,
      durationMs: Date.now() - startedClock,
    });
    logger.error({ err: error, bulletinId: bulletin.id, room }, "Falló la transmisión del boletín");
    return { record, rejected: false };
  } finally {
    if (pttStarted) {
      roomManager.broadcastToRoom(room, buildPttReleased(BULLETIN_CALLSIGN));
      roomManager.broadcastJsonToRemoteRoom(room, { type: "ptt_released_remote", name: BULLETIN_CALLSIGN });
    }
    if (joined) {
      roomManager.broadcastToRoom(room, buildUserLeft(BULLETIN_CALLSIGN));
      roomManager.broadcastJsonToRemoteRoom(room, { type: "user_left", name: BULLETIN_CALLSIGN });
    }
    roomManager.unlockRoom(room, owner);
  }
}