import assert from "node:assert/strict";
import { test } from "node:test";
import { BulletinScheduler, DEFAULT_SCHEDULE, type ScheduleState, type SchedulerDependencies } from "../src/lib/bulletins/scheduler-core";
import { UpdateBulletinScheduleBody } from "@workspace/api-zod";

function fixture(overrides: Partial<SchedulerDependencies> = {}) {
  let clock = Date.parse("2026-10-07T10:00:00Z");
  let saved: ScheduleState | undefined;
  let generated = 0;
  let transmitted = 0;
  const scheduler = new BulletinScheduler({
    now: () => clock,
    save: async state => { saved = structuredClone(state); },
    generate: async () => { generated++; },
    current: async () => ({
      generatedAt: new Date(clock).toISOString(),
      sourceRetrievedAt: new Date(clock).toISOString(),
      forecastDates: ["2026-10-07"],
    }),
    rooms: () => ["PRUEBAS", "CB"],
    transmit: async () => { transmitted++; return "completed"; },
    ...overrides,
  });
  return {
    scheduler, advance: (minutes: number) => { clock += minutes * 60_000; },
    saved: () => saved, generated: () => generated, transmitted: () => transmitted,
  };
}

const enabled = {
  ...DEFAULT_SCHEDULE, generationEnabled: true, transmissionEnabled: true,
  generationIntervalMinutes: 15, transmissionIntervalMinutes: 5,
  room: "PRUEBAS", confirmed: true,
};

test("defaults and saving configuration never generate or emit immediately", async () => {
  const f = fixture();
  await f.scheduler.initialize();
  f.advance(1_000);
  await f.scheduler.tick();
  assert.equal(f.transmitted(), 0);
  assert.equal(f.generated(), 0);
  await f.scheduler.configure(enabled);
  await f.scheduler.tick();
  assert.equal(f.transmitted(), 0);
  assert.equal(f.generated(), 0);
  assert.equal(f.scheduler.status().config.confirmed, undefined);
});

test("schema rejects unsafe intervals and unconfirmed RF or unavailable rooms cannot enable", async () => {
  for (const field of ["generationIntervalMinutes", "transmissionIntervalMinutes", "maxAgeMinutes"]) {
    assert.equal(UpdateBulletinScheduleBody.safeParse({ ...enabled, [field]: 0 }).success, false);
    assert.equal(UpdateBulletinScheduleBody.safeParse({ ...enabled, [field]: 1.5 }).success, false);
    assert.equal(UpdateBulletinScheduleBody.safeParse({ ...enabled, [field]: 10081 }).success, false);
  }
  const f = fixture();
  await f.scheduler.initialize();
  await assert.rejects(f.scheduler.configure({ ...enabled, confirmed: false }));
  await assert.rejects(f.scheduler.configure({ ...enabled, room: "OTHER" }));
  assert.equal(f.scheduler.status().config.transmissionEnabled, false);
});

test("independent intervals; generation-only mode never emits", async () => {
  const f = fixture();
  await f.scheduler.initialize();
  await f.scheduler.configure(enabled);
  f.advance(5); await f.scheduler.tick();
  assert.equal(f.transmitted(), 1);
  assert.equal(f.generated(), 0);
  f.advance(10); await f.scheduler.tick();
  assert.equal(f.transmitted(), 2);
  assert.equal(f.generated(), 1);
  await f.scheduler.configure({ ...enabled, transmissionEnabled: false });
  f.advance(15); await f.scheduler.tick();
  assert.equal(f.generated(), 2);
  assert.equal(f.transmitted(), 2);
});

test("restart retains config but resets deadlines, without catch-up", async () => {
  const f = fixture();
  await f.scheduler.initialize();
  await f.scheduler.configure(enabled);
  const saved = f.saved()!;
  const restarted = fixture();
  restarted.advance(240);
  await restarted.scheduler.initialize(saved);
  await restarted.scheduler.tick();
  assert.equal(restarted.transmitted(), 0);
  restarted.advance(5); await restarted.scheduler.tick();
  assert.equal(restarted.transmitted(), 1);
});

test("delayed tick emits once, not all missed intervals", async () => {
  const f = fixture();
  await f.scheduler.initialize();
  await f.scheduler.configure(enabled);
  f.advance(120);
  await f.scheduler.tick();
  await f.scheduler.tick();
  assert.equal(f.generated(), 1);
  assert.equal(f.transmitted(), 1);
});

