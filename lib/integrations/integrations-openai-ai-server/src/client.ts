import OpenAI from "openai";

let client: OpenAI | undefined;

function getClient(): OpenAI {
  if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
    throw new Error(
      "AI_INTEGRATIONS_OPENAI_BASE_URL must be set. Did you forget to provision the OpenAI AI integration?",
    );
  }
  if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
    throw new Error(
      "AI_INTEGRATIONS_OPENAI_API_KEY must be set. Did you forget to provision the OpenAI AI integration?",
    );
  }
  client ??= new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  });
  return client;
}

export async function textToSpeech(
  text: string,
  voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" = "alloy",
  format: "wav" | "mp3" | "flac" | "opus" | "pcm16" = "wav",
): Promise<Buffer> {
  const response = await getClient().chat.completions.create({
    model: "gpt-audio",
    modalities: ["text", "audio"],
    audio: { voice, format },
    messages: [
      { role: "system", content: "Eres un sistema de síntesis de voz. Repite el texto recibido exactamente, sin añadir ni quitar palabras." },
      { role: "user", content: text },
    ],
  });
  const audioData = (response.choices[0]?.message as { audio?: { data?: string } } | undefined)?.audio?.data;
  if (!audioData) {
    throw new Error("La integración de audio de OpenAI no devolvió datos de audio");
  }
  const audio = Buffer.from(audioData, "base64");
  if (audio.length === 0) {
    throw new Error("La integración de audio de OpenAI devolvió un archivo vacío");
  }
  return audio;
}

export { getClient as openaiClient };