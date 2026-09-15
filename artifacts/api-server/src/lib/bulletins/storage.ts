import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const BULLETINS_DIR = path.resolve(process.cwd(), "data", "bulletins");
const INDEX_FILE = path.join(BULLETINS_DIR, "index.json");
const MAX_HISTORY = 20;

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

interface BulletinIndex {
  bulletins: StoredBulletin[];
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

async function writeIndex(index: BulletinIndex): Promise<void> {
  await ensureDirectory();
  const temporary = `${INDEX_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await rename(temporary, INDEX_FILE);
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

export function getAudioPath(bulletin: StoredBulletin): string {
  const resolved = path.resolve(BULLETINS_DIR, bulletin.audioFileName);
  if (path.dirname(resolved) !== BULLETINS_DIR) {
    throw new Error("Ruta de audio no válida");
  }
  return resolved;
}