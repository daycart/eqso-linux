/**
 * Convierte muestras PCM Int16 a Float32 con escala fija normalizada.
 *
 * Problema resuelto (v2):
 *   La versión anterior aplicaba normalización por pico POR PAQUETE (cada 160
 *   muestras = 20 ms). Esto causaba saltos bruscos de nivel en los límites de
 *   paquete: si un paquete de pausa tenía peak < MIN_PEAK (scale=1.0) y el
 *   siguiente tenía voz a 0.5 FS (scale=0.9), el salto de 0→0.9 FS en 20 ms
 *   generaba distorsión severa y voz completamente irreconocible.
 *
 * Algoritmo (escala fija):
 *   - División simple por 32768 → rango Float32 ±1.0
 *   - Sin normalización por paquete → sin discontinuidades de nivel
 *   - El GainNode del navegador (×1.5) amplifica señales débiles de forma
 *     continua y sin artefactos
 *   - Clamp ±1.0 como salvaguarda ante desbordamiento inesperado
 */
export function pcmToFloat32Normalized(pcm: Int16Array): Float32Array {
  const float32 = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    // Simple fixed scale: avoids inter-packet level jumps that made voice unintelligible.
    // GainNode in the browser provides additional 1.5× boost for quiet relay signals.
    const s = pcm[i] / 32768;
    float32[i] = s > 1 ? 1 : s < -1 ? -1 : s;
  }
  return float32;
}
