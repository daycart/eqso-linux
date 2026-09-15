export const AEMET_SOURCE_URL =
  "https://www.aemet.es/xml/municipios/localidad_28160.xml";
export const MUNICIPALITY_CODE = "28160";
export const MUNICIPALITY = "Valdemorillo";

export interface AemetDay {
  date: string;
  description: string | null;
  precipitation: number | null;
  minimum: number | null;
  maximum: number | null;
  windDirection: string | null;
  windSpeed: number | null;
}

export interface AemetForecast {
  municipality: string;
  sourceAttribution: string;
  sourcePublishedAt: string | null;
  sourceRetrievedAt: string;
  days: AemetDay[];
}

function decodeIso885915(bytes: Uint8Array): string {
  // ISO-8859-15 is identical to ISO-8859-1 except for these eight positions.
  const replacements: Record<number, string> = {
    0xa4: "€",
    0xa6: "Š",
    0xa8: "š",
    0xb4: "Ž",
    0xb8: "ž",
    0xbc: "Œ",
    0xbd: "œ",
    0xbe: "Ÿ",
  };
  let decoded = "";
  for (const byte of bytes) {
    decoded += replacements[byte] ?? String.fromCharCode(byte);
  }
  return decoded;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function element(xml: string, name: string): string | null {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  const value = match?.[1]?.trim();
  return value ? unescapeXml(value) : null;
}

function attribute(xml: string, name: string): string | null {
  const match = xml.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? unescapeXml(match[1]) : null;
}

function numeric(value: string | null): number | null {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function taggedValue(xml: string, tag: string, period?: string): string | null {
  const periodPart = period ? `\\s+periodo="${period}"` : "";
  const match = xml.match(new RegExp(`<${tag}${periodPart}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match?.[1]?.trim() || null;
}

function firstNumber(xml: string, tag: string, periods: string[]): number | null {
  for (const period of periods) {
    const value = numeric(taggedValue(xml, tag, period));
    if (value != null) return value;
  }
  return null;
}

function parseDay(date: string, xml: string): AemetDay {
  const descriptions = ["00-24", "12-24", "00-12", "06-12", "12-18", "18-24"]
    .map((period) => attribute(
      xml.match(new RegExp(`<estado_cielo\\s+periodo="${period}"[^>]*>`))?.[0] ?? "",
      "descripcion",
    ))
    .filter((value): value is string => Boolean(value));
  const description = descriptions[0] ?? null;
  const wind = xml.match(/<viento\s+periodo="00-24"[^>]*>([\s\S]*?)<\/viento>/)?.[1] ?? "";
  const fallbackWind =
    xml.match(/<viento\s+periodo="12-24"[^>]*>([\s\S]*?)<\/viento>/)?.[1] ?? "";

  return {
    date,
    description,
    precipitation: firstNumber(xml, "prob_precipitacion", ["00-24", "12-24", "00-12", "06-12", "12-18", "18-24"]),
    minimum: numeric(element(xml, "minima")),
    maximum: numeric(element(xml, "maxima")),
    windDirection: element(wind, "direccion") ?? element(fallbackWind, "direccion"),
    windSpeed: numeric(element(wind, "velocidad") ?? element(fallbackWind, "velocidad")),
  };
}

export async function fetchAemetForecast(): Promise<AemetForecast> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(AEMET_SOURCE_URL, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`AEMET respondió con HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const xml = decodeIso885915(bytes);
  const root = xml.match(/<root\b[^>]*>/)?.[0] ?? "";
  if (!new RegExp(`\\bid="${MUNICIPALITY_CODE}"`).test(root)) {
    throw new Error("La respuesta de AEMET no corresponde al municipio solicitado");
  }
  const municipality = element(xml, "nombre");
  if (municipality !== MUNICIPALITY) {
    throw new Error(`Municipio AEMET inesperado: ${municipality ?? "desconocido"}`);
  }

  const days = [...xml.matchAll(/<dia\s+fecha="([^"]+)"[^>]*>([\s\S]*?)<\/dia>/g)]
    .slice(0, 3)
    .map((match) => parseDay(match[1], match[2]));
  if (days.length === 0) {
    throw new Error("La respuesta de AEMET no contiene días de predicción");
  }

  // The AEMET XML is published with a local Madrid timestamp and has no offset.
  // Preserve that value verbatim as attribution metadata rather than guessing one.
  const sourcePublishedAt = element(xml, "elaborado");
  const sourceAttribution =
    element(xml, "copyright") ??
    element(xml, "productor") ??
    "Agencia Estatal de Meteorología (AEMET)";
  return {
    municipality,
    sourceAttribution,
    sourcePublishedAt,
    sourceRetrievedAt: new Date().toISOString(),
    days,
  };
}

export function formatDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
  }).format(parsed);
}

function weatherSentence(day: AemetDay): string {
  const parts = [`${formatDate(day.date)}: ${day.description ?? "cielo sin descripción disponible"}`];
  if (day.minimum != null && day.maximum != null) {
    parts.push(`temperaturas entre ${day.minimum} y ${day.maximum} grados`);
  } else if (day.maximum != null) {
    parts.push(`máxima de ${day.maximum} grados`);
  }
  if (day.precipitation != null) {
    parts.push(`probabilidad de precipitación del ${day.precipitation} por ciento`);
  }
  if (day.windDirection && day.windSpeed != null) {
    const windDirections: Record<string, string> = {
      N: "norte",
      NE: "noreste",
      E: "este",
      SE: "sureste",
      S: "sur",
      SO: "suroeste",
      O: "oeste",
      NO: "noroeste",
      C: "calma",
      VRB: "dirección variable",
    };
    const direction = windDirections[day.windDirection.toUpperCase()] ?? day.windDirection;
    const windDescription =
      direction === "calma"
        ? `viento en calma, a ${day.windSpeed} kilómetros por hora`
        : direction === "dirección variable"
          ? `viento de dirección variable, a ${day.windSpeed} kilómetros por hora`
          : `viento de componente ${direction}, a ${day.windSpeed} kilómetros por hora`;
    parts.push(windDescription);
  }
  return parts.join(", ");
}

export function buildForecastText(forecast: AemetForecast, generatedAt: string): string {
  const dateTime = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    dateStyle: "long",
    timeStyle: "short",
  }).format(new Date(generatedAt));
  const days = forecast.days.map(weatherSentence).join(". ");
  return `Boletín eQSO Sierra Noroeste para Los Barrancos, Valdemorillo y la Sierra Noroeste de Madrid. Preparado el ${dateTime}. ${days}. Información oficial de la Agencia Estatal de Meteorología, AEMET. Fin del boletín.`;
}