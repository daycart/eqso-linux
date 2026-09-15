import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const BULLETINS_DIR = path.resolve(process.cwd(), "data", "bulletins");
const INDEX_FILE = path.join(BULLETINS_DIR, "index.json");
const TRANSMISSIONS_FILE = path.join(BULLETINS_DIR, "transmissions.json");
const MAX_HISTORY = 20;
const MAX_TRANSMISSION_HISTORY = 50;

export interface StoredBulletin {
  id: string;
  identity: string;
  geographicFocus: string;
  municipality: string;
  forecastText: string;
  sourceUrl: string;
  sourceAttribution: string;
  sourcePublishedAt: string | null;
  sourceRetrievedAt: string;
  generatedAt: string;
  audioFileName: string;
  audioMimeType: string;
  forecastDates: string[];
}

export type BulletinTransmissionStatus = "completed" | "failed" | "rejected";

export interface BulletinTransmission {
  id: string;
  bulletinId: string;
  bulletinGeneratedAt: string;
  room: string;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  status: BulletinTransmissionStatus;
  error: string | null;
  packetCount: number;
  durationMs: number;
  requestedBy: string | null;
}

interface BulletinIndex {
  bulletins: StoredBulletin[];
}

interface TransmissionIndex {
  transmissions: BulletinTransmission[];
}

let operation: Promise<unknown> = Promise.resolve();

async function ensureDirectory(): Promise<void> {
  await mkdir(BULLETINS_DIR, { recursive: true });
}

async function readIndex(): Promise<BulletinIndex> {
  await ensureDirectory();
  try {
    const content = await readFile(INDEX_FILE, "utf8");
    const parsed = JSON.parse(content) as BulletinIndex;
    if (!parsed || !Array.isArray(parsed.bulletins)) {
      throw new Error("El índice de boletines no tiene un formato válido");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { bulletins: [] };
    }
    throw error;
  }
}

async function readTransmissionIndex(): Promise<TransmissionIndex> {
  await ensureDirectory();
  try {
    const content = await readFile(TRANSMISSIONS_FILE, "utf8");
    const parsed = JSON.parse(content) as TransmissionIndex;
    if (!parsed || !Array.isArray(parsed.transmissions)) {
      throw new Error("El índice de transmisiones no tiene un formato válido");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { transmissions: [] };
    }
    throw error;
  }
}

async function writeIndex(index: BulletinIndex): Promise<void> {
  await ensureDirectory();
  const temporary = `${INDEX_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await rename(temporary, INDEX_FILE);
}

async function writeTransmissionIndex(index: TransmissionIndex): Promise<void> {
  await ensureDirectory();
  const temporary = `${TRANSMISSIONS_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await rename(temporary, TRANSMISSIONS_FILE);
}

async function locked<T>(callback: () => Promise<T>): Promise<T> {
  const previous = operation;
  let release!: () => void;
  operation = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await callback();
  } finally {
    release();
  }
}

export async function listBulletins(): Promise<StoredBulletin[]> {
  return locked(async () => (await readIndex()).bulletins);
}

export async function saveBulletin(
  bulletin: StoredBulletin,
  audio: Buffer,
): Promise<StoredBulletin[]> {
  return locked(async () => {
    await ensureDirectory();
    const audioPath = path.join(BULLETINS_DIR, bulletin.audioFileName);
    await writeFile(audioPath, audio, { flag: "wx" });
    const index = await readIndex();
    const bulletins = [bulletin, ...index.bulletins].slice(0, MAX_HISTORY);
    await writeIndex({ bulletins });
    return bulletins;
  });
}

export async function createBulletinTransmission(
  transmission: BulletinTransmission,
): Promise<BulletinTransmission> {
  return locked(async () => {
    const index = await readTransmissionIndex();
    await writeTransmissionIndex({
      transmissions: [transmission, ...index.transmissions].slice(0, MAX_TRANSMISSION_HISTORY),
    });
    return transmission;
  });
}

export async function updateBulletinTransmission(
  id: string,
  update: Partial<BulletinTransmission>,
): Promise<BulletinTransmission> {
  return locked(async () => {
    const index = await readTransmissionIndex();
    const position = index.transmissions.findIndex((item) => item.id === id);
    if (position < 0) throw new Error("Intento de transmisión no encontrado");
    const transmission = { ...index.transmissions[position], ...update };
    index.transmissions[position] = transmission;
    await writeTransmissionIndex(index);
    return transmission;
  });
}

export async function listBulletinTransmissions(): Promise<BulletinTransmission[]> {
  return locked(async () => (await readTransmissionIndex()).transmissions.slice(0, MAX_TRANSMISSION_HISTORY));
}

export function getAudioPath(bulletin: StoredBulletin): string {
  const resolved = path.resolve(BULLETINS_DIR, bulletin.audioFileName);
  if (path.dirname(resolved) !== BULLETINS_DIR) {
    throw new Error("Ruta de audio no válida");
  }
  return resolved;
}