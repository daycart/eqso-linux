import { spawnSync } from "child_process";

const OEM_UTF8_PAIRS: Record<string, string> = {
  "├ü": "Á", "├ë": "É", "├ì": "Í", "├ô": "Ó", "├Ü": "Ú", "├æ": "Ñ", "├£": "Ü",
  "├í": "á", "├®": "é", "├¡": "í", "├│": "ó", "├║": "ú", "├▒": "ñ", "├╝": "ü",
};

const DOUBLE_UTF8_SPANISH: Record<string, string> = {
  "ÃƒÂ¡": "á", "ÃƒÂ©": "é", "ÃƒÂ­": "í", "ÃƒÂ³": "ó", "ÃƒÂº": "ú",
  "ÃƒÂ±": "ñ", "ÃƒÂ¼": "ü",
};

function repairOnce(value: string): string {
  let repaired = value;
  for (const [broken, correct] of Object.entries(DOUBLE_UTF8_SPANISH)) {
    repaired = repaired.split(broken).join(correct);
  }
  for (const [broken, correct] of Object.entries(OEM_UTF8_PAIRS)) {
    repaired = repaired.split(broken).join(correct);
  }

  if (/[ÃÂâ]/.test(repaired)) {
    const candidate = Buffer.from(repaired, "latin1").toString("utf8");
    if (!candidate.includes("\uFFFD")) repaired = candidate;
  }
  return repaired;
}

export function repairWindowsDeviceName(value: string): string {
  let current = value;
  for (let i = 0; i < 3; i++) {
    const next = repairOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

function comparable(value: string): string {
  return repairWindowsDeviceName(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[b.length];
}

export function parseDirectShowAudioDevices(stderr: string): string[] {
  const devices: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const match = line.match(/"([^"]+)"\s+\(audio\)\s*$/);
    if (match && !devices.includes(match[1])) devices.push(match[1]);
  }
  return devices;
}

export function resolveDirectShowAudioDevice(
  configured: string,
  available: readonly string[],
): string {
  if (available.includes(configured)) return configured;

  const repaired = repairWindowsDeviceName(configured);
  const exact = available.find(
    (name) => name === repaired || name.toLocaleLowerCase() === repaired.toLocaleLowerCase(),
  );
  if (exact) return exact;

  const target = comparable(configured);
  const ranked = available
    .map((name) => ({ name, distance: editDistance(target, comparable(name)) }))
    .sort((a, b) => a.distance - b.distance);

  if (ranked.length > 0) {
    const limit = Math.max(2, Math.floor(target.length * 0.08));
    if (ranked[0].distance <= limit && ranked[0].distance < (ranked[1]?.distance ?? Infinity)) {
      return ranked[0].name;
    }
  }
  return configured;
}

export function enumerateDirectShowAudioDevices(ffmpegBin: string): string[] {
  const result = spawnSync(
    ffmpegBin,
    ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
    { encoding: "buffer", timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  const stderr = result.stderr?.toString("utf8") ?? "";
  return parseDirectShowAudioDevices(stderr);
}