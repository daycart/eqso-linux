/**
 * Banco de pruebas multi-cliente para servidores eQSO compatibles con 1.13.
 *
 * No usa micrófono ni altavoces: genera un tono GSM 06.10 con FFmpeg y crea
 * varios clientes TCP independientes. Por seguridad exige EQSO_LAB_LIVE=YES.
 */
import { spawnSync } from "child_process";
import { writeFileSync } from "fs";
import { EqsoClient, type EqsoEvent } from "./eqso-client";

interface LabStats {
  callsign: string;
  connects: number;
  disconnects: number;
  errors: string[];
  joinsSeen: number;
  leavesSeen: number;
  pttStartsSeen: number;
  pttReleasesSeen: number;
  audioPacketsReceived: number;
  audioPacketsSent: number;
  transmissionsCompleted: number;
  ownStartEchoes: number;
  ownReleaseEchoes: number;
}

interface LabPeer {
  callsign: string;
  client: EqsoClient;
  joined: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  stats: LabStats;
}

const host = process.env.EQSO_LAB_HOST ?? "asorapa.sytes.net";
const port = integerEnv("EQSO_LAB_PORT", 2172, 1, 65535);
const room = process.env.EQSO_LAB_ROOM ?? "PRUEBAS";
const password = process.env.EQSO_LAB_PASSWORD ?? "";
const callsigns = (process.env.EQSO_LAB_CALLSIGNS ?? "LAB113-A,LAB113-B,LAB113-C")
  .split(",").map((value) => value.trim()).filter(Boolean);
const durationSeconds = integerEnv("EQSO_LAB_DURATION_SECONDS", 300, 20, 86_400);
const toneSeconds = integerEnv("EQSO_LAB_TONE_SECONDS", 3, 1, 30);
const turnGapSeconds = integerEnv("EQSO_LAB_TURN_GAP_SECONDS", 8, 2, 300);
const reportPath = process.env.EQSO_LAB_REPORT ?? "eqso-lab-report.json";

if (process.env.EQSO_LAB_LIVE !== "YES") {
  fail("Seguridad: define EQSO_LAB_LIVE=YES para autorizar conexiones reales.");
}
if (!password) fail("Falta EQSO_LAB_PASSWORD.");
if (callsigns.length < 2) fail("EQSO_LAB_CALLSIGNS debe contener al menos dos indicativos.");
if (new Set(callsigns).size !== callsigns.length) fail("Los indicativos del laboratorio deben ser únicos.");
if (callsigns.some((name) => !/^[A-Za-z0-9_-]{2,20}$/.test(name))) {
  fail("Los indicativos solo pueden contener letras, números, guion y guion bajo (2-20 caracteres).");
}

const tonePackets = generateTonePackets(toneSeconds);
const peers: LabPeer[] = callsigns.map(createPeer);
const startedAt = new Date();
let stopping = false;
let turnIndex = 0;
let turnTimer: ReturnType<typeof setInterval> | null = null;

console.log(`[lab] servidor=${host}:${port} sala=${room} clientes=${callsigns.join(",")}`);
console.log(`[lab] duración=${durationSeconds}s tono=${toneSeconds}s informe=${reportPath}`);
for (const peer of peers) connectPeer(peer);

setTimeout(() => {
  turnTimer = setInterval(runNextTurn, turnGapSeconds * 1000);
  runNextTurn();
}, 4_000);

setTimeout(stopLab, durationSeconds * 1000);
process.on("SIGINT", stopLab);
process.on("SIGTERM", stopLab);

function createPeer(callsign: string): LabPeer {
  const stats: LabStats = {
    callsign, connects: 0, disconnects: 0, errors: [], joinsSeen: 0,
    leavesSeen: 0, pttStartsSeen: 0, pttReleasesSeen: 0,
    audioPacketsReceived: 0, audioPacketsSent: 0,
    transmissionsCompleted: 0,
    ownStartEchoes: 0, ownReleaseEchoes: 0,
  };
  const peer: LabPeer = {
    callsign,
    client: new EqsoClient(host, port, "legacy-v113"),
    joined: false,
    reconnectTimer: null,
    stats,
  };
  peer.client.on("event", (event: EqsoEvent) => handleEvent(peer, event));
  return peer;
}

function connectPeer(peer: LabPeer): void {
  if (stopping) return;
  peer.joined = false;
  console.log(`[lab:${peer.callsign}] conectando`);
  peer.client.connect();
}

