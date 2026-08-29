---
name: Dispositivos WASAPI en Windows
description: Descubrimiento de los nombres de entrada y salida de audio para el relay Windows con ffmpeg-static.
---
En Windows, el backend del relay captura mediante DirectShow (`dshow`) y reproduce mediante WASAPI como formato de salida. En la compilación ffmpeg-static usada por el relay, `wasapi` no funciona como formato de entrada para `-list_devices true -i dummy`; los nombres de reproducción deben consultarse en los endpoints de audio de Windows.

**Why:** Intentar listar WASAPI como una entrada produce `Unknown input format: wasapi` y puede confundirse con un problema de instalación o del controlador.

**How to apply:** Obtener la entrada con DirectShow y los altavoces con `Get-PnpDevice -Class AudioEndpoint`; copiar los nombres exactos a `captureDevice` y `playbackDevice`.