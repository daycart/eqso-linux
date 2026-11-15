import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebSocket } from "ws";
import { handleLocalMode, handleRemoteMode } from "../src/eqso/ws-bridge";
import { roomManager } from "../src/eqso/room-manager";
import { TxGuard } from "../src/eqso/tx-guard";
import { AudioBacklog } from "../src/eqso/audio-backlog";
import { EqsoProxy, FfmpegGsmEncoder } from "./support/ws-audio-stubs";
import { logger } from "../src/lib/logger";

logger.level = "silent";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("PTT cooldown, duplicates, sliding limit and independent clients", () => {
  const gate = new TxGuard();
  assert.equal(gate.start(0), "accepted");
  for (let i = 0; i < 10000; i++) assert.equal(gate.start(1), "duplicate");
  assert.equal(gate.end(10), true);
  assert.equal(gate.end(11), false);
  assert.equal(gate.start(509), "limited");
  for (let i = 1; i < 6; i++) {
    assert.equal(gate.start(i * 600), "accepted");
    assert.equal(gate.end(i * 600 + 10), true);
  }
  assert.equal(gate.start(4000), "limited");
  assert.equal(new TxGuard().start(4000), "accepted");
  assert.equal(gate.start(5010), "accepted");
  assert.equal(gate.end(5011), true); // release never needs a minimum duration
});

test("Audio budget rejects off-PTT, oversize and faster-than-realtime floods", () => {
  const gate = new TxGuard();
  assert.equal(gate.audio(160, 0), false);
  gate.start(0);
  assert.equal(gate.audio(100000, 0), false);
  for (let i = 0; i < 5; i++) assert.equal(gate.audio(960, 0), true);
  for (let i = 0; i < 10000; i++) assert.equal(gate.audio(960, 0), false);
  assert.equal(gate.audio(960, 120), true);
  gate.end(121);
  assert.equal(gate.audio(960, 122), false);
  assert.equal(gate.shouldNotify(0), true);
  assert.equal(gate.shouldNotify(499), false);
  assert.equal(gate.shouldNotify(500), true);
});

test("Codec backlog is bounded, skips stale outputs and preserves TX boundaries", () => {
  const backlog = new AudioBacklog();
  for (let i = 0; i < 8; i++) assert.equal(backlog.accept(0), true);
  for (let i = 0; i < 10000; i++) assert.equal(backlog.accept(10), false);
  assert.equal(backlog.complete(1201), false);
  assert.equal(backlog.accept(1201), true);
  backlog.invalidate();
  for (let i = 0; i < 8; i++) assert.equal(backlog.complete(1202), false);
  assert.equal(backlog.accept(1203), true);
  assert.equal(backlog.complete(1300), true);
  backlog.clear();
  assert.equal(backlog.complete(1301), false);
});

function socketFixture() {
  const messages: Record<string, unknown>[] = [];
  return {
    messages,
    ws: {
      readyState: 1, bufferedAmount: 0,
      send(data: string | Buffer) { if (typeof data === "string") messages.push(JSON.parse(data)); },
      close() {},
    } as unknown as WebSocket,
  };
}

test("Local handler: 1000 rapid taps produce one start and one release, then recover", async () => {
  const { ws, messages } = socketFixture();
  const id = "isolated-local-ptt";
  const idle = setInterval(() => {}, 60000);
  const handler = handleLocalMode(ws, id, idle);
  // Fixture joins directly; no authentication or live server is involved.
  roomManager.getClient(id)!.name = "TEST-MOBILE";
  roomManager.joinRoom(id, "ISOLATED-PTT");
  const encoder = FfmpegGsmEncoder.instances.at(-1)!;
  const send = (type: "ptt_start" | "ptt_end") => handler.onMessage({ type }, null);
  const packet = Buffer.concat([Buffer.from([1]), Buffer.alloc(960, 128)]);
  try {
    handler.onMessage({ type: "ping" }, packet);
    assert.equal(encoder.packets, 0, "audio must require the channel lock");
    send("ptt_start");
    handler.onMessage({ type: "ping" }, packet);
    assert.equal(encoder.packets, 1);
    for (let i = 0; i < 1000; i++) { send("ptt_end"); send("ptt_start"); }
    assert.equal(messages.filter(m => m.type === "ptt_granted").length, 1);
    assert.equal(messages.filter(m => m.type === "ptt_released").length, 1);
    assert.ok(messages.filter(m => m.type === "ptt_denied").length <= 1);
    await sleep(350);
    assert.equal(roomManager.isLockedBy("ISOLATED-PTT", id), false);
    await sleep(200);
    send("ptt_start");
    assert.equal(messages.filter(m => m.type === "ptt_granted").length, 2);
    handler.onMessage({ type: "ping" }, packet);
    send("ptt_end");
    await sleep(350);
    assert.equal(roomManager.isLockedBy("ISOLATED-PTT", id), false);
  } finally { handler.onClose(); clearInterval(idle); }
});

test("Remote handler: repeated releases do not postpone tail or grow timers", async () => {
  const { ws, messages } = socketFixture();
  const handler = handleRemoteMode(ws, "isolated-remote-ptt", "test.invalid", 1);
  const proxy = EqsoProxy.instances.at(-1)!;
  const send = (type: "ptt_start" | "ptt_end") => handler.onMessage({ type }, null);
  try {
    handler.onMessage({ type: "join", name: "TEST-MOBILE", room: "ISOLATED" }, null);
    send("ptt_start");
    for (let i = 0; i < 1000; i++) { send("ptt_end"); send("ptt_start"); }
    assert.equal(proxy.starts, 1);
    assert.equal(messages.filter(m => m.type === "ptt_released").length, 1);
    await sleep(350);
    assert.equal(proxy.releases, 1);
    for (let i = 0; i < 1000; i++) send("ptt_end");
    await sleep(350);
    assert.equal(proxy.releases, 1);
    send("ptt_start");
    assert.equal(proxy.starts, 2);
    send("ptt_end");
    await sleep(350);
    assert.equal(proxy.releases, 2);
  } finally { handler.onClose(); }
});
