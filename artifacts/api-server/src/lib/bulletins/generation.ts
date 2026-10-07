import { randomUUID } from "node:crypto";
import { AEMET_SOURCE_URL, buildForecastText, fetchAemetForecast } from "./aemet";
import { synthesizeBulletinSpeech } from "./speech";
import { saveBulletin, type StoredBulletin } from "./storage";

let generating = false;

/** Shared by manual and scheduled requests: never synthesize concurrently. */
export async function generateBulletin(): Promise<StoredBulletin> {
  if (generating) throw new Error("Ya se está generando un boletín");
  generating = true;
  try {
    const generatedAt = new Date().toISOString();
    const forecast = await fetchAemetForecast();
    const forecastText = buildForecastText(forecast, generatedAt);
    const audio = await synthesizeBulletinSpeech(forecastText);
    const id = randomUUID();
    const bulletin: StoredBulletin = {
      id, generatedAt, forecastText,
      identity: "eQSO Sierra Noroeste",
      geographicFocus: "Los Barrancos, Valdemorillo, Sierra Noroeste de Madrid",
      municipality: forecast.municipality,
      sourceUrl: AEMET_SOURCE_URL,
      sourceAttribution: forecast.sourceAttribution,
      sourcePublishedAt: forecast.sourcePublishedAt,
      sourceRetrievedAt: forecast.sourceRetrievedAt,
      audioFileName: `${id}.wav`,
      audioMimeType: "audio/wav",
      forecastDates: forecast.days.map(day => day.date),
    };
    await saveBulletin(bulletin, audio);
    return bulletin;
  } finally {
    generating = false;
  }
}
