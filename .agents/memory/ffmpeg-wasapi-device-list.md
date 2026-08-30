---
name: Audio de entrada y salida en Windows
description: DirectShow para captura y FFplay/SDL para reproducción en el relay Windows.
---
En Windows, el backend del relay captura mediante DirectShow (`dshow`) y reproduce PCM mediante FFplay/SDL. No usar `-f wasapi` como salida de FFmpeg: WASAPI es un dispositivo de entrada, no un muxer de salida. Los nombres de reproducción se consultan en los endpoints de audio de Windows y FFplay los recibe mediante `SDL_AUDIO_DEVICE_NAME`.

**Why:** La configuración `playbackFormat: "wasapi"` generaba un comando de salida inválido que podía dejar el relay conectado pero sin audio hacia la radio.

**How to apply:** Obtener la entrada con DirectShow y los altavoces con `Get-PnpDevice -Class AudioEndpoint`; usar `captureFormat: "dshow"` y `playbackFormat: "ffplay"`. En VirtualBox no abrir dispositivos ni iniciar el relay durante la instalación: registrar la tarea desactivada y probar después de forma explícita.

## Limitacion de VirtualBox

Con la Sound Blaster pasada por USB a una VM, la captura DirectShow funciona mientras el relay esta activo, pero VirtualBox puede perder la integracion del raton al cerrar el proceso de audio. Esto no se reproduce como un fallo de instalacion.

**Why:** La perdida ocurre incluso con `ffmpeg-static` y despues de esperar al cierre de Node; por tanto, el problema esta en la liberacion del dispositivo USB/audio del hipervisor, no en la seleccion del binario ni en el JSON.

**How to apply:** Usar la VM solo para validar instalacion y configuracion. Validar el ciclo completo de audio y el autoinicio en un Windows fisico, o con una VM sin passthrough USB de la Sound Blaster.