import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { UpdateBulletinScheduleBody } from "@workspace/api-zod";
import { logger } from "../logger";
import { roomManager } from "../../eqso/room-manager";
import { BULLETINS_DIR, listBulletins, type StoredBulletin } from "./storage";
import { generateBulletin } from "./generation";
import { transmitBulletin } from "./transmission";
import { BulletinScheduler, type ScheduleState } from "./scheduler-core";

const file = path.join(BULLETINS_DIR, "schedule.json");
export const bulletinScheduler = new BulletinScheduler({
  now: Date.now,
  save: async state => {
    await mkdir(BULLETINS_DIR, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2));
    await rename(temporary, file);
  },
  generate: generateBulletin,
  current: async () => (await listBulletins())[0],
  rooms: () => roomManager.getRooms(),
  transmit: async (bulletin, room) => {
    const result = await transmitBulletin(bulletin as StoredBulletin, room, "AUTOMATICO");
    if (result.record.status === "failed") throw new Error(result.record.error ?? "Falló la emisión");
    return result.rejected ? "rejected" : "completed";
  },
});

let ready = false;
export function requireSchedulerReady(): void {
  if (!ready) throw new Error("El programador no está disponible; revise los registros del servidor");
}

export async function startBulletinScheduler(): Promise<void> {
  let saved: ScheduleState | undefined;
  try {
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    // Full status schema checks persisted timestamps/events as well as config.
    const { GetBulletinScheduleResponse } = await import("@workspace/api-zod");
    const validated = GetBulletinScheduleResponse.parse({
      ...(raw as object), generationRunning: false, transmissionRunning: false,
    });
    saved = JSON.parse(JSON.stringify({
      ...validated, config: UpdateBulletinScheduleBody.parse(validated.config),
    })) as ScheduleState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await bulletinScheduler.initialize(saved);
  ready = true;
  const timer = setInterval(() => {
    bulletinScheduler.tick().catch(error => logger.error({ err: error }, "Error del programador de boletines"));
  }, 5_000);
  timer.unref();
  logger.info("Programador de boletines preparado");
}
