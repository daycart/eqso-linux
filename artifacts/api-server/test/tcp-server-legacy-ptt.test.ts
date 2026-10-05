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
import { logger } from "../src/lib/logger";

const ROOM = "PTT-REGRESSION";
const TRIAL_ROOM = "PRUEBAS";
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

function buildJoin(name: string, room = ROOM): Buffer {
  const fields = [name, room, "test", ""].map((value) =>
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
  room = ROOM,
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

  socket.write(Buffer.concat([handshake, buildJoin(name, room)]));
  await waitFor(
    () =>
      roomManager
        .getAllClients()
        .some((client) => client.name === name && client.room === room),
    `${name} to join ${room}`,
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

test("opt-in PRUEBAS VOX trial releases two TX cycles with separated responses", async () => {
  const previous = process.env.EQSO_V113_VOX_TRIAL;
  process.env.EQSO_V113_VOX_TRIAL = "1";
  let sender: Awaited<ReturnType<typeof connectClient>> | undefined;
  try {
    sender = await connectClient("LEGACY-TRIAL", LEGACY_HANDSHAKE, TRIAL_ROOM);
    const id = clientId("LEGACY-TRIAL");
    const clear = Buffer.from([0x08]);
    const ownerClear = Buffer.from([0x06, 0x00]);
    const update = buildPttReleased("LEGACY-TRIAL");

    for (let cycle = 0; cycle < 2; cycle++) {
      sender.received.length = 0;
      sender.socket.write(Buffer.concat([VOICE_BLOCK, VOICE_BLOCK]));
      await waitFor(
        () => roomManager.isLockedBy(TRIAL_ROOM, id),
        `trial cycle ${cycle + 1} to acquire PTT`,
      );
      await waitFor(
        () => hasPacket(sender!.received, buildPttStarted("LEGACY-TRIAL")),
        `trial cycle ${cycle + 1} start acknowledgement`,
      );
      sender.received.length = 0;
      if (cycle === 0) {
        await new Promise((resolve) => setTimeout(resolve, 650));
        sender.socket.write(VOICE_BLOCK);
        await new Promise((resolve) => setTimeout(resolve, 750));
        assert.equal(roomManager.isLockedBy(TRIAL_ROOM, id), true);
      }
      await waitFor(
        () => !roomManager.isLockedBy(TRIAL_ROOM, id),
        `trial cycle ${cycle + 1} automatic PTT release`,
        2_200,
      );
      await waitFor(
        () => hasPacket(sender!.received, update),
        `trial cycle ${cycle + 1} released update`,
      );
      const marker = sender.received.findIndex((part) => part.equals(clear));
      const owner = sender.received.findIndex((part) => part.equals(ownerClear));
      const released = sender.received.findIndex((part) => part.equals(update));
      assert.ok(marker >= 0 && owner > marker && released > owner);
      assert.equal(sender.socket.destroyed, false);
    }
  } finally {
    if (sender) await closeClient(sender.socket);
    if (previous === undefined) delete process.env.EQSO_V113_VOX_TRIAL;
    else process.env.EQSO_V113_VOX_TRIAL = previous;
  }
});

test("trial self-release waits behind a pending web receive tail without dropping RF voice", async () => {
  const previous = process.env.EQSO_V113_VOX_TRIAL;
  process.env.EQSO_V113_VOX_TRIAL = "1";
  let receiver: Awaited<ReturnType<typeof connectClient>> | undefined;
  let web: Awaited<ReturnType<typeof connectClient>> | undefined;
  try {
    receiver = await connectClient("LEGACY-RX-TRIAL", LEGACY_HANDSHAKE, TRIAL_ROOM);
    web = await connectClient("WEB-RX-TRIAL", MODERN_HANDSHAKE, TRIAL_ROOM);
    receiver.received.length = 0;
    web.socket.write(Buffer.concat(Array(15).fill(VOICE_BLOCK)));
    await waitFor(
      () => roomManager.isLockedBy(TRIAL_ROOM, clientId("WEB-RX-TRIAL")),
      "web client to start receiving",
    );
    web.socket.write(STANDARD_RELEASE);
    await waitFor(
      () => !roomManager.isLockedBy(TRIAL_ROOM, clientId("WEB-RX-TRIAL")),
      "web PTT to end",
    );

    const id = clientId("LEGACY-RX-TRIAL");
    receiver.socket.write(Buffer.concat([VOICE_BLOCK, VOICE_BLOCK]));
    await waitFor(
      () => roomManager.isLockedBy(TRIAL_ROOM, id),
      "RF voice to acquire PTT even with a pending receive tail",
    );
    const remoteReleased = buildPttReleased("WEB-RX-TRIAL");
    const selfReleased = buildPttReleased("LEGACY-RX-TRIAL");
    await waitFor(
      () => hasPacket(receiver!.received, selfReleased),
      "receiver tail followed by its own complete release sequence",
      6_000,
    );
    const output = Buffer.concat(receiver.received);
    const remoteEnd = output.indexOf(remoteReleased) + remoteReleased.length;
    const selfStart = output.indexOf(buildPttStarted("LEGACY-RX-TRIAL"));
    const selfEnd = output.indexOf(selfReleased);
    assert.ok(remoteEnd >= remoteReleased.length);
    assert.ok(selfStart >= remoteEnd, "self PTT ack must wait for receiver tail");
    assert.ok(selfEnd > selfStart, "self release must follow self start");
    assert.equal(roomManager.isLockedBy(TRIAL_ROOM, id), false);
    assert.equal(receiver.socket.destroyed, false);
    assert.equal(hasPacket(web.received, buildPttStarted("LEGACY-RX-TRIAL")), true);
    assert.equal(hasPacket(web.received, selfReleased), true);
  } finally {
    if (receiver) await closeClient(receiver.socket);
    if (web) await closeClient(web.socket);
    if (previous === undefined) delete process.env.EQSO_V113_VOX_TRIAL;
    else process.env.EQSO_V113_VOX_TRIAL = previous;
  }
});

for (const room of [TRIAL_ROOM, "CB"]) {
  test(`${room} single-block trial TX completes its owner ack after RX tail before release`, async () => {
    const previous = process.env.EQSO_V113_VOX_TRIAL;
    process.env.EQSO_V113_VOX_TRIAL = "1";
    let sender: Awaited<ReturnType<typeof connectClient>> | undefined;
    let observer: Awaited<ReturnType<typeof connectClient>> | undefined;
    const name = `SHORT-${room}`;
    const remoteName = `REMOTE-${room}`;
    const owner = Buffer.concat([
      Buffer.from([0x06, Buffer.byteLength(name)]),
      Buffer.from(name, "ascii"),
      buildPttStarted(name),
    ]);
    const released = buildPttReleased(name);
    try {
      sender = await connectClient(name, LEGACY_HANDSHAKE, room);
      observer = await connectClient(remoteName, MODERN_HANDSHAKE, room);
      sender.received.length = 0;
      observer.socket.write(Buffer.concat(Array(15).fill(VOICE_BLOCK)));
      await waitFor(
        () => roomManager.isLockedBy(room, clientId(remoteName)),
        "remote TX to acquire the room",
      );
      observer.socket.write(STANDARD_RELEASE);
      await waitFor(
        () => !roomManager.isLockedBy(room, clientId(remoteName)),
        "remote TX ends with a receiver tail still queued",
      );
      observer.received.length = 0;
      // Reproduce a brief RF return: exactly one complete GSM block.
      sender.socket.write(VOICE_BLOCK);
      await waitFor(
        () => roomManager.isLockedBy(room, clientId(name)),
        "single-block RF TX acquires the room",
      );
      await waitFor(
        () => hasPacket(sender!.received, released),
        "single-block automatic release follows complete self ack",
        6_000,
      );
      const output = Buffer.concat(sender.received);
      const remoteRelease = buildPttReleased(remoteName);
      const remoteEnd = output.indexOf(remoteRelease);
      const ownerStart = output.indexOf(owner);
      const selfEnd = output.indexOf(released);
      assert.ok(remoteEnd >= 0);
      assert.ok(ownerStart >= remoteEnd + remoteRelease.length,
        "complete self-owner response must stay behind the receiver tail");
      assert.ok(selfEnd > ownerStart + owner.length,
        "finish owner/start before sending the self release");
      assert.equal(output.indexOf(owner, ownerStart + owner.length), -1,
        "the owner response must not be duplicated");
      assert.equal(roomManager.isLockedBy(room, clientId(name)), false);
      await waitFor(
        () => hasPacket(observer!.received, released),
        "modern observer receives the single-block release",
      );
      const forwarded = Buffer.concat(observer.received);
      const voiceIndex = forwarded.indexOf(VOICE_BLOCK);
      assert.ok(voiceIndex >= 0, "preserve the one real RF voice block");
      assert.equal(forwarded.indexOf(VOICE_BLOCK, voiceIndex + VOICE_BLOCK.length), -1,
        "do not synthesize a second voice block to finish the ack");
      assert.equal(sender.socket.destroyed, false);

      // A normal TX must still work on the same connection after the short TX.
      sender.received.length = 0;
      sender.socket.write(Buffer.concat([VOICE_BLOCK, VOICE_BLOCK]));
      await waitFor(
        () => hasPacket(sender!.received, released),
        "second TX on the same connection releases normally",
        3_000,
      );
      const second = Buffer.concat(sender.received);
      const secondOwner = second.indexOf(owner);
      assert.ok(secondOwner >= 0);
      assert.equal(second.indexOf(owner, secondOwner + owner.length), -1);
      assert.equal(sender.socket.destroyed, false);
      assert.equal(observer.socket.destroyed, false);
      assert.equal(roomManager.isLockedBy(room, clientId(name)), false);
    } finally {
      if (sender) await closeClient(sender.socket);
      if (observer) await closeClient(observer.socket);
      if (previous === undefined) delete process.env.EQSO_V113_VOX_TRIAL;
      else process.env.EQSO_V113_VOX_TRIAL = previous;
    }
  });
}

test("explicit release cancels the pending PRUEBAS VOX trial", async () => {
  const previous = process.env.EQSO_V113_VOX_TRIAL;
  process.env.EQSO_V113_VOX_TRIAL = "1";
  let sender: Awaited<ReturnType<typeof connectClient>> | undefined;
  try {
    sender = await connectClient("LEGACY-TRIAL-MANUAL", LEGACY_HANDSHAKE, TRIAL_ROOM);
    sender.socket.write(VOICE_BLOCK);
    const id = clientId("LEGACY-TRIAL-MANUAL");
    await waitFor(() => roomManager.isLockedBy(TRIAL_ROOM, id), "manual trial PTT");
    sender.received.length = 0;
    sender.socket.write(STANDARD_RELEASE);
    await waitFor(() => !roomManager.isLockedBy(TRIAL_ROOM, id), "manual trial release");
    const response = Buffer.from([0x08, 0x06, 0x00]);
    await waitFor(
      () => hasPacket(sender!.received, response),
      "manual trial release response",
    );
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const received = Buffer.concat(sender.received);
    assert.equal(received.indexOf(response), received.lastIndexOf(response));
    assert.equal(sender.socket.destroyed, false);
  } finally {
    if (sender) await closeClient(sender.socket);
    if (previous === undefined) delete process.env.EQSO_V113_VOX_TRIAL;
    else process.env.EQSO_V113_VOX_TRIAL = previous;
  }
});

test("CB VOX trial orders web receive tail before two RF TX cycles without dropping voice", async () => {
  const previous = process.env.EQSO_V113_VOX_TRIAL;
  process.env.EQSO_V113_VOX_TRIAL = "1";
  let sender: Awaited<ReturnType<typeof connectClient>> | undefined;
  let web: Awaited<ReturnType<typeof connectClient>> | undefined;
  try {
    sender = await connectClient("LEGACY-CB-TRIAL", LEGACY_HANDSHAKE, "CB");
    web = await connectClient("WEB-CB-TRIAL", MODERN_HANDSHAKE, "CB");
    sender.received.length = 0;
    web.socket.write(Buffer.concat(Array(15).fill(VOICE_BLOCK)));
    await waitFor(
      () => roomManager.isLockedBy("CB", clientId("WEB-CB-TRIAL")),
      "CB web PTT to start",
    );
    web.socket.write(STANDARD_RELEASE);
    await waitFor(
      () => !roomManager.isLockedBy("CB", clientId("WEB-CB-TRIAL")),
      "CB web PTT to end",
    );
    const id = clientId("LEGACY-CB-TRIAL");
    const selfStart = buildPttStarted("LEGACY-CB-TRIAL");
    const selfReleased = buildPttReleased("LEGACY-CB-TRIAL");
    const remoteReleased = buildPttReleased("WEB-CB-TRIAL");
    for (let cycle = 0; cycle < 2; cycle++) {
      web.received.length = 0;
      sender.socket.write(Buffer.concat([VOICE_BLOCK, VOICE_BLOCK]));
      await waitFor(
        () => roomManager.isLockedBy("CB", id),
        `CB RF cycle ${cycle + 1} to acquire PTT`,
      );
      await waitFor(
        () => hasPacket(sender!.received, selfReleased),
        `CB RF cycle ${cycle + 1} complete automatic release`,
        6_000,
      );
      const output = Buffer.concat(sender.received);
      const start = output.indexOf(selfStart);
      assert.ok(start >= 0);
      assert.ok(output.indexOf(selfReleased) > start);
      if (cycle === 0) {
        const remoteEnd = output.indexOf(remoteReleased);
        assert.ok(remoteEnd >= 0);
        assert.ok(start >= remoteEnd + remoteReleased.length);
      }
      assert.equal(roomManager.isLockedBy("CB", id), false);
      await waitFor(
        () => hasPacket(web!.received, selfReleased),
        "CB web client receives RF release",
      );
      const rfOutput = Buffer.concat(web.received);
      const voiceStart = rfOutput.indexOf(VOICE_BLOCK);
      assert.ok(voiceStart >= 0, "RF voice must reach the CB web client");
      assert.ok(rfOutput.subarray(voiceStart, voiceStart + VOICE_BLOCK.length * 2)
        .equals(Buffer.concat([VOICE_BLOCK, VOICE_BLOCK])), "both RF blocks must be preserved");
      assert.equal(sender.socket.destroyed, false);
      assert.equal(web.socket.destroyed, false);
      sender.received.length = 0;
    }
  } finally {
    if (sender) await closeClient(sender.socket);
    if (web) await closeClient(web.socket);
    if (previous === undefined) delete process.env.EQSO_V113_VOX_TRIAL;
    else process.env.EQSO_V113_VOX_TRIAL = previous;
  }
});

test("CB keeps diagnostic-only behavior with the trial disabled", async () => {
  const previous = process.env.EQSO_V113_VOX_TRIAL;
  delete process.env.EQSO_V113_VOX_TRIAL;
  let sender: Awaited<ReturnType<typeof connectClient>> | undefined;
  try {
    sender = await connectClient("LEGACY-CB-NO-TRIAL", LEGACY_HANDSHAKE, "CB");
    sender.socket.write(VOICE_BLOCK);
    const id = clientId("LEGACY-CB-NO-TRIAL");
    await waitFor(() => roomManager.isLockedBy("CB", id), "CB diagnostic PTT");
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    assert.equal(roomManager.isLockedBy("CB", id), true);
    assert.equal(hasPacket(sender.received, buildPttReleased("LEGACY-CB-NO-TRIAL")), false);
    assert.equal(sender.socket.destroyed, false);
  } finally {
    if (sender) await closeClient(sender.socket);
    if (previous === undefined) delete process.env.EQSO_V113_VOX_TRIAL;
    else process.env.EQSO_V113_VOX_TRIAL = previous;
  }
});

test("TCP diagnostics retain full TX count and queue state before error cleanup", async () => {
  const previous = process.env.EQSO_V113_VOX_TRIAL;
  process.env.EQSO_V113_VOX_TRIAL = "1";
  const originalWarn = logger.warn;
  const warnings: Array<{ fields: Record<string, unknown>; message: unknown }> = [];
  logger.warn = function (this: typeof logger, fields: unknown, ...args: unknown[]) {
    if (fields !== null && typeof fields === "object") {
      warnings.push({ fields: fields as Record<string, unknown>, message: args[0] });
    }
    return Reflect.apply(originalWarn, this, [fields, ...args]);
  } as typeof logger.warn;
  let sender: Awaited<ReturnType<typeof connectClient>> | undefined;
  let accepted: net.Socket | undefined;
  const onConnection = (socket: net.Socket) => { accepted = socket; };
  server.once("connection", onConnection);
  try {
    sender = await connectClient("LEGACY-DIAG", LEGACY_HANDSHAKE, "CB");
    sender.socket.write(Buffer.concat([VOICE_BLOCK, VOICE_BLOCK, VOICE_BLOCK]));
    await waitFor(
      () => hasPacket(sender!.received, buildPttReleased("LEGACY-DIAG")),
      "diagnostic sender completes its own release",
      3_000,
    );
    assert.ok(accepted);
    // Leave a receiver tail pending, then simulate the error event without
    // depending on OS-specific TCP reset behavior.
    roomManager.broadcastToRoom("CB", buildPttReleased("DIAG-REMOTE"));
    accepted.emit("error", Object.assign(new Error("Simulated diagnostic reset"), {
      code: "ECONNRESET",
      syscall: "read",
    }));
    const error = warnings.find((entry) => entry.message === "TCP socket error");
    assert.ok(error);
    assert.equal(error.fields.errorCode, "ECONNRESET");
    assert.equal(error.fields.errorMessage, "Simulated diagnostic reset");
    assert.equal(error.fields.errorSyscall, "read");
    assert.equal(error.fields.name, "LEGACY-DIAG");
    assert.equal(error.fields.room, "CB");
    assert.equal(error.fields.voiceBlocksInTx, 3);
    assert.equal(error.fields.lastReleaseVoiceBlocks, 3);
    assert.equal(error.fields.lastReleaseTrigger, "trial-vox-idle");
    assert.equal(error.fields.lastPttOrigin, "self-trial");
    assert.equal(error.fields.queueStateAfterCleanup, false);
    assert.ok(Number(error.fields.queuedItems) > 0);
    assert.equal(error.fields.outboundTimerActive, true);
    accepted.destroy();
    await waitFor(
      () => warnings.some((entry) =>
        entry.message === "Legacy v1.13 socket closed with outbound queue state"),
      "diagnostic close snapshot",
    );
    const closed = warnings.find((entry) =>
      entry.message === "Legacy v1.13 socket closed with outbound queue state");
    assert.ok(closed);
    assert.equal(closed.fields.queueStateAfterCleanup, true);
    assert.equal(closed.fields.queuedItems, 0);
    assert.equal(closed.fields.name, "LEGACY-DIAG");
    assert.equal(closed.fields.room, "CB");
  } finally {
    server.removeListener("connection", onConnection);
    if (accepted) accepted.destroy();
    if (sender) await closeClient(sender.socket);
    logger.warn = originalWarn;
    if (previous === undefined) delete process.env.EQSO_V113_VOX_TRIAL;
    else process.env.EQSO_V113_VOX_TRIAL = previous;
  }
});

test("VOX trial flag cannot release legacy PTT outside PRUEBAS and CB", async () => {
  const previous = process.env.EQSO_V113_VOX_TRIAL;
  process.env.EQSO_V113_VOX_TRIAL = "1";
  let sender: Awaited<ReturnType<typeof connectClient>> | undefined;
  try {
    sender = await connectClient("LEGACY-OTHER-ROOM", LEGACY_HANDSHAKE);
    sender.socket.write(VOICE_BLOCK);
    const id = clientId("LEGACY-OTHER-ROOM");
    await waitFor(() => roomManager.isLockedBy(ROOM, id), "other room PTT");
    await new Promise((resolve) => setTimeout(resolve, 1_650));
    assert.equal(roomManager.isLockedBy(ROOM, id), true);
  } finally {
    if (sender) await closeClient(sender.socket);
    if (previous === undefined) delete process.env.EQSO_V113_VOX_TRIAL;
    else process.env.EQSO_V113_VOX_TRIAL = previous;
  }
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

test("legacy v1.13 receiver gets the original finite silence and release tail", async () => {
  const receiver = await connectClient("LEGACY-RX-TAIL", LEGACY_HANDSHAKE);
  const sender = await connectClient("MODERN-RX-TAIL", MODERN_HANDSHAKE);
  receiver.received.length = 0;

  sender.socket.write(VOICE_BLOCK);
  const senderId = clientId("MODERN-RX-TAIL");
  await waitFor(
    () => roomManager.isLockedBy(ROOM, senderId),
    "modern sender to own PTT for legacy receiver",
  );

  sender.socket.write(STANDARD_RELEASE);
  const expectedTail = Buffer.concat([
    Buffer.alloc(9, EQSO_COMMANDS.IGNORE),
    Buffer.from([
      EQSO_COMMANDS.PTT_RELEASE_1,
      EQSO_COMMANDS.PTT_RELEASE_2,
      0x00,
    ]),
    buildPttReleased("MODERN-RX-TAIL"),
  ]);
  await waitFor(
    () => hasPacket(receiver.received, expectedTail),
    "legacy receiver to get finite silence and release tail",
    3_000,
  );
  assert.equal(receiver.socket.destroyed, false);

  await closeClient(sender.socket);
  await closeClient(receiver.socket);
});
