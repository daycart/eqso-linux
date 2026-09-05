---
name: User-update clásico sin terminador
description: Formato de los mensajes eQSO clásicos de salida, inicio y fin de PTT para clientes Windows antiguos.
---

Las acciones user-update distintas de join —salida, inicio PTT y fin PTT— terminan inmediatamente después del indicativo y no llevan un byte NUL adicional. La acción join sí incluye mensaje y su terminador.

**Why:** ASORAPA v1.13 recibía todos los paquetes GSM intactos, pero reproducía ruido y quedaba bloqueado después de soltar PTT. El byte NUL sobrante al final de los mensajes de control desalineaba su analizador de flujo.

**How to apply:** Al modificar constructores o analizadores del protocolo TCP eQSO clásico, mantener simétrico este límite de paquete y comprobar longitudes exactas para acciones 0, 1, 2 y 3.