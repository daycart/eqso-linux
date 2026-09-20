import assert from "node:assert/strict";
import net from "node:net";
import { after, before, test } from "node:test";
import {
  AUDIO_PAYLOAD_SIZE,
  buildPttReleased,
  buildPttStarted,
  EQSO_COMMANDS,
} from "../src/eqso/protocol";
import { roomManager } from "../src/eqso/room-manager";
import { startTcpServer } from "../src/eqso/tcp-server";

const ROOM = "PTT-REGRESSION";
const LEGACY_HANDSHAKE = Buffer.from([0x0a, 0x78, 0x00, 0x00, 0x00]);
const MODERN_HANDSHAKE = Buffer.from([0x0a, 0x82, 0x00, 0x00, 0x00]);
const RADIO_VOX_RELEASE = Buffer.from([0x03]);
const STANDARD_RELEASE = Buffer.from([EQSO_COMMANDS.RELEASE_PTT]);
const VOICE_BLOCK = Buffer.concat([
  Buffer.from([EQSO_COMMANDS.VOICE]),
  Buffer.alloc(AUDIO_PAYLOAD_SIZE),
]);

let server: net.Server;
let port: number;
const sockets = new Set<net.Socket>();

function buildJoin(name: string): Buffer {
  const fields = [name, ROOM, "test", ""].map((value) =>
    Buffer.from(value, "ascii"),
  );
  return Buffer.concat([
    Buffer.from([EQSO_COMMANDS.JOIN]),
    ...fields.flatMap((field) => [Buffer.from([field.length]), field]),
  ]);
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function connectClient(
  name: string,
  handshake: Buffer,
): Promise<{ socket: net.Socket; received: Buffer[] }> {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  sockets.add(socket);
  const received: Buffer[] = [];
  socket.on("data", (data) => received.push(Buffer.from(data)));
  socket.once("close", () => sockets.delete(socket));

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  socket.write(Buffer.concat([handshake, buildJoin(name)]));
  await waitFor(
    () =>
      roomManager
        .getAllClients()
        .some((client) => client.name === name && client.room === ROOM),
    `${name} to join ${ROOM}`,
  );
  return { socket, received };
}

function clientId(name: string): string {
  const client = roomManager
    .getAllClients()
    .find((candidate) => candidate.name === name);
  assert.ok(client, `Expected ${name} to be registered`);
  return client.id;
}

function hasPacket(chunks: Buffer[], packet: Buffer): boolean {
  return Buffer.concat(chunks).includes(packet);
}

async function closeClient(socket: net.Socket): Promise<void> {
  if (socket.destroyed) return;
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  socket.destroy();
  await closed;
}

before(async () => {
  server = startTcpServer(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
});

after(async () => {
  await Promise.all(Array.from(sockets, closeClient));
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("legacy v1.13 radio VOX releases PTT with standalone 0x03", async () => {
  const observer = await connectClient("OBSERVER-03", MODERN_HANDSHAKE);
  const sender = await connectClient("LEGACY-03", LEGACY_HANDSHAKE);
  observer.received.length = 0;

  sender.socket.write(VOICE_BLOCK);
  const senderId = clientId("LEGACY-03");
  await waitFor(
    () => roomManager.isLockedBy(ROOM, senderId),
    "legacy sender to own PTT",
  );
  await waitFor(
    () => hasPacket(observer.received, buildPttStarted("LEGACY-03")),
    "observer to receive PTT start",
  );

  observer.received.length = 0;
  sender.socket.write(RADIO_VOX_RELEASE);
  await waitFor(
    () => !roomManager.isLockedBy(ROOM, senderId),
    "standalone 0x03 to release legacy PTT",
  );
  await waitFor(
    () => hasPacket(observer.received, buildPttReleased("LEGACY-03")),
    "observer to receive legacy PTT release",
  );

  await closeClient(sender.socket);
  await closeClient(observer.socket);
});

test("legacy v1.13 manual PTT still releases with 0x0d", async () => {
  const observer = await connectClient("OBSERVER-0D", MODERN_HANDSHAKE);
  const sender = await connectClient("LEGACY-0D", LEGACY_HANDSHAKE);
  observer.received.length = 0;

  sender.socket.write(VOICE_BLOCK);
  const senderId = clientId("LEGACY-0D");
  await waitFor(
    () => roomManager.isLockedBy(ROOM, senderId),
    "legacy manual sender to own PTT",
  );

  observer.received.length = 0;
  sender.socket.write(STANDARD_RELEASE);
  await waitFor(
    () => !roomManager.isLockedBy(ROOM, senderId),
    "0x0d to release legacy PTT",
  );
  await waitFor(
    () => hasPacket(observer.received, buildPttReleased("LEGACY-0D")),
    "observer to receive manual PTT release",
  );

  await closeClient(sender.socket);
  await closeClient(observer.socket);
});

test("legacy v1.13 stays connected when its closing command never arrives", async () => {
  const observer = await connectClient("OBSERVER-TIMEOUT", MODERN_HANDSHAKE);
  const sender = await connectClient("LEGACY-TIMEOUT", LEGACY_HANDSHAKE);
  observer.received.length = 0;

  sender.socket.write(VOICE_BLOCK);
  const senderId = clientId("LEGACY-TIMEOUT");
  await waitFor(
    () => roomManager.isLockedBy(ROOM, senderId),
    "legacy sender without trailer to own PTT",
  );

  observer.received.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  assert.equal(roomManager.isLockedBy(ROOM, senderId), true);
  assert.equal(
    hasPacket(observer.received, buildPttReleased("LEGACY-TIMEOUT")),
    false,
  );
  assert.equal(sender.socket.destroyed, false);

  await closeClient(sender.socket);
  await closeClient(observer.socket);
});

test("modern 0x82 client cannot release PTT with standalone 0x03", async () => {
  const observer = await connectClient("OBSERVER-82", MODERN_HANDSHAKE);
  const sender = await connectClient("MODERN-82", MODERN_HANDSHAKE);
  observer.received.length = 0;

  sender.socket.write(VOICE_BLOCK);
  const senderId = clientId("MODERN-82");
  await waitFor(
    () => roomManager.isLockedBy(ROOM, senderId),
    "modern sender to own PTT",
  );

  observer.received.length = 0;
  sender.socket.write(RADIO_VOX_RELEASE);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(roomManager.isLockedBy(ROOM, senderId), true);
  assert.equal(
    hasPacket(observer.received, buildPttReleased("MODERN-82")),
    false,
  );

  sender.socket.write(STANDARD_RELEASE);
  await waitFor(
    () => !roomManager.isLockedBy(ROOM, senderId),
    "0x0d to clean up modern PTT",
  );
  await closeClient(sender.socket);
  await closeClient(observer.socket);
});