function handleEvent(peer: LabPeer, event: EqsoEvent): void {
  if (event.type === "connected") {
    peer.stats.connects++;
    peer.client.sendJoin(peer.callsign, room, "Cliente laboratorio eQSO 1.13", password);
    peer.joined = true;
    return;
  }
  if (event.type === "disconnected") {
    peer.stats.disconnects++;
    peer.joined = false;
    if (!stopping && !peer.reconnectTimer) {
      peer.reconnectTimer = setTimeout(() => {
        peer.reconnectTimer = null;
        connectPeer(peer);
      }, 3_000);
    }
    return;
  }
  if (event.type === "error") {
    peer.stats.errors.push(String(event.data));
    return;
  }
  if (event.type === "audio") peer.stats.audioPacketsReceived++;
  if (event.type === "user_joined") peer.stats.joinsSeen++;
  if (event.type === "user_left") peer.stats.leavesSeen++;
  if (event.type === "ptt_started") {
    peer.stats.pttStartsSeen++;
    if (eventName(event) === peer.callsign) peer.stats.ownStartEchoes++;
  }
  if (event.type === "ptt_released") {
    peer.stats.pttReleasesSeen++;
    if (eventName(event) === peer.callsign) peer.stats.ownReleaseEchoes++;
  }
}

function eventName(event: EqsoEvent): string {
  const data = event.data as { name?: unknown } | undefined;
  return typeof data?.name === "string" ? data.name : "";
}

function runNextTurn(): void {
  if (stopping || peers.length === 0) return;
  const peer = peers[turnIndex++ % peers.length];
  if (!peer.joined || !peer.client.connected) {
    console.log(`[lab:${peer.callsign}] turno omitido: no conectado`);
    return;
  }
  console.log(`[lab:${peer.callsign}] inicia tono (${tonePackets.length} paquetes)`);
  peer.client.startTx();
  let packetIndex = 0;
  const packetTimer = setInterval(() => {
    if (stopping || packetIndex >= tonePackets.length) {
      clearInterval(packetTimer);
      if (!stopping) {
        peer.client.endTx();
        peer.stats.transmissionsCompleted++;
      }
      console.log(`[lab:${peer.callsign}] termina tono`);
      return;
    }
    peer.client.sendAudio(tonePackets[packetIndex++]);
    peer.stats.audioPacketsSent++;
  }, 120);
}

function generateTonePackets(seconds: number): Buffer[] {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `sine=frequency=1000:sample_rate=8000:duration=${seconds}`,
    "-c:a", "libgsm", "-f", "gsm", "pipe:1",
  ], { encoding: null, maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) {
    fail(`FFmpeg no pudo generar GSM: ${result.stderr?.toString().trim() || `exit ${result.status}`}`);
  }
  const gsm = Buffer.from(result.stdout);
  const packets: Buffer[] = [];
  for (let offset = 0; offset + 198 <= gsm.length; offset += 198) {
    packets.push(gsm.subarray(offset, offset + 198));
  }
  if (packets.length === 0) fail("FFmpeg no produjo paquetes GSM.");
  return packets;
}

function stopLab(): void {
  if (stopping) return;
  stopping = true;
  if (turnTimer) clearInterval(turnTimer);
  for (const peer of peers) {
    if (peer.reconnectTimer) clearTimeout(peer.reconnectTimer);
    peer.client.disconnect();
  }
  const endedAt = new Date();
  const totalAudioPacketsSent = peers.reduce((sum, peer) => sum + peer.stats.audioPacketsSent, 0);
  const clientResults = peers.map((peer) => {
    const stats = peer.stats;
    const expectedAudioPackets = totalAudioPacketsSent - stats.audioPacketsSent;
    const checks = {
      connectionStable: stats.connects === 1 && stats.disconnects === 0 && stats.errors.length === 0,
      allAudioReceived: stats.audioPacketsReceived === expectedAudioPackets,
      allOwnStartEchoesReceived: stats.ownStartEchoes === stats.transmissionsCompleted,
      allOwnReleaseEchoesReceived: stats.ownReleaseEchoes === stats.transmissionsCompleted,
    };
    return {
      ...stats,
      expectedAudioPackets,
      checks,
      passed: Object.values(checks).every(Boolean),
    };
  });
  const report = {
    server: `${host}:${port}`,
    room,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    elapsedSeconds: Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
    settings: { callsigns, durationSeconds, toneSeconds, turnGapSeconds },
    passed: clientResults.every((client) => client.passed),
    clients: clientResults,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[lab] informe guardado en ${reportPath}`);
  setTimeout(() => process.exit(0), 100);
}

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${name} debe ser un entero entre ${min} y ${max}.`);
  }
  return value;
}

function fail(message: string): never {
  console.error(`[lab] ERROR: ${message}`);
  process.exit(1);
}