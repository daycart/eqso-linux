import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDirectShowAudioDevices,
  repairWindowsDeviceName,
  resolveDirectShowAudioDevice,
} from "./windows-audio-device.js";

test("repara las variantes habituales de Micrófono", () => {
  for (const broken of [
    "MicrÃ³fono (Sound Blaster Play! 3)",
    "MicrÃƒÂ³fono (Sound Blaster Play! 3)",
    "Micr├│fono (Sound Blaster Play! 3)",
  ]) {
    assert.equal(
      repairWindowsDeviceName(broken),
      "Micrófono (Sound Blaster Play! 3)",
    );
  }
});

test("extrae únicamente entradas DirectShow", () => {
  const output = [
    '[dshow @ 1] "Micrófono (USB Audio)" (audio)',
    '[dshow @ 1]   Alternative name "@device_cm_..."',
    '[dshow @ 1] "Cámara USB" (video)',
  ].join("\r\n");
  assert.deepEqual(parseDirectShowAudioDevices(output), ["Micrófono (USB Audio)"]);
});

test("resuelve el nombre configurado contra el nombre real enumerado", () => {
  const available = [
    "Micrófono (Sound Blaster Play! 3)",
    "Micrófono (Realtek(R) Audio)",
  ];
  assert.equal(
    resolveDirectShowAudioDevice("MicrÃƒÂ³fono (Sound Blaster Play! 3)", available),
    available[0],
  );
  assert.equal(
    resolveDirectShowAudioDevice("Micr├│fono (Sound Blaster Play! 3)", available),
    available[0],
  );
});

test("no adivina si no hay una coincidencia segura", () => {
  assert.equal(
    resolveDirectShowAudioDevice("Entrada desconocida", ["Micrófono (USB Audio)"]),
    "Entrada desconocida",
  );
});