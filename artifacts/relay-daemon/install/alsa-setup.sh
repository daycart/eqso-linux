#!/bin/sh
# Configura los niveles del mixer ALSA del CM108 tras el reset USB.
# Los niveles vuelven a los defaults del driver (puede ser 0%) con cada reset.
#
# Playback (Speaker/Headphone/PCM) al 100%: la senal del servidor llega
#   con suficiente nivel al microfono de la radio CB.
# Capture (Mic) al 0%: la salida de audio de una radio CB es nivel linea
#   (~500mV-1V), mucho mas fuerte que un microfono. 0% = 0dB = sin amplificacion.
#
# IMPORTANTE: NO silenciar ("mute") el Mic — eso bloquea la captura de audio.
#   Solo desactivar el SIDETONE (Mic Playback Switch / numid=3) que causa feedback
#   al realimentar el altavoz al microfono.

set_alsa_levels() {
    local CARD="$1"
    local LABEL="$2"
    echo "ALSA setup: configurando $LABEL"
    amixer -c "$CARD" sset "Speaker"   100% unmute 2>/dev/null && echo "  Speaker   100%" || true
    amixer -c "$CARD" sset "Headphone" 100% unmute 2>/dev/null && echo "  Headphone 100%" || true
    amixer -c "$CARD" sset "PCM"       100%         2>/dev/null && echo "  PCM       100%" || true
    # Mic a 0% (0dB, sin amplificacion) pero SIN mute — la captura debe quedar activa
    amixer -c "$CARD" sset "Mic"         0% unmute  2>/dev/null && echo "  Mic         0% unmute" || true
    amixer -c "$CARD" sset "Capture"     0% unmute  2>/dev/null && echo "  Capture     0% unmute" || true

    # Desactivar SOLO el sidetone del CM108 (Mic Playback Switch, numid=3).
    # El sidetone realimenta el audio del altavoz al microfono causando eco/feedback.
    # numid=3 = "Mic Playback Switch" en el CM108 — deshabilitar para cortar el bucle.
    amixer -c "$CARD" cset numid=3 off  2>/dev/null && echo "  Mic sidetone OFF (numid=3)" || \
    amixer -c "$CARD" sset "Mic Playback Switch" off 2>/dev/null && echo "  Mic sidetone OFF (by name)" || \
    echo "  WARN: no se pudo desactivar el sidetone del Mic (tarjeta: $CARD)"
}

# --- Intentar encontrar la tarjeta CM108/C-Media/USB Audio ---
CARD=$(aplay -l 2>/dev/null | grep -iE "CM108|C-Media|USB Audio" | head -1 | sed 's/.*card //;s/:.*//' | tr -d ' ')

if [ -n "$CARD" ]; then
    set_alsa_levels "$CARD" "tarjeta CM108 (card $CARD)"
else
    echo "ALSA setup: no se encontro tarjeta CM108 por nombre, intentando enumeracion"
    # Buscar cualquier tarjeta que no sea la integrada (hw:0)
    FOUND=0
    for i in 0 1 2 3; do
        INFO=$(amixer -c $i info 2>/dev/null | head -1)
        if [ -n "$INFO" ]; then
            echo "  Encontrada tarjeta $i: $INFO"
            set_alsa_levels "$i" "tarjeta $i"
            FOUND=1
        fi
    done
    if [ "$FOUND" = "0" ]; then
        echo "ALSA setup: no se encontro ninguna tarjeta de audio, omitiendo"
        exit 1
    fi
fi

# --- Aplicar tambien sobre la tarjeta por defecto del sistema (por si acaso) ---
echo "ALSA setup: aplicando Capture=0% unmute en tarjeta por defecto"
amixer sset "Capture" 0% unmute 2>/dev/null && echo "  default Capture 0% unmute" || true
# NO silenciar el Mic por defecto (podria afectar a otras tarjetas/servicios)

echo "ALSA setup: completado"
exit 0
