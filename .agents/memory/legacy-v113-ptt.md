---
name: Protocolo PTT de eQSO v1.13
description: Secuencia de control del servidor original necesaria para que el cliente de escritorio transmita más de una vez.
---

El servidor original divide el inicio PTT así: tras el primer bloque GSM completo envía sólo `06`; tras el segundo envía `<nameLen><name>` y el USER_UPDATE iniciado en una escritura. Nunca responder entre `01` y sus 198 bytes: v1.13 pasa a enviar silencio. Tras `0d`, responde una vez con `08` y, unos 100 ms después, `06 00` + USER_UPDATE liberado.

**Why:** Capturas comparativas demostraron que v1.13 sólo transmite una vez cuando la secuencia o el tráfico de reposo difieren del original. Responder demasiado pronto produjo bloques de silencio digital. Además, reenviar a v1.13 los `02` que cada relay genera cada 150 ms creó una tasa 15 veces superior a la original y lo mantuvo ocupado tras soltar PTT.

**How to apply:** Para `0a78000000`, replicar el inicio dividido entre bloques 1 y 2, procesar sólo el primer `0d` y limitar los `02` procedentes de relays a uno cada 3 segundos; no eliminarlos por completo. No cambiar el tráfico de gateways `0a82`.