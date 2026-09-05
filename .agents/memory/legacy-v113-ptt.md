---
name: Protocolo PTT de eQSO v1.13
description: Secuencia de control del servidor original necesaria para que el cliente de escritorio transmita más de una vez.
---

El servidor eQSO original responde al primer audio del emisor con `06 <nameLen> <name>` y también le envía su propio USER_UPDATE de PTT iniciado. Tras `0d`, responde `08`, seguido de `06 00` y el USER_UPDATE de PTT liberado para ese mismo emisor.

**Why:** Capturas comparativas demostraron que v1.13 sólo transmite una vez cuando recibe `08` pero no los mensajes dirigidos al propio emisor. Contra el servidor original transmite dos veces seguidas. Por tanto, `08` no era el problema y eliminar el NUL del USER_UPDATE tampoco resolvía el bloqueo.

**How to apply:** Compatibilizar específicamente clientes v1.13 (handshake observado `0a78000000`) sin reintroducir `06 00` para gateways/relays Windows que usan otro handshake y anteriormente se desconectaban con esa secuencia.