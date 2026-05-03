#!/bin/sh
# Configura los niveles del mixer ALSA tras el reset USB.
# Soporta dos generaciones de SP3002:
#   - PCM2902 (antiguo): Capture 0%  ≈ 0 dB (la radio CB ya entrega nivel línea)
#   - CM108   (nuevo):   Capture 100% ≈ +23 dB (preamp más limpio pero menos sensible)

set_alsa_levels() {
    local CARD="$1"
    local CHIP="$2"
    echo "ALSA setup: configurando tarjeta $CARD (chip=$CHIP)"

    # Playback (a la radio CB) → SIEMPRE máximo
    amixer -c "$CARD" sset "Speaker"   100% unmute 2>/dev/null && echo "  Speaker   100%" || true
    amixer -c "$CARD" sset "Headphone" 100% unmute 2>/dev/null && echo "  Headphone 100%" || true
    amixer -c "$CARD" sset "PCM"       100%         2>/dev/null && echo "  PCM       100%" || true

    # Capture (desde la radio CB) → depende del chip
    if [ "$CHIP" = "CM108" ]; then
        # CM108: poner Mic Capture al máximo (35/35 = +23 dB)
        amixer -c "$CARD" cset name='Mic Capture Volume' 35 2>/dev/null && echo "  Mic Capture Volume 35 (max)" || true
        amixer -c "$CARD" cset name='Mic Capture Switch' on 2>/dev/null && echo "  Mic Capture Switch on" || true
    else
        # PCM2902 / desconocido: 0% (sin amplificación)
        amixer -c "$CARD" sset "Mic"     0% unmute 2>/dev/null && echo "  Mic     0% unmute" || true
        amixer -c "$CARD" sset "Capture" 0% unmute 2>/dev/null && echo "  Capture 0% unmute" || true
    fi

    # CRÍTICO: apagar sidetone Mic→Speaker (numid=3 en CM108/PCM2902)
    amixer -c "$CARD" cset numid=3 off 2>/dev/null && echo "  Mic sidetone OFF (numid=3)" || \
    amixer -c "$CARD" sset "Mic Playback Switch" off 2>/dev/null && echo "  Mic sidetone OFF (by name)" || \
    echo "  WARN: no se pudo desactivar el sidetone"

    # Apagar AGC (no queremos compresión automática del audio)
    amixer -c "$CARD" sset "Auto Gain Control" off 2>/dev/null && echo "  AGC OFF" || true
}

# --- Detectar tarjeta y chip ---
CARD_INFO=$(aplay -l 2>/dev/null | grep -iE "CM108|C-Media|USB Audio|PCM2902" | head -1)
CARD=$(echo "$CARD_INFO" | sed 's/.*card //;s/:.*//' | tr -d ' ')

# Detectar chip por USB ID (CM108 = 0d8c:0014, PCM2902 = 08bb:2902)
if lsusb 2>/dev/null | grep -qi '0d8c:0014\|C-Media.*CM108'; then
    CHIP="CM108"
elif lsusb 2>/dev/null | grep -qi '08bb:2902\|PCM2902'; then
    CHIP="PCM2902"
else
    CHIP="UNKNOWN"
fi

if [ -n "$CARD" ]; then
    set_alsa_levels "$CARD" "$CHIP"
else
    echo "ALSA setup: no se encontró tarjeta USB, probando tarjeta 1"
    set_alsa_levels 1 "$CHIP"
fi

echo "ALSA setup: completado (chip detectado: $CHIP)"
exit 0