test("occupied room skips the cycle, no immediate retries", async () => {
  let attempts = 0;
  const f = fixture({ transmit: async () => { attempts++; return "rejected"; } });
  await f.scheduler.initialize();
  await f.scheduler.configure(enabled);
  f.advance(5);
  await f.scheduler.tick();
  await f.scheduler.tick();
  assert.equal(attempts, 1);
  assert.equal(f.scheduler.status().lastTransmission?.status, "skipped");
});

test("missing, expired, future and wrong-day bulletins never emit", async () => {
  const initial = "2026-10-07T10:00:00Z";
  const candidates = [
    undefined,
    { generatedAt: "2026-10-06T00:00:00Z", sourceRetrievedAt: initial, forecastDates: ["2026-10-07"] },
    { generatedAt: initial, sourceRetrievedAt: "2026-10-06T00:00:00Z", forecastDates: ["2026-10-07"] },
    { generatedAt: initial, sourceRetrievedAt: initial, forecastDates: ["2026-10-06"] },
    { generatedAt: "invalid", sourceRetrievedAt: initial, forecastDates: ["2026-10-07"] },
    { generatedAt: "2026-10-08T00:00:00Z", sourceRetrievedAt: initial, forecastDates: ["2026-10-07"] },
  ];
  for (const candidate of candidates) {
    const f = fixture({ current: async () => candidate });
    await f.scheduler.initialize(); await f.scheduler.configure(enabled);
    f.advance(5); await f.scheduler.tick();
    assert.equal(f.transmitted(), 0);
    assert.equal(f.scheduler.status().lastTransmission?.status, "skipped");
  }
});

test("generation failure records error and skips simultaneous emission", async () => {
  const f = fixture({ generate: async () => { throw new Error("AEMET down"); } });
  await f.scheduler.initialize(); await f.scheduler.configure(enabled);
  f.advance(15); await f.scheduler.tick();
  assert.equal(f.generated(), 0);
  assert.equal(f.transmitted(), 0);
  assert.equal(f.scheduler.status().lastGeneration?.message, "AEMET down");
  assert.equal(f.scheduler.status().lastTransmission?.status, "skipped");
});

test("transmission errors are recorded and are not retried immediately", async () => {
  let attempts = 0;
  const f = fixture({ transmit: async () => { attempts++; throw new Error("TCP unavailable"); } });
  await f.scheduler.initialize(); await f.scheduler.configure(enabled);
  f.advance(5); await f.scheduler.tick(); await f.scheduler.tick();
  assert.equal(attempts, 1);
  assert.equal(f.scheduler.status().lastTransmission?.message, "TCP unavailable");
});

test("overlapping ticks cannot start duplicate generation and disable cancels unstarted RF", async () => {
  let finish!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture({ generate: async () => { started(); await blocked; } });
  await f.scheduler.initialize(); await f.scheduler.configure(enabled);
  f.advance(15);
  const first = f.scheduler.tick();
  await entered;
  assert.equal(f.scheduler.status().generationRunning, true);
  await f.scheduler.tick();
  await f.scheduler.configure({ ...enabled, transmissionEnabled: false });
  finish(); await first;
  assert.equal(f.transmitted(), 0);
  assert.equal(f.scheduler.status().config.transmissionEnabled, false);
  assert.equal(f.scheduler.status().generationRunning, false);
});

test("failed persistence leaves disabled state and cannot start a job", async () => {
  let fail = false;
  const f = fixture({ save: async () => { if (fail) throw new Error("Disk full"); } });
  await f.scheduler.initialize();
  fail = true;
  await assert.rejects(f.scheduler.configure(enabled), /Disk full/);
  assert.equal(f.scheduler.status().config.transmissionEnabled, false);
  f.advance(60); await f.scheduler.tick();
  assert.equal(f.transmitted(), 0);
});

test("claim must persist before execution; disabling persists across restart", async () => {
  let fail = false;
  const f = fixture({ save: async () => { if (fail) throw new Error("Disk full"); } });
  await f.scheduler.initialize(); await f.scheduler.configure(enabled);
  fail = true; f.advance(15);
  await assert.rejects(f.scheduler.tick(), /Disk full/);
  assert.equal(f.generated(), 0); assert.equal(f.transmitted(), 0);
  fail = false;
  await f.scheduler.configure({ ...enabled, generationEnabled: false, transmissionEnabled: false });
  const restarted = fixture();
  await restarted.scheduler.initialize(f.scheduler.status());
  restarted.advance(120); await restarted.scheduler.tick();
  assert.equal(restarted.generated(), 0); assert.equal(restarted.transmitted(), 0);
});
