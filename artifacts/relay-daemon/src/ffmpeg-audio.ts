/**
 * Audio via FFmpeg — captura y reproduccion multiplataforma.
 *
 * Misma interfaz que AlsaAudio pero usa ffmpeg en lugar de arecord/aplay.
 * Compatible con Windows (DirectShow/WASAPI), Linux (ALSA/PulseAudio) y Raspberry Pi.
 *
 * Captura:  ffmpeg (dshow/alsa/pulse) → PCM S16LE 8kHz mono → GsmEncoder → EqsoClient
 * Playback: EqsoClient → GsmDecoder → PCM → upsample → ffmpeg (wasapi/alsa) → mic radio
 *
 * Half-duplex: misma logica que AlsaAudio — suspende captura al iniciar RX,
 * reanuda captura al terminar RX. Evita conflictos en tarjetas USB half-duplex.
 *
 * Formatos ffmpeg por defecto segun plataforma:
 *   Windows  → captura: dshow   | playback: wasapi
 *   Linux    → captura: alsa    | playback: alsa
 *   macOS    → captura: avfoundation | playback: coreaudio
 * Se pueden sobreescribir con "captureFormat" / "playbackFormat" en el JSON.
 */

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import { AudioConfig } from "./config.js";
import {
  GsmDecoder, GsmEncoder,
  GSM_FRAME_SAMPLES, FRAMES_PER_PACKET,
} from "./gsm-codec.js";

declare const require: NodeRequire;

const PCM_CHUNK_SAMPLES = GSM_FRAME_SAMPLES * FRAMES_PER_PACKET; // 960 muestras

// Jitter buffer: 600ms de pre-roll antes de abrir el player.
const JITTER_PRE_BUFFER_SAMPLES = 4800;

// Reproduccion a 48kHz — mas compatible con tarjetas USB que 8kHz nativo.
// El upsample se hace en Node.js (igual que AlsaAudio) para que ffmpeg reciba
// PCM a la tasa correcta sin necesidad de resampling interno.
const PLAYBACK_SAMPLE_RATE = 48000;
const UPSAMPLE_FACTOR = PLAYBACK_SAMPLE_RATE / 8000; // 6

/** Resuelve la ruta al binario ffmpeg: ffmpeg-static si esta disponible, PATH si no. */
export function resolveFfmpegBin(): string {
  try {
    const p = require("ffmpeg-static") as string | null;
    if (p) return p;
  } catch { /* usar PATH */ }
  return "ffmpeg";
}

/** Formatos ffmpeg por defecto segun la plataforma del sistema. */
function defaultFormats(): { capture: string; playback: string } {
  switch (process.platform) {
    case "win32":  return { capture: "dshow",        playback: "wasapi" };
    case "darwin": return { capture: "avfoundation", playback: "coreaudio" };
    default:       return { capture: "alsa",         playback: "alsa" };
  }
}

/**
 * Construye el argumento "-i <input>" para ffmpeg segun el formato.
 * dshow:        audio="USB Audio Device"
 * avfoundation: :<device_index> (audio-only)
 * alsa/pulse:   plughw:1,0 o nombre del device (directo)
 */
function buildCaptureInput(format: string, device: string): string {
  if (format === "dshow")        return `audio=${device}`;
  if (format === "avfoundation") return `:${device}`;
  return device;
}

/**
 * Upsample lineal de 8kHz a PLAYBACK_SAMPLE_RATE.
 * Interpolacion lineal entre muestras consecutivas para evitar aliasing.
 */
function upsample6(pcm: Int16Array): Int16Array {
  const out = new Int16Array(pcm.length * UPSAMPLE_FACTOR);
  for (let i = 0; i < pcm.length; i++) {
    const a = pcm[i];
    const b = i + 1 < pcm.length ? pcm[i + 1] : a;
    for (let j = 0; j < UPSAMPLE_FACTOR; j++) {
      out[i * UPSAMPLE_FACTOR + j] = Math.round(a + (b - a) * (j / UPSAMPLE_FACTOR));
    }
  }
  return out;
}

export class FfmpegAudio extends EventEmitter {
  private recorder: ChildProcessWithoutNullStreams | null = null;
  private player:   ChildProcessWithoutNullStreams | null = null;
  private drainPlayer: ChildProcessWithoutNullStreams | null = null;
  private drainTimer:  ReturnType<typeof setTimeout> | null = null;
  private encoder = new GsmEncoder();
  private decoder = new GsmDecoder();
  private pcmAccum  = new Int16Array(0);
  private jitterBuf = new Int16Array(0);
  private recorderSuspended = false;
  private playerStarting    = false;
  private stopping = false;
  private levelPeakRms   = 0;
  private levelClipCount = 0;
  private levelSamples   = 0;
  private levelTimer: ReturnType<typeof setInterval> | null = null;

  private readonly captureFormat: string;
  private readonly playbackFormat: string;
  private readonly ffmpegBin: string;

  constructor(private cfg: AudioConfig) {
    super();
    const defs = defaultFormats();
    this.captureFormat  = cfg.captureFormat  ?? defs.capture;
    this.playbackFormat = cfg.playbackFormat ?? defs.playback;
    this.ffmpegBin = resolveFfmpegBin();
    log(`Backend FFmpeg: bin=${this.ffmpegBin} captureFormat=${this.captureFormat} playbackFormat=${this.playbackFormat}`);
  }

  start(): void {
    this.startDecoder();
    this.startEncoder();
    this.startRecorder();
    this.levelTimer = setInterval(() => this.logLevel(), 5000);
  }

  stop(): void {
    this.stopping = true;
    if (this.levelTimer) { clearInterval(this.levelTimer); this.levelTimer = null; }
    this.stopRecorder();
    this.killDrainPlayerNow();
    if (this.player) {
      try { this.player.stdin.end(); this.player.kill("SIGTERM"); } catch { /* ignore */ }
      this.player = null;
    }
    this.encoder.stop();
    this.decoder.stop();
  }

  private rxGsmCount = 0;

  playGsm(gsm: Buffer): void {
    this.rxGsmCount++;
    if (this.rxGsmCount <= 3 || this.rxGsmCount % 50 === 0)
      log(`[playGsm] pkt#${this.rxGsmCount} len=${gsm.length} decoder_ready=${this.decoder.ready} player=${this.player ? "running" : "null"} playerStarting=${this.playerStarting}`);
    this.decoder.decode(gsm);
  }

  /**
   * Suspende la captura ffmpeg INMEDIATAMENTE al inicio del RX.
   * El jitter se acumula mientras ffmpeg cierra en paralelo.
   */
  suspendRecorderForRx(): void {
    if (this.recorderSuspended || !this.recorder) return;
    log("[audio] Semi-duplex: suspendiendo captura ffmpeg para RX (preventivo)");
    this.recorderSuspended = true;
    const rec = this.recorder;
    this.recorder = null;
    const watchdog = setTimeout(() => {
      try { rec.kill("SIGKILL"); } catch { /* ignore */ }
    }, 500);
    rec.once("close", () => clearTimeout(watchdog));
    try { rec.kill("SIGTERM"); } catch { clearTimeout(watchdog); }
  }

  endRx(): void {
    this.stopPlayer();
  }

  setTxEnabled(enabled: boolean): void {
    if (!enabled) this.pcmAccum = new Int16Array(0);
  }

  // ── Encoder (captura micro → GSM) ─────────────────────────────────────────

  private startEncoder(): void {
    this.encoder.start();
    this.encoder.on("gsm", (gsm: Buffer) => this.emit("gsm_tx", gsm));
  }

  feedPcm(pcm: Int16Array): void {
    const merged = new Int16Array(this.pcmAccum.length + pcm.length);
    merged.set(this.pcmAccum);
    merged.set(pcm, this.pcmAccum.length);
    this.pcmAccum = merged;

    this.emit("pcm_chunk", pcm);

    while (this.pcmAccum.length >= PCM_CHUNK_SAMPLES) {
      const chunk = this.pcmAccum.slice(0, PCM_CHUNK_SAMPLES);
      this.pcmAccum = this.pcmAccum.slice(PCM_CHUNK_SAMPLES);
      this.encoder.encode(chunk);
    }
  }

  // ── Decoder (GSM → playback) ───────────────────────────────────────────────

  private startDecoder(): void {
    this.decoder.start();
    this.decoder.on("pcm", (pcm: Int16Array) => this.playPcm(pcm));
  }

