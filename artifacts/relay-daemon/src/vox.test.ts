import assert from "node:assert/strict";
import test from "node:test";
import { Vox } from "./vox.js";

const pcm = (level: number): Int16Array => new Int16Array(160).fill(level);
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function recordEvents(vox: Vox): string[] {
  const events: string[] = [];
  vox.on("ptt_start", () => events.push("start"));
  vox.on("ptt_end", () => events.push("end"));
  return events;
}

test("el ruido de reposo no abre el canal", async () => {
  const vox = new Vox(800, 150, 40);
  const events = recordEvents(vox);

  for (let i = 0; i < 10; i++) {
    vox.processPcm(pcm(31));
    await sleep(5);
  }

  assert.deepEqual(events, []);
});

test("la voz suave mantiene una transmisión ya iniciada", async () => {
  const vox = new Vox(800, 150, 40);
  const events = recordEvents(vox);

  // Este nivel no basta para iniciar.
  vox.processPcm(pcm(300));
  assert.deepEqual(events, []);

  vox.processPcm(pcm(1_000));
  assert.deepEqual(events, ["start"]);

  // Una señal entre ambos umbrales debe cancelar continuamente el hang.
  for (let i = 0; i < 8; i++) {
    await sleep(20);
    vox.processPcm(pcm(200));
  }

  assert.deepEqual(events, ["start"]);
  vox.forcePttEnd();
});

test("el silencio real cierra después del tiempo de hang", async () => {
  const vox = new Vox(800, 150, 40);
  const events = recordEvents(vox);

  vox.processPcm(pcm(1_000));
  vox.processPcm(pcm(31));
  await sleep(60);

  assert.deepEqual(events, ["start", "end"]);
});

test("una conversación larga genera un solo inicio y un solo final", async () => {
  const vox = new Vox(800, 150, 50);
  const events = recordEvents(vox);
  const speechPattern = [1_200, 350, 180, 2_000, 220, 500];

  vox.processPcm(pcm(1_200));
  for (let i = 0; i < 30; i++) {
    await sleep(15);
    vox.processPcm(pcm(speechPattern[i % speechPattern.length]));
  }

  assert.deepEqual(events, ["start"]);

  vox.processPcm(pcm(31));
  await sleep(70);
  assert.deepEqual(events, ["start", "end"]);
});