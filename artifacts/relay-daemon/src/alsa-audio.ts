/**
 * Audio ALSA — captura y reproduccion via arecord / aplay.
 *
 * Captura:  arecord → PCM S16LE 8kHz mono → GsmEncoder → EqsoClient
 * Playback: EqsoClient → GsmDecoder → PCM → aplay
 *
 * El CM108 USB es half-duplex: solo puede capturar O reproducir en el mismo
 * dispositivo ALSA, no simultaneamente. Semi-duplex implementado:
 *   1. Al iniciar RX: kill arecord → esperar cierre ('close') → abrir aplay
 *   2. Al terminar RX: stdin.end() + mover a drainPlayer (300ms → SIGTERM)
 *
 * Estado del player:
 *   this.player      — aplay activo aceptando audio
 *   this.drainPlayer — aplay drenando (stdin cerrado, esperando vaciado buffer)
 *
 * Al abrir nuevo aplay: si drainPlayer sigue vivo → SIGKILL + esperar close real
 * antes de lanzar el nuevo. Evita "Device or resource busy".
 *
 * El PCM recibido durante la espera se acumula en jitterBuf.
 */

import { spawn, spawnSync, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import { AudioConfig } from "./config.js";
import {
  GsmDecoder, GsmEncoder,
  GSM_FRAME_SAMPLES, FRAMES_PER_PACKET, GSM_PACKET_BYTES,
} from "./gsm-codec.js";

// Frame GSM de silencio precomputado: se genera UNA vez al cargar el modulo
// codificando 160 muestras PCM nulas a traves de ffmpeg. Se usa en el
// tx-keepalive timer para rellenar gaps del CM108 sin pasar por ffmpeg
// (ffmpeg hace batching interno que impide el flush frame a frame).
function computeGsmSilenceFrame(): Buffer {
  const pcm = Buffer.alloc(GSM_FRAME_SAMPLES * 2, 0); // 320 bytes de silencio PCM S16LE
  try {
    const r = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "quiet",
      "-f", "s16le", "-ar", "8000", "-ac", "1",
      "-i", "pipe:0",
      "-f", "gsm", "-ar", "8000",
      "pipe:1",
    ], { input: pcm, encoding: "buffer", timeout: 5000 });
    if (r.stdout && r.stdout.length >= GSM_PACKET_BYTES) {
      console.log(`[audio] GSM silence precomputado: ${r.stdout.slice(0, GSM_PACKET_BYTES).toString("hex")}`);
      return r.stdout.slice(0, GSM_PACKET_BYTES) as Buffer;
    }
    console.error(`[audio] GSM silence: ffmpeg devolvio ${r.stdout?.length ?? 0} bytes (esperado ${GSM_PACKET_BYTES})`);
  } catch (e) {
    console.error(`[audio] GSM silence: fallo precomputo: ${e}`);
  }
  // Fallback de emergencia: frame vacio (no deberia ocurrir)
  return Buffer.alloc(GSM_PACKET_BYTES, 0);
}
const GSM_SILENCE_FRAME = computeGsmSilenceFrame();

const PCM_CHUNK_SAMPLES = GSM_FRAME_SAMPLES * FRAMES_PER_PACKET; // 160 muestras = 320 bytes (1 frame GSM)

// Jitter buffer para RX: acumula muestras antes de abrir aplay.
// 1920 = 2 paquetes = 240ms. Permite absorber variaciones de timing al arrancar.
const JITTER_PRE_BUFFER_SAMPLES = 1920;

// Silencio inyectado si no llega audio en SILENCE_THRESHOLD_MS ms.
// Mantiene el buffer DMA de aplay no vacío y evita underruns por jitter de red.
const SILENCE_THRESHOLD_MS  = 100; // ms sin audio → inyectar silencio
const SILENCE_INJECT_BYTES  = 1920; // 960 muestras × 2 bytes = 120ms a 8kHz S16LE

export class AlsaAudio extends EventEmitter {
  private recorder: ChildProcessWithoutNullStreams | null = null;
  private player:   ChildProcessWithoutNullStreams | null = null;
  // Player siendo drenado (stdin cerrado, esperando vaciado del buffer ALSA)
  private drainPlayer: ChildProcessWithoutNullStreams | null = null;
  private drainTimer:  ReturnType<typeof setTimeout> | null = null;
  private encoder = new GsmEncoder();
  private decoder = new GsmDecoder();
  private pcmAccum  = new Int16Array(0);
  private jitterBuf = new Int16Array(0);
  // Semi-duplex state
  private recorderSuspended = false;
  private playerStarting    = false; // true mientras esperamos cierre de arecord o drain aplay
  private stopping = false;
  // Metricas de nivel en captura
  private levelPeakRms   = 0;
  private levelClipCount = 0;
  private levelSamples   = 0;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  // Inyeccion de silencio: previene underruns de aplay cuando hay gaps de red
  private silenceTimer:      ReturnType<typeof setInterval> | null = null;
  private lastAudioWriteMs = 0;
  // Diagnostico arecord: log tamaño de los primeros chunks (verifica period=160)
  private arecordChunkCount = 0;
  private lastArecordChunkMs = 0;
  // Jitter buffer de captura: absorbe las rafagas periodicas del CM108 USB y
  // entrega PCM al encoder GSM a ritmo constante de 20ms via captureTimer.
  // El CM108 batch-entrega ~750ms de audio cada segundo (firmware USB); sin
  // este buffer el encoder recibe rafagas y produce GSM bursty no transmisible.
  private captureRingBuf: Int16Array = new Int16Array(0);
  private captureTimer: ReturnType<typeof setInterval> | null = null;
  // TX keepalive: rellena los gaps del CM108 con GSM_SILENCE_FRAME sin pasar
  // por ffmpeg (ffmpeg hace batching interno → frames de silencio llegan en
  // rafaga en lugar de cada 20ms → servidor desconecta con "Indicativo invalido").
  // El timer chequea cada 5ms si han pasado >20ms sin frame GSM emitido; si es
  // asi, emite directamente el frame de silencio precomputado.
  private txActive = false;
  private txKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastGsmEmitMs = 0;

  constructor(private cfg: AudioConfig) {
    super();
  }

  start(): void {
    this.startDecoder();
    this.startEncoder();
    this.startRecorder();
    this.startCaptureTimer();
    this.levelTimer = setInterval(() => this.logLevel(), 5000);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.captureTimer) { clearInterval(this.captureTimer); this.captureTimer = null; }
    this.captureRingBuf = new Int16Array(0);
    if (this.levelTimer) { clearInterval(this.levelTimer); this.levelTimer = null; }
    this.stopTxKeepalive();
    this.stopSilenceInjection();

    // Esperar a que arecord muera de verdad antes de salir.
    // Sin este await, node hace process.exit() mientras arecord sigue corriendo
    // y el proceso queda huerfano (ppid=1) bloqueando el dispositivo ALSA en
    // el siguiente arranque del servicio ("Device or resource busy").
    if (this.recorder) {
      const rec = this.recorder;
      this.recorder = null;
      await new Promise<void>((resolve) => {
        const sigkill = setTimeout(() => {
          try { rec.kill("SIGKILL"); } catch { /* ignore */ }
        }, 800);
        const timeout = setTimeout(resolve, 1500);
        rec.once("close", () => {
          clearTimeout(sigkill);
          clearTimeout(timeout);
          resolve();
        });
        try { rec.kill("SIGTERM"); } catch { resolve(); }
      });
    }

    // drainPlayer: ya estaba vaciando, SIGKILL es seguro (ya no escribe activamente)
    this.killDrainPlayerNow();

    if (this.player) {
      const p = this.player;
      this.player = null;
      // Shutdown graceful de aplay:
      //   1. Cerrar stdin → aplay vacia su buffer DMA y sale limpiamente
      //   2. Tras 500ms, SIGTERM si aun sigue vivo
      //   3. Tras 1500ms, continuar de todas formas (timeout de seguridad)
      // Esto evita el D-state: el D-state ocurre cuando SIGKILL interrumpe una
      // escritura DMA USB a mitad. Si esperamos a que aplay termine la escritura
      // por si mismo (cerrando stdin), no hay D-state.
      await new Promise<void>((resolve) => {
        const sigterm = setTimeout(() => {
          try { p.kill("SIGTERM"); } catch { /* ignore */ }
        }, 500);
        const timeout = setTimeout(resolve, 1500);
        p.once("close", () => {
          clearTimeout(sigterm);
          clearTimeout(timeout);
          resolve();
        });
        try { p.stdin.end(); } catch { /* ignore */ }
      });
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

  endRx(): void {
    this.stopPlayer();
  }

  setTxEnabled(enabled: boolean): void {
    this.txActive = enabled;
    if (enabled) {
      // Inicializar timestamp para que el keepalive no dispare silencio
      // durante los primeros 20ms (deja tiempo al ring buffer para alimentar
      // el encoder con audio real antes de que entre el relleno de silencio).
      this.lastGsmEmitMs = Date.now();
      this.startTxKeepalive();
    } else {
      this.stopTxKeepalive();
      this.pcmAccum    = new Int16Array(0);
      // Descartar audio pendiente: la TX ha terminado, no enviar mas silencio
      this.captureRingBuf = new Int16Array(0);
    }
  }

  // TX keepalive: emite GSM_SILENCE_FRAME directamente (sin pasar por ffmpeg)
  // para rellenar los gaps del CM108. ffmpeg hace batching interno y NO hace
  // flush frame a frame aunque se usen -avioflags direct/-fflags +flush_packets,
  // por lo que el approach de inyectar silencio via encoder no funciona.
  private startTxKeepalive(): void {
    if (this.txKeepaliveTimer) return;
    this.txKeepaliveTimer = setInterval(() => {
      if (!this.txActive) return;
      const now = Date.now();
      // Si han pasado > 20ms sin emitir un frame GSM, rellenar con silencio.
      // Se emite UN frame por tick para mantener la cadencia de 20ms.
      if (now - this.lastGsmEmitMs >= 20) {
        this.lastGsmEmitMs = now;
        this.emit("gsm_tx", GSM_SILENCE_FRAME);
      }
    }, 5); // resolucion 5ms para no sobrepasar los 20ms
  }

  private stopTxKeepalive(): void {
    if (this.txKeepaliveTimer) {
      clearInterval(this.txKeepaliveTimer);
      this.txKeepaliveTimer = null;
    }
  }

  // ── Encoder (micro → GSM) ─────────────────────────────────────────────────

  private startEncoder(): void {
    this.encoder.start();
    this.encoder.on("gsm", (gsm: Buffer) => {
      // Actualizar timestamp: el keepalive solo rellena si NO hay audio real
      this.lastGsmEmitMs = Date.now();
      this.emit("gsm_tx", gsm);
    });
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

  // ── Decoder (GSM → aplay) ────────────────────────────────────────────────

  private startDecoder(): void {
    this.decoder.start();
    this.decoder.on("pcm", (pcm: Int16Array) => {
      this.playPcm(pcm);
    });
  }

  private applyGain(pcm: Int16Array): Int16Array {
    const gain = this.cfg.outputGain;
    if (gain === 1.0) return pcm;
    const out = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      out[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * gain)));
    }
    return out;
  }

  private pcmChunkCount = 0;

  private playPcm(pcm: Int16Array): void {
    const samples = this.applyGain(pcm);
    this.pcmChunkCount++;

    if (!this.player || this.player.killed) {
      const merged = new Int16Array(this.jitterBuf.length + samples.length);
      merged.set(this.jitterBuf);
      merged.set(samples, this.jitterBuf.length);
      this.jitterBuf = merged;

      if (this.pcmChunkCount <= 5)
        log(`[playPcm] chunk#${this.pcmChunkCount} → jitterBuf=${this.jitterBuf.length} playerStarting=${this.playerStarting}`);

      if (this.jitterBuf.length >= JITTER_PRE_BUFFER_SAMPLES && !this.playerStarting) {
        this.startPlayer();
      }
      return;
    }

    if (this.pcmChunkCount <= 5)
      log(`[playPcm] chunk#${this.pcmChunkCount} → escribiendo ${samples.length} muestras a aplay stdin`);
    const buf = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    try {
      this.player?.stdin.write(buf);
      this.lastAudioWriteMs = Date.now();
    } catch { /* player may have closed */ }
  }

  // ── Jitter buffer de captura ─────────────────────────────────────────────

  /**
   * Timer que consume el captureRingBuf a ritmo constante (20ms = 160 muestras).
   * El CM108 USB entrega audio en rafagas periodicas (~750ms); este timer
   * distribuye las rafagas uniformemente antes de entregarlas al encoder GSM.
   * Resultado: encoder recibe 1 frame cada 20ms → GSM output sin gaps.
   *
   * Latencia adicional introducida: hasta ~750ms (tamano maximo de la rafaga).
   * Aceptable para radio PTT donde la latencia total ya supera 1-2 segundos.
   *
   * Log de diagnostico: si el ring buffer supera 3200 muestras (400ms de audio
   * acumulado) se registra un aviso para detectar deriva del timer.
   */
  private startCaptureTimer(): void {
    if (this.captureTimer) clearInterval(this.captureTimer);
    const WARN_SAMPLES = 3200; // 400ms a 8kHz → posible deriva del timer
    this.captureTimer = setInterval(() => {
      if (this.captureRingBuf.length >= PCM_CHUNK_SAMPLES) {
        if (this.captureRingBuf.length > WARN_SAMPLES)
          log(`[captureTimer] ring buffer alto: ${this.captureRingBuf.length} muestras (${(this.captureRingBuf.length / 8).toFixed(0)}ms)`);
        const chunk = this.captureRingBuf.slice(0, PCM_CHUNK_SAMPLES);
        this.captureRingBuf = this.captureRingBuf.slice(PCM_CHUNK_SAMPLES);
        this.feedPcm(chunk);
      }
      // Nota: el relleno de silencio durante gaps del CM108 ya NO se hace aqui.
      // El txKeepaliveTimer emite GSM_SILENCE_FRAME directamente sin pasar por
      // ffmpeg (que hace batching interno e impide el flush frame a frame).
    }, 20); // 20ms = 160 muestras a 8kHz
  }

  // ── arecord ───────────────────────────────────────────────────────────────

  // ── USB audio reset (CM108 VirtualBox) ──────────────────────────────────
  /**
   * Recarga el driver snd_usb_audio para recuperar el CM108 tras aplay.
   * En VirtualBox, cerrar aplay corrompe el estado USB interno del driver,
   * haciendo que arecord falle con 'Unable to install hw params'. El reload
   * resetea el estado y permite reiniciar arecord correctamente.
   * El servicio corre como root (sin User= en .service) → modprobe directo.
   */
  private resetUsbAudio(): Promise<void> {
    return new Promise<void>((resolve) => {
      log('[audio] USB reset: modprobe -r snd_usb_audio...');
      const unload = spawn('modprobe', ['-r', 'snd_usb_audio']);
      unload.on('error', (e: Error) => {
        log('[audio] USB reset: error en modprobe -r: ' + e.message);
        resolve();
      });
      unload.on('close', (code: number | null) => {
        log('[audio] USB reset: descargado (code ' + code + '), recargando...');
        const load = spawn('modprobe', ['snd_usb_audio']);
        load.on('error', (e: Error) => {
          log('[audio] USB reset: error en modprobe load: ' + e.message);
          resolve();
        });
        load.on('close', (code2: number | null) => {
          log('[audio] USB reset: cargado (code ' + code2 + '), esperando 1.5s...');
          setTimeout(resolve, 1500);
        });
      });
    });
  }


  private startRecorder(): void {
    // ─── ESTRATEGIA DE CAPTURA: 48kHz nativo + decimación ×6 en Node.js ───────
    //
    // El CM108 opera nativamente a 48kHz. Si se pide 8kHz a plughw:, el plugin
    // de rate conversion de ALSA acumula muestras a 48kHz y las entrega en
    // bloques grandes → GAP de ~750ms irremediable desde user-space.
    //
    // Solución: capturar a 48kHz (tasa nativa del CM108, sin pasar por el rate
    // plugin) con period=960 muestras (20ms). ALSA entrega chunks cada 20ms
    // reales. Node.js decima ×6 aplicando un filtro FIR box de 6 coeficientes
    // (promedio) como anti-aliasing antes de entregar 8kHz al codificador GSM.
    //
    // Comparativa de estrategias probadas:
    //   1. plughw: + arecord a 8kHz    → GAP 750ms (rate-plugin batching)
    //   2. plughw: + ffmpeg a 8kHz     → GAP 750ms (misma capa)
    //   3. hw: + arecord a 48kHz -c2   → error "Channels count non available"
    //   4. hw: + arecord a 48kHz -c1   → GAP 2300ms + crashes I/O
    //   5. hw: + arecord a 8kHz  -c1   → GAP 750ms + crashes I/O
    //   6. plughw: + arecord a 48kHz + buffer=3840 (4×period) → chunks ~20ms ← ACTUAL
    //
    // nrpacks=1 no disponible en este kernel (confirmado: no expone el parámetro).
    // ──────────────────────────────────────────────────────────────────────────
    const captureDevice = this.cfg.captureDevice;   // plughw:1,0 / plughw:Device,0
    const CAPTURE_RATE = 48000;    // tasa nativa del CM108 → sin rate-plugin ALSA
    const CAPTURE_CHANNELS = 1;
    const PERIOD_FRAMES = 960;     // 20ms a 48kHz = 160 muestras a 8kHz tras decimación
    const BUFFER_FRAMES = 48000;   // 1s — necesario para absorber xruns del CM108 en VirtualBox sin crash
    const DECIMATE = 6;            // 48kHz ÷ 6 = 8kHz (para GSM)

    const args = [
      "-D", captureDevice,
      "-f", "S16_LE",
      "-r", String(CAPTURE_RATE),
      "-c", String(CAPTURE_CHANNELS),
      "-q",
      `--period-size=${PERIOD_FRAMES}`,
      `--buffer-size=${BUFFER_FRAMES}`,
    ];

    log(`arecord ${args.join(" ")}`);
    this.recorder = spawn("arecord", args, { stdio: ["ignore", "pipe", "pipe"] });

    this.recorder.stderr.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) log(`[arecord] ${msg}`);
    });

    this.recorder.on("error", (err) => {
      log(`[arecord] Error: ${err.message}`);
      this.emit("error", err);
    });

    this.recorder.on("close", (code) => {
      log(`[arecord] Terminado (code ${code})`);
      this.recorder = null;

      if (this.playerStarting) {
        log("[audio] captura cerrada — abriendo aplay");
        this.playerStarting = false;
        this.openPlayer();
        return;
      }

      if (!this.recorderSuspended && !this.stopping) {
        setTimeout(() => {
          if (!this.recorderSuspended && !this.stopping && this.recorder === null) {
            this.emit("recorder_restarted");
            this.startRecorder();
          }
        }, 2000);
      }
    });

    // Buffer acumulador para decimación entre chunks de pipe (chunk puede partir un frame estéreo)
    let accumBuf = Buffer.alloc(0);

    this.recorder.stdout.on("data", (rawChunk: Buffer) => {
      // Acumular datos hasta tener frames completos alineados a DECIMATE×channels
      accumBuf = Buffer.concat([accumBuf, rawChunk]);

      // Cada frame mono = 1 canal × 2 bytes = 2 bytes
      // Cada grupo de DECIMATE frames = 2 × DECIMATE = 12 bytes → produce 1 muestra mono 8kHz
      const BYTES_PER_STEREO_FRAME = CAPTURE_CHANNELS * 2;
      const BYTES_PER_DECIMATE_GROUP = BYTES_PER_STEREO_FRAME * DECIMATE; // 12 bytes (mono)

      const numOutputSamples = Math.floor(accumBuf.length / BYTES_PER_DECIMATE_GROUP);
      if (numOutputSamples === 0) return;

      const consumedBytes = numOutputSamples * BYTES_PER_DECIMATE_GROUP;

      this.arecordChunkCount++;
      const now = Date.now();
      const gain = this.cfg.inputGain;

      // Diagnóstico primeros 8 chunks: confirmar period=960@48kHz → ~1920 bytes → 160 muestras@8kHz
      if (this.arecordChunkCount <= 8)
        log(`[arecord] chunk#${this.arecordChunkCount}: ${rawChunk.length} bytes brutos → ${numOutputSamples} muestras 8kHz (decimate×${DECIMATE})`);

      const gapMs = this.lastArecordChunkMs > 0 ? now - this.lastArecordChunkMs : 0;
      if (gapMs > 50)
        log(`[arecord] GAP ${gapMs}ms (chunk#${this.arecordChunkCount}, ${numOutputSamples} muestras)`);
      this.lastArecordChunkMs = now;

      // Ganancia + FIR box anti-aliasing + soft-clip
      // FIR box: promedia DECIMATE muestras antes de decimar → evita aliasing.
      // Para DECIMATE=1 (compatibilidad) el bucle interno corre 1 vez = sin overhead.
      const pcm = new Int16Array(numOutputSamples);
      let sumSq = 0;
      const drive = 1.5;
      const BYTES_PER_SAMPLE = CAPTURE_CHANNELS * 2; // 2 bytes mono
      for (let i = 0; i < numOutputSamples; i++) {
        const base = i * BYTES_PER_DECIMATE_GROUP;
        // Promedio de DECIMATE muestras (FIR box)
        let sum = 0;
        for (let d = 0; d < DECIMATE; d++) {
          sum += accumBuf.readInt16LE(base + d * BYTES_PER_SAMPLE);
        }
        const mono = sum / DECIMATE;
        const norm = (mono * gain) / 32768;
        const limited = Math.tanh(norm * drive) / Math.tanh(drive);
        const s = Math.round(limited * 32767);
        pcm[i] = s;
        sumSq += s * s;
        if (Math.abs(s) > 30000) this.levelClipCount++;
      }

      // Conservar bytes no consumidos para el siguiente chunk
      accumBuf = accumBuf.subarray(consumedBytes);

      // Metricas de nivel (se calculan aqui sobre audio crudo, antes del jitter buffer)
      const rms = Math.sqrt(sumSq / numOutputSamples);
      if (rms > this.levelPeakRms) this.levelPeakRms = rms;
      this.levelSamples += numOutputSamples;

      // Encolar en el jitter buffer de captura en lugar de llamar feedPcm directamente.
      // El captureTimer consumira el ring buffer a ritmo constante de 20ms,
      // distribuyendo uniformemente las rafagas periodicas del CM108.
      const merged = new Int16Array(this.captureRingBuf.length + pcm.length);
      merged.set(this.captureRingBuf);
      merged.set(pcm, this.captureRingBuf.length);
      this.captureRingBuf = merged;
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
    const clipping = this.levelClipCount > 0 ? ` SATURACION: ${this.levelClipCount} muestras (${clipPct}%)` : "";
    log(`[nivel] pico RMS=${Math.round(this.levelPeakRms)} (${peakDb} dBFS)  VOXumbral=${this.cfg.voxThresholdRms}  gain=${this.cfg.inputGain}${clipping}`);
    this.levelPeakRms   = 0;
    this.levelClipCount = 0;
    this.levelSamples   = 0;
  }

  // ── aplay ────────────────────────────────────────────────────────────────

  /**
   * Inicia la secuencia semi-duplex:
   *   1. Si hay arecord corriendo: SIGTERM + esperar 'close' (async)
   *   2. Cuando arecord cierra: openPlayer()
   *   3. Si no hay arecord: openPlayer() directamente
   */
  private startPlayer(): void {
    if (this.playerStarting) return;

    if (this.recorder) {
      log("[audio] Semi-duplex: matando arecord — esperando cierre para abrir aplay");
      this.playerStarting    = true;
      this.recorderSuspended = true;
      // Descartar audio pendiente en el jitter buffer: estamos entrando en modo
      // RX (playback), el audio capturado ya no debe llegar al encoder GSM.
      this.captureRingBuf = new Int16Array(0);
      const rec = this.recorder;
      this.recorder = null;

      const watchdog = setTimeout(() => {
        if (this.playerStarting) {
          log("[audio] Watchdog: SIGKILL a arecord (SIGTERM no respondido)");
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

  /**
   * Comprueba si el drainPlayer todavia esta vivo. Si es asi, lo mata con
   * SIGKILL y espera el cierre real antes de abrir el nuevo aplay.
   * Esto garantiza que el dispositivo ALSA este libre (evita "Device or
   * resource busy").
   */
  private openPlayer(): void {
    if (this.stopping) return;

    if (this.drainPlayer) {
      const old = this.drainPlayer;
      if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = null; }
      this.drainPlayer   = null;
      this.playerStarting = true; // bloquear llamadas duplicadas mientras esperamos
      log("[audio] openPlayer: SIGKILL a aplay anterior — esperando cierre para liberar ALSA");
      try { old.kill("SIGKILL"); } catch { /* ignore */ }
      old.once("close", () => {
        this.playerStarting = false;
        this.doOpenPlayer();
      });
      return;
    }

    this.doOpenPlayer();
  }

  /** Abre aplay y vuelca el jitter buffer. El dispositivo ALSA debe estar libre. */
  private doOpenPlayer(): void {
    if (this.stopping) return;

    const args = [
      "-D", this.cfg.playbackDevice,
      "-f", "S16_LE",
      "-r", "8000",
      "-c", "1",
      "-q",
      "--buffer-size=4096",
      "--period-size=256",
    ];
    log(`aplay ${args.join(" ")}`);
    this.player = spawn("aplay", args, { stdio: ["pipe", "ignore", "pipe"] });
    const p = this.player;

    p.stderr.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) log(`[aplay] ${msg}`);
    });

    p.on("error", (err) => {
      log(`[aplay] Error: ${err.message}`);
    });

    p.on("close", (code) => {
      log(`[aplay] Terminado (code ${code})`);
      if (this.player === p) {
        this.player = null;
        this.stopSilenceInjection();
        // Aplay cerrado mientras seguia activo (underrun severo, etc.)
        // Reanudar arecord si corresponde.
        if (this.recorderSuspended && !this.stopping && !this.playerStarting && !this.drainPlayer) {
          this.recorderSuspended = false;
          log("[audio] Semi-duplex: reanudando arecord — reset USB CM108...");
          this.resetUsbAudio().then(() => {
            if (!this.stopping && !this.player && !this.playerStarting)
              this.startRecorder();
          });
        }
      }
    });

    if (this.jitterBuf.length > 0) {
      const buf = Buffer.from(this.jitterBuf.buffer, this.jitterBuf.byteOffset, this.jitterBuf.byteLength);
      try { p.stdin.write(buf); } catch { /* ignore */ }
      this.jitterBuf = new Int16Array(0);
    }

    // Iniciar inyeccion de silencio: rellena el buffer de aplay cuando no llegan
    // paquetes de red, evitando underruns y los silencios que producen.
    this.startSilenceInjection();
  }

  private stopPlayer(): void {
    this.stopSilenceInjection();

    if (this.jitterBuf.length > 0 && this.player && !this.player.killed) {
      const buf = Buffer.from(this.jitterBuf.buffer, this.jitterBuf.byteOffset, this.jitterBuf.byteLength);
      try { this.player.stdin.write(buf); } catch { /* ignore */ }
      this.jitterBuf = new Int16Array(0);
    }

    if (this.player) {
      const p = this.player;
      this.player = null;

      // Matar cualquier drain player previo (no puede haber dos aplay abiertos)
      this.killDrainPlayerNow();

      // Mover player actual a estado "drenando"
      this.drainPlayer = p;
      try { p.stdin.end(); } catch { /* ignore */ }

      // 300ms para que aplay vacie su buffer hardware, luego SIGTERM
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null;
        if (this.drainPlayer === p) {
          try { p.kill("SIGTERM"); } catch { /* ignore */ }
        }
      }, 300);

      // Cuando el proceso termina: limpiar estado y reanudar arecord
      p.once("close", () => {
        if (this.drainTimer && this.drainPlayer === p) {
          clearTimeout(this.drainTimer);
          this.drainTimer = null;
        }
        if (this.drainPlayer === p) {
          this.drainPlayer = null;
          if (this.recorderSuspended && !this.stopping && !this.player && !this.playerStarting) {
            this.recorderSuspended = false;
            this.emit("playback_ended"); // suppress VOX desde cierre real de aplay
            log("[audio] Semi-duplex: reanudando arecord — reset USB CM108...");
            this.resetUsbAudio().then(() => {
              if (!this.stopping && !this.player && !this.playerStarting)
                this.startRecorder();
            });
          }
        }
      });

    } else if (this.recorderSuspended && !this.stopping && !this.playerStarting && !this.drainPlayer) {
      this.recorderSuspended = false;
      this.emit("playback_ended");
      log("[audio] Semi-duplex: reanudando arecord — reset USB CM108...");
      this.resetUsbAudio().then(() => {
        if (!this.stopping && !this.player && !this.playerStarting)
          this.startRecorder();
      });
    }
  }

  // ── Inyeccion de silencio ─────────────────────────────────────────────────

  /**
   * Arranca un timer que, si no llega audio real en SILENCE_THRESHOLD_MS ms,
   * escribe silencio en aplay stdin para mantener el buffer DMA lleno.
   * Esto previene los underruns causados por jitter de red o gaps entre
   * transmisiones, que se manifestaban como silencios de hasta 2s audibles.
   */
  private startSilenceInjection(): void {
    this.stopSilenceInjection();
    this.lastAudioWriteMs = Date.now();
    this.silenceTimer = setInterval(() => {
      if (!this.player || this.player.killed) {
        this.stopSilenceInjection();
        return;
      }
      const gap = Date.now() - this.lastAudioWriteMs;
      if (gap >= SILENCE_THRESHOLD_MS) {
        const silence = Buffer.alloc(SILENCE_INJECT_BYTES, 0);
        try {
          this.player.stdin.write(silence);
          this.lastAudioWriteMs = Date.now();
        } catch {
          this.stopSilenceInjection();
        }
      }
    }, 60);
  }

  private stopSilenceInjection(): void {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  /** Mata el drainPlayer inmediatamente (SIGKILL) sin esperar. */
  private killDrainPlayerNow(): void {
    if (this.drainPlayer) {
      if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = null; }
      const p = this.drainPlayer;
      this.drainPlayer = null;
      try { p.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }
}

function log(msg: string): void { console.log(`[audio] ${new Date().toISOString()} ${msg}`); }