  private applyGain(pcm: Int16Array): Int16Array {
    const gain = this.cfg.outputGain;
    if (gain === 1.0) return pcm;
    const out = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++)
      out[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * gain)));
    return out;
  }

  private pcmChunkCount = 0;

  private playPcm(pcm: Int16Array): void {
    const samples = this.applyGain(pcm);
    this.pcmChunkCount++;

    if (!this.player || this.player.killed) {
      // Acumular en jitter buffer mientras el player no esta listo
      const merged = new Int16Array(this.jitterBuf.length + samples.length);
      merged.set(this.jitterBuf);
      merged.set(samples, this.jitterBuf.length);
      this.jitterBuf = merged;

      if (this.pcmChunkCount <= 5)
        log(`[playPcm] chunk#${this.pcmChunkCount} → jitterBuf=${this.jitterBuf.length} playerStarting=${this.playerStarting}`);

      if (this.jitterBuf.length >= JITTER_PRE_BUFFER_SAMPLES && !this.playerStarting)
        this.startPlayer();
      return;
    }

    // Upsample 8kHz → 48kHz antes de enviar al pipe de ffmpeg
    const up = upsample6(samples);
    const buf = Buffer.from(up.buffer, up.byteOffset, up.byteLength);
    try { this.player.stdin.write(buf); } catch { /* player may have closed */ }
  }

  // ── Captura ffmpeg (radio → sala) ─────────────────────────────────────────

  private startRecorder(): void {
    const input = buildCaptureInput(this.captureFormat, this.cfg.captureDevice);
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-f", this.captureFormat,
      "-i", input,
      "-f", "s16le", "-ar", "8000", "-ac", "1",
      "pipe:1",
    ];

    log(`Captura: ${this.ffmpegBin} ${args.join(" ")}`);
    this.recorder = spawn(this.ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });

    this.recorder.stderr.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) log(`[ffmpeg-cap] ${msg}`);
    });

    this.recorder.on("error", (err) => {
      log(`[ffmpeg-cap] Error: ${err.message}`);
      this.emit("error", err);
    });

    this.recorder.on("close", (code) => {
      log(`[ffmpeg-cap] Terminado (code ${code})`);
      this.recorder = null;

      if (this.playerStarting) {
        log("[audio] Captura cerrada — abriendo player");
        this.playerStarting = false;
        this.openPlayer();
        return;
      }

      if (!this.recorderSuspended && !this.stopping) {
        setTimeout(() => {
          if (!this.recorderSuspended && !this.stopping && this.recorder === null) {
            log("[audio] Reintentando captura ffmpeg...");
            this.startRecorder();
          }
        }, 2000);
      }
    });

    this.recorder.stdout.on("data", (chunk: Buffer) => {
      const gain = this.cfg.inputGain;
      const sampleCount = Math.floor(chunk.length / 2);
      const pcm = new Int16Array(sampleCount);
      let sumSq = 0;
      for (let i = 0; i < sampleCount; i++) {
        const raw = chunk.readInt16LE(i * 2);
        const drive = 1.5;
        const norm = (raw * gain) / 32768;
        const limited = Math.tanh(norm * drive) / Math.tanh(drive);
        const s = Math.round(limited * 32767);
        pcm[i] = s;
        sumSq += s * s;
        if (Math.abs(s) > 30000) this.levelClipCount++;
      }
      const rms = Math.sqrt(sumSq / sampleCount);
      if (rms > this.levelPeakRms) this.levelPeakRms = rms;
      this.levelSamples += sampleCount;
      this.feedPcm(pcm);
    });
  }

  private stopRecorder(): void {
    try { this.recorder?.kill("SIGTERM"); } catch { /* ignore */ }
    this.recorder = null;
  }

  private logLevel(): void {
    if (this.levelSamples === 0) return;
    const peakDb = this.levelPeakRms > 0
      ? (20 * Math.log10(this.levelPeakRms / 32768)).toFixed(1)
      : "-inf";
    const clipPct = ((this.levelClipCount / this.levelSamples) * 100).toFixed(2);
    const clipping = this.levelClipCount > 0
      ? ` SATURACION: ${this.levelClipCount} muestras (${clipPct}%)`
      : "";
    log(`[nivel] pico RMS=${Math.round(this.levelPeakRms)} (${peakDb} dBFS)  VOXumbral=${this.cfg.voxThresholdRms}  gain=${this.cfg.inputGain}${clipping}`);
    this.levelPeakRms   = 0;
    this.levelClipCount = 0;
    this.levelSamples   = 0;
  }

  // ── Playback ffmpeg (sala → radio) ────────────────────────────────────────

  /**
   * Inicia la secuencia semi-duplex:
   *   1. Si hay captura activa: SIGTERM + esperar cierre → openPlayer()
   *   2. Si no hay captura: openPlayer() directamente
   */
  private startPlayer(): void {
    if (this.playerStarting) return;

    if (this.recorder) {
      log("[audio] Semi-duplex: matando captura — esperando cierre para abrir player");
      this.playerStarting    = true;
      this.recorderSuspended = true;
      const rec = this.recorder;
      this.recorder = null;

      const watchdog = setTimeout(() => {
        if (this.playerStarting) {
          log("[audio] Watchdog: SIGKILL a captura (SIGTERM no respondido)");
          try { rec.kill("SIGKILL"); } catch { /* ignore */ }
        }
      }, 800);

      rec.once("close", () => clearTimeout(watchdog));
      try { rec.kill("SIGTERM"); } catch {
        clearTimeout(watchdog);
        this.playerStarting = false;
        this.openPlayer();
      }
    } else {
      this.openPlayer();
    }
  }

  private openPlayer(): void {
    if (this.stopping) return;

    if (this.drainPlayer) {
      const old = this.drainPlayer;
      if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = null; }
      this.drainPlayer    = null;
      this.playerStarting = true;
      log("[audio] openPlayer: SIGKILL a player anterior — esperando cierre para liberar device");
      try { old.stdin.end(); old.kill("SIGKILL"); } catch { /* ignore */ }
      old.once("close", () => {
        this.playerStarting = false;
        this.doOpenPlayer();
      });
      return;
    }

    this.doOpenPlayer();
  }

  private doOpenPlayer(): void {
    if (this.stopping) return;

    const args = [
      "-hide_banner", "-loglevel", "error",
      "-f", "s16le", "-ar", String(PLAYBACK_SAMPLE_RATE), "-ac", "1",
      "-i", "pipe:0",
      "-f", this.playbackFormat,
      this.cfg.playbackDevice,
    ];

    log(`Playback: ${this.ffmpegBin} ${args.join(" ")}`);
    this.player = spawn(this.ffmpegBin, args, { stdio: ["pipe", "ignore", "pipe"] });
    const p = this.player;

    p.stderr.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) log(`[ffmpeg-play] ${msg}`);
    });

    p.on("error", (err) => log(`[ffmpeg-play] Error: ${err.message}`));

    p.on("close", (code) => {
      log(`[ffmpeg-play] Terminado (code ${code})`);
      if (this.player === p) {
        this.player = null;
        if (this.recorderSuspended && !this.stopping && !this.playerStarting && !this.drainPlayer) {
          this.recorderSuspended = false;
          log("[audio] Semi-duplex: reanudando captura (player cerrado inesperadamente)");
          this.startRecorder();
        }
      }
    });

    if (this.jitterBuf.length > 0) {
      const up = upsample6(this.jitterBuf);
      const buf = Buffer.from(up.buffer, up.byteOffset, up.byteLength);
      try { p.stdin.write(buf); } catch { /* ignore */ }
      this.jitterBuf = new Int16Array(0);
    }
  }

  private stopPlayer(): void {
    if (this.jitterBuf.length > 0 && this.player && !this.player.killed) {
      const up = upsample6(this.jitterBuf);
      const buf = Buffer.from(up.buffer, up.byteOffset, up.byteLength);
      try { this.player.stdin.write(buf); } catch { /* ignore */ }
      this.jitterBuf = new Int16Array(0);
    }

    if (this.player) {
      const p = this.player;
      this.player = null;
      this.killDrainPlayerNow();

      this.drainPlayer = p;
      try { p.stdin.end(); } catch { /* ignore */ }

      this.drainTimer = setTimeout(() => {
        this.drainTimer = null;
        if (this.drainPlayer === p)
          try { p.kill("SIGTERM"); } catch { /* ignore */ }
      }, 300);

      p.once("close", () => {
        if (this.drainTimer && this.drainPlayer === p) {
          clearTimeout(this.drainTimer);
          this.drainTimer = null;
        }
        if (this.drainPlayer === p) {
          this.drainPlayer = null;
          if (this.recorderSuspended && !this.stopping && !this.player && !this.playerStarting) {
            this.recorderSuspended = false;
            log("[audio] Semi-duplex: reanudando captura");
            this.startRecorder();
          }
        }
      });

    } else if (this.recorderSuspended && !this.stopping && !this.playerStarting && !this.drainPlayer) {
      this.recorderSuspended = false;
      log("[audio] Semi-duplex: reanudando captura (player ya cerrado)");
      this.startRecorder();
    }
  }

  private killDrainPlayerNow(): void {
    if (this.drainPlayer) {
      if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = null; }
      const p = this.drainPlayer;
      this.drainPlayer = null;
      try { p.stdin.end(); p.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }
}

function log(msg: string): void {
  console.log(`[audio-ffmpeg] ${new Date().toISOString()} ${msg}`);
}
