import { Router } from "express";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { textToSpeech } from "@workspace/integrations-openai-ai-server/audio";
import {
  GetBulletinStatusResponse,
  GetCurrentBulletinResponse,
  GetBulletinAudioParams,
  ListBulletinHistoryResponse,
} from "@workspace/api-zod";
import { requireAdmin } from "../lib/adminMiddleware";
import { logger } from "../lib/logger";
import {
  AEMET_SOURCE_URL,
  buildForecastText,
  fetchAemetForecast,
} from "../lib/bulletins/aemet";
import {
  getAudioPath,
  listBulletins,
  saveBulletin,
  type StoredBulletin,
} from "../lib/bulletins/storage";

const router = Router();
const IDENTITY = "eQSO Sierra Noroeste";
const GEOGRAPHIC_FOCUS = "Los Barrancos, Valdemorillo, Sierra Noroeste de Madrid";

function toResponse(bulletin: StoredBulletin): StoredBulletin & { audioUrl: string } {
  return { ...bulletin, audioUrl: `/api/admin/bulletins/${bulletin.id}/audio` };
}

router.use(requireAdmin);

router.get("/bulletins/status", async (req, res): Promise<void> => {
  try {
    const bulletins = await listBulletins();
    const current = bulletins[0];
    res.json(GetBulletinStatusResponse.parse({
      identity: IDENTITY,
      geographicFocus: GEOGRAPHIC_FOCUS,
      sourceUrl: AEMET_SOURCE_URL,
      historyCount: bulletins.length,
      hasCurrent: Boolean(current),
      currentId: current?.id ?? null,
      currentGeneratedAt: current?.generatedAt ?? null,
    }));
  } catch (error) {
    req.log.error({ err: error }, "No se pudo leer el estado de boletines");
    res.status(500).json({ error: "No se pudo leer el estado de boletines" });
  }
});

router.get("/bulletins/current", async (req, res): Promise<void> => {
  try {
    const [current] = await listBulletins();
    if (!current) {
      res.status(404).json({ error: "Todavía no hay un boletín generado" });
      return;
    }
    res.json(GetCurrentBulletinResponse.parse(toResponse(current)));
  } catch (error) {
    req.log.error({ err: error }, "No se pudo leer el boletín actual");
    res.status(500).json({ error: "No se pudo leer el boletín actual" });
  }
});

router.get("/bulletins/history", async (req, res): Promise<void> => {
  try {
    const bulletins = await listBulletins();
    res.json(ListBulletinHistoryResponse.parse(bulletins.map(toResponse)));
  } catch (error) {
    req.log.error({ err: error }, "No se pudo leer el historial de boletines");
    res.status(500).json({ error: "No se pudo leer el historial de boletines" });
  }
});

router.post("/bulletins/generate", async (req, res): Promise<void> => {
  const generatedAt = new Date().toISOString();
  try {
    const forecast = await fetchAemetForecast();
    const forecastText = buildForecastText(forecast, generatedAt);
    // gpt-audio chat completions are used for batch synthesis; failures are
    // deliberately allowed to abort before anything is written to the index.
    const audio = await textToSpeech(forecastText, "alloy", "wav");
    const id = randomUUID();
    const bulletin: StoredBulletin = {
      id,
      identity: IDENTITY,
      geographicFocus: GEOGRAPHIC_FOCUS,
      municipality: forecast.municipality,
      forecastText,
      sourceUrl: AEMET_SOURCE_URL,
      sourceAttribution: forecast.sourceAttribution,
      sourcePublishedAt: forecast.sourcePublishedAt,
      sourceRetrievedAt: forecast.sourceRetrievedAt,
      generatedAt,
      audioFileName: `${id}.wav`,
      audioMimeType: "audio/wav",
      forecastDates: forecast.days.map((day) => day.date),
    };
    await saveBulletin(bulletin, audio);
    res.status(201).json(GetCurrentBulletinResponse.parse(toResponse(bulletin)));
  } catch (error) {
    req.log.error({ err: error }, "No se pudo generar el boletín meteorológico");
    res.status(502).json({
      error: error instanceof Error ? error.message : "No se pudo generar el boletín meteorológico",
    });
  }
});

router.get("/bulletins/:id/audio", async (req, res): Promise<void> => {
  const params = GetBulletinAudioParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Identificador de boletín inválido" });
    return;
  }
  try {
    const bulletin = (await listBulletins()).find((item) => item.id === params.data.id);
    if (!bulletin) {
      res.status(404).json({ error: "Boletín no encontrado" });
      return;
    }
    const audio = await readFile(getAudioPath(bulletin));
    res.type(bulletin.audioMimeType);
    res.send(audio);
  } catch (error) {
    req.log.error({ err: error }, "No se pudo leer el audio del boletín");
    res.status(404).json({ error: "Audio del boletín no encontrado" });
  }
});

export default router;