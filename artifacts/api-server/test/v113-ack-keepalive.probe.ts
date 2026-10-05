import assert from "node:assert/strict";
import net from "node:net";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import {
  AUDIO_PAYLOAD_SIZE,
  buildPttReleased,
  buildPttStarted,
  EQSO_COMMANDS,
  KEEPALIVE_PACKET,
} from "../src/eqso/protocol";
import { roomManager } from "../src/eqso/room-manager";
import { startTcpServer } from "../src/eqso/tcp-server";
import { logger } from "../src/lib/logger";

// Workspace runs require intact framing. Historical runs remain diagnostic,
// so they can reproduce old interleaving without treating it as correct.
// Runs in a separate process, on an ephemeral loopback port, with no RF devices.
logger.level = "silent";
const HANDSHAKE = Buffer.from([0x0a, 0x78, 0, 0, 0]);
const VOICE = Buffer.concat([
  Buffer.from([EQSO_COMMANDS.VOICE]), Buffer.alloc(AUDIO_PAYLOAD_SIZE),
]);
const sockets = new Set<net.Socket>();

async function waitFor(predicate: () => boolean, label: string, timeout = 4_000) {
  const until = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > until) throw new Error(`Timed out: ${label}`);
    await sleep(5);
  }
}

async function closeSocket(socket: net.Socket) {
  if (socket.destroyed) return;
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  socket.destroy();
  await closed;
}

async function probe(
  port: number,
  name: string,
  secondBlockDelayMs: number | undefined,
  room: string,
) {
  const received: Array<{ data: Buffer; at: number }> = [];
  const socket = net.createConnection({ host: "127.0.0.1", port });
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("data", (data) => {
    received.push({ data: Buffer.from(data), at: performance.now() });
  });
  const bytes = () => Buffer.concat(received.map((part) => part.data));
  const atByte = (offset: number) => {
    let cursor = 0;
    for (const part of received) {
      if (offset >= cursor && offset < cursor + part.data.length) return part.at;
      cursor += part.data.length;
    }
    throw new Error(`No receipt timestamp at offset ${offset}`);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const fields = [name, room, "probe", ""].map((text) => Buffer.from(text, "ascii"));
    socket.write(Buffer.concat([
      HANDSHAKE,
      Buffer.from([EQSO_COMMANDS.JOIN]),
      ...fields.flatMap((field) => [Buffer.from([field.length]), field]),
    ]));
    await waitFor(() => roomManager.getAllClients().some(
      (client) => client.name === name && client.room === room,
    ), `legacy client joins ${room}`);
    await sleep(50);
    received.length = 0;

    // Synchronize to the real keepalive; never modify Date.now, timers or server.
    await waitFor(() => bytes().equals(KEEPALIVE_PACKET), "first real keepalive");
    // The next keepalive is ~400–650 ms away when the first voice block arrives.
    await sleep(2_100);
    received.length = 0;
    socket.write(VOICE);
    await waitFor(() => bytes()[0] === 0x06, "first self-owner opcode");

    const ownerPayload = Buffer.concat([
      Buffer.from([Buffer.byteLength(name)]),
      Buffer.from(name, "ascii"),
      buildPttStarted(name),
    ]);
    const released = buildPttReleased(name);
    if (secondBlockDelayMs !== undefined) {
      // 50 ms is the negative control; 850 ms crosses the keepalive, but stays
      // below the unchanged 1.3 s VOX release timer on both server revisions.
      await sleep(secondBlockDelayMs);
      socket.write(VOICE);
      await waitFor(() => bytes().includes(ownerPayload), "second block completes owner");
      socket.write(Buffer.from([EQSO_COMMANDS.RELEASE_PTT]));
    }
    await waitFor(() => bytes().includes(released), "own release response", 5_000);

    const stream = bytes();
    assert.equal(stream[0], 0x06, "capture starts at the self-owner header");
    const ownerIndex = stream.indexOf(ownerPayload, 1);
    const releaseIndex = stream.indexOf(released);
    const firstReleaseMarker = stream.indexOf(Buffer.from([0x08]), 1);
    assert.ok(firstReleaseMarker > 0 && releaseIndex > firstReleaseMarker);
    // Search only the gap before owner data, not inside any name/update payload.
    const gapEnd = ownerIndex >= 0 ? ownerIndex : firstReleaseMarker;
    const keepaliveIndex = stream.subarray(1, gapEnd).indexOf(KEEPALIVE_PACKET);
    const keepaliveOffset = keepaliveIndex < 0 ? undefined : keepaliveIndex + 1;
    const firstAt = atByte(0);
    return {
      room,
      scenario: secondBlockDelayMs === undefined
        ? "single-block-idle-release"
        : secondBlockDelayMs < 100 ? "two-block-fast-control" : "two-block-across-keepalive",
      voiceBlocksSent: secondBlockDelayMs === undefined ? 1 : 2,
      interleavingDetected: keepaliveOffset !== undefined,
      unexpectedBytesBeforeOwner: ownerIndex < 0 ? null : ownerIndex - 1,
      expectedOwnerNameLength: Buffer.byteLength(name),
      byteAfterOwnerOpcode: stream[1],
      ownerLengthMatches: stream[1] === Buffer.byteLength(name),
      keepaliveAfterOpcodeMs: keepaliveOffset === undefined
        ? null : Math.round(atByte(keepaliveOffset) - firstAt),
      ownerCompleted: ownerIndex >= 0,
      ownerCompletedAfterOpcodeMs: ownerIndex < 0
        ? null : Math.round(atByte(ownerIndex) - firstAt),
      ownerCompletedBeforeRelease: ownerIndex >= 0 &&
        ownerIndex + ownerPayload.length <= firstReleaseMarker,
      releaseReceived: true,
      syntheticSocketStillConnected: !socket.destroyed,
    };
  } finally {
    await closeSocket(socket);
  }
}

const server = startTcpServer(0);
try {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const results = [];
  const requireIntact = process.env.EQSO_ACK_PROBE_EXPECT_INTACT === "1";
  for (const room of requireIntact ? ["PRUEBAS", "CB"] : ["PRUEBAS"]) {
    results.push(await probe(address.port, "KPROBE-CTL", 50, room));
    results.push(await probe(address.port, "KPROBE-TWO", 850, room));
    results.push(await probe(address.port, "KPROBE-ONE", undefined, room));
  }
  // Guard against mistaking a defective setup for an actual protocol finding.
  assert.equal(results[0].interleavingDetected, false);
  assert.equal(results[0].ownerLengthMatches, true);
  assert.equal(results[0].ownerCompletedBeforeRelease, true);
  if (requireIntact) {
    for (const result of results) {
      assert.equal(result.interleavingDetected, false, JSON.stringify(result));
      assert.equal(result.unexpectedBytesBeforeOwner, 0, JSON.stringify(result));
      assert.equal(result.ownerLengthMatches, true);
      assert.equal(result.ownerCompletedBeforeRelease, true);
    }
  }
  console.log(JSON.stringify({
    revision: process.env.EQSO_ACK_PROBE_REVISION,
    requireIntact,
    runtime: "isolated-loopback-TCP",
    serverTimingModified: false,
    vmModified: false,
    windowsClientTested: false,
    windowsResetReproduced: false,
    results,
    scope: "Received byte stream only; not proof of the cause of the Windows reset.",
  }, null, 2));
} finally {
  await Promise.all(Array.from(sockets, closeSocket));
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
