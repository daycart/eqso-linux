---
name: Protocolo PTT de eQSO v1.13
description: Secuencia de control del servidor original necesaria para que el cliente de escritorio transmita más de una vez.
---

El servidor original divide el inicio PTT así: tras el primer bloque GSM completo envía sólo `06`; tras el segundo envía `<nameLen><name>` y el USER_UPDATE iniciado en una escritura. Nunca responder entre `01` y sus 198 bytes: v1.13 pasa a enviar silencio. Al entregar voz a v1.13, escribir primero el opcode `01` y después los 198 bytes GSM en otra operación; éste es el patrón dominante en la captura del servidor original. Tras `0d`, responde una vez con `08` y, unos 100 ms después, `06 00` + USER_UPDATE liberado.

**Why:** Capturas comparativas demostraron que v1.13 sólo transmite una vez cuando la secuencia o el tráfico de reposo difieren del original. Responder demasiado pronto produjo bloques de silencio digital. Además, reenviar a v1.13 los `02` que cada relay genera cada 150 ms creó una tasa 15 veces superior a la original y lo mantuvo ocupado tras soltar PTT. Otra captura mostró 29 intervalos de audio inferiores a 20 ms y hasta control más tres bloques agrupados en 616 bytes; el relay produce ráfagas aunque el promedio sea correcto. El servidor original envía `0c` cada ~2,54 s; con 8 s v1.13 cerró limpiamente la conexión tras ~51 s.

Una captura controlada con el micrófono predeterminado de Windows produjo 141 paquetes GSM completos (16,92 s), sin huecos TCP y con framing `01` + 198 bytes. El WAV reconstruido se entiende perfectamente según el usuario. Por tanto, este flujo sirve como referencia fiable del codificador de v1.13; no volver a atribuir sus diferencias a la captura o a la selección del micrófono.

**How to apply:** Para `0a78000000`, replicar el inicio dividido entre bloques 1 y 2, separar cada salida de voz como escritura `01` seguida de escritura GSM de 198 bytes y limitarla a un bloque cada 120 ms. Audio, control y keepalive `0c` cada 2,5 s deben compartir una cola ordenada: nunca insertar control entre opcode y GSM ni liberar PTT por delante de audio pendiente. Procesar sólo el primer `0d` y filtrar los `02` procedentes de relays. No cambiar el tráfico de gateways `0a82`.