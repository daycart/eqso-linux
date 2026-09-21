import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { textToSpeech } from "@workspace/integrations-openai-ai-server/audio";
import { logger } from "../logger";

const DEFAULT_PIPER_PYTHON = "/opt/piper/venv/bin/python";
const DEFAULT_PIPER_DATA_DIR = "/var/lib/eqso/piper";
const DEFAULT_PIPER_MODEL = "es_ES-sharvard-medium";
const PIPER_TIMEOUT_MS = 120_000;

type BulletinSpeechProvider = "auto" | "openai" | "piper";

function configuredProvider(): BulletinSpeechProvider {
  const value = process.env.BULLETIN_TTS_PROVIDER?.trim().toLowerCase() ?? "auto";
  if (value === "auto" || value === "openai" || value === "piper") return value;
  throw new Error(
    `BULLETIN_TTS_PROVIDER debe ser auto, openai o piper; recibido: ${value}`,
  );
}

function piperConfig(): {
  python: string;
  dataDir: string;
  model: string;
  modelPath: string;
} {
  const python = process.env.PIPER_PYTHON ?? DEFAULT_PIPER_PYTHON;
  const dataDir = process.env.PIPER_DATA_DIR ?? DEFAULT_PIPER_DATA_DIR;
  const model = process.env.PIPER_MODEL ?? DEFAULT_PIPER_MODEL;
  return {
    python,
    dataDir,
    model,
    modelPath: path.join(dataDir, `${model}.onnx`),
  };
}

async function isPiperAvailable(): Promise<boolean> {
  const { python, modelPath } = piperConfig();
  try {
    await Promise.all([
      access(python, constants.X_OK),
      access(modelPath, constants.R_OK),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function synthesizeWithPiper(text: string): Promise<Buffer> {
  const { python, dataDir, model } = piperConfig();
  const outputPath = path.join(
    os.tmpdir(),
    `eqso-bulletin-${process.pid}-${randomUUID()}.wav`,
  );

  try {
    const stderr = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        python,
        [
          "-m",
          "piper",
          "--data-dir",
          dataDir,
          "-m",
          model,
          "-f",
          outputPath,
          "--",
          text,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      const errorChunks: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => errorChunks.push(chunk));

      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Piper superó el tiempo máximo de 120 segundos"));
      }, PIPER_TIMEOUT_MS);

      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        const errorText = Buffer.concat(errorChunks).toString("utf8").trim();
        if (code !== 0) {
          reject(
            new Error(
              `Piper terminó con ${signal ?? `código ${code}`}${
                errorText ? `: ${errorText}` : ""
              }`,
            ),
          );
          return;
        }
        resolve(errorText);
      });
    });

    if (stderr) {
      logger.debug({ stderr }, "Piper completó la síntesis con avisos");
    }
    const audio = await readFile(outputPath);
    if (audio.length === 0) {
      throw new Error("Piper generó un archivo de audio vacío");
    }
    return audio;
  } finally {
    await rm(outputPath, { force: true });
  }
}

export async function synthesizeBulletinSpeech(text: string): Promise<Buffer> {
  const provider = configuredProvider();
  const piperAvailable = await isPiperAvailable();

  if (provider === "piper" && !piperAvailable) {
    const { python, modelPath } = piperConfig();
    throw new Error(
      `Piper está configurado pero no disponible (${python}, ${modelPath})`,
    );
  }

  if (provider === "piper" || (provider === "auto" && piperAvailable)) {
    logger.info({ provider: "piper" }, "Generando voz del boletín");
    return synthesizeWithPiper(text);
  }

  logger.info({ provider: "openai" }, "Generando voz del boletín");
  return textToSpeech(text, "alloy", "wav");
}