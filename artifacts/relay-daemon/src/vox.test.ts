import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { SHIPPED_VOX_PROFILES } from "./config.js";
import { Vox } from "./vox.js";
import { REAL_RADIO_RMS_100MS } from "./vox-real-radio.fixture.js";

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

async function validateRealRadioProfile(
  profile: (typeof SHIPPED_VOX_PROFILES)[keyof typeof SHIPPED_VOX_PROFILES],
): Promise<string[]> {
  // Reproducción 10 veces más rápida: 100 ms reales equivalen a 10 ms de test,
  // por lo que el hang predeterminado se escala por el mismo factor.
  const timeScale = 10;
  const vox = new Vox(
    profile.thresholdRms,
    profile.sustainRms,
    profile.hangMs / timeScale,
  );
  const events = recordEvents(vox);

  for (const rms of REAL_RADIO_RMS_100MS) {
    vox.processPcm(pcm(rms));
    await sleep(10);
  }
  await sleep(200);
  return events;
}

for (const [name, profile] of Object.entries(SHIPPED_VOX_PROFILES)) {
  test(`la muestra real no se fragmenta con el perfil ${name}`, async () => {
    assert.deepEqual(await validateRealRadioProfile(profile), ["start", "end"]);
  });
}

test("los instaladores declaran exactamente los perfiles VOX comprobados", () => {
  const shippedFiles = [
    ["install/install-relay.ps1", SHIPPED_VOX_PROFILES.windows],
    ["install/config-windows.example.json", SHIPPED_VOX_PROFILES.windows],
    ["install/install-relay.sh", SHIPPED_VOX_PROFILES.linux],
    ["install/install-operator.sh", SHIPPED_VOX_PROFILES.linux],
    ["install/config.example.json", SHIPPED_VOX_PROFILES.linux],
  ] as const;

  for (const [file, profile] of shippedFiles) {
    const content = fs.readFileSync(file, "utf8");
    assert.match(content, new RegExp(`voxThresholdRms[^\\d]+${profile.thresholdRms}`), file);
    assert.match(content, new RegExp(`voxSustainRms[^\\d]+${profile.sustainRms}`), file);
    assert.match(content, new RegExp(`voxHangMs[^\\d]+${profile.hangMs}`), file);
  }
});