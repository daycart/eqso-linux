---
name: Protocolo PTT de eQSO v1.13
description: Secuencia de control del servidor original necesaria para que el cliente de escritorio transmita más de una vez.
---

El servidor eQSO original responde al emisor con `06 <nameLen> <name>` y su propio USER_UPDATE de PTT iniciado, pero sólo después de recibir dos bloques GSM completos. Nunca se debe responder entre el opcode `01` y sus 198 bytes: hacerlo deja a v1.13 enviando bloques de silencio digital. Tras `0d`, responde una sola vez con `08`, `06 00` y el USER_UPDATE de PTT liberado; v1.13 puede repetir `0d` varias veces por una única liberación.

**Why:** Capturas comparativas demostraron que v1.13 sólo transmite una vez cuando recibe `08` pero no los mensajes dirigidos al propio emisor. Una primera implementación respondió demasiado pronto y produjo 74 bloques GSM idénticos a −66,3 dB aunque el servidor los reenviara correctamente. El servidor original confirma después del segundo bloque completo.

**How to apply:** Compatibilizar específicamente clientes v1.13 (handshake observado `0a78000000`), contar bloques GSM completos por sesión TX, confirmar al completar el segundo y procesar sólo el primer `0d`. No enviar `06 00` a gateways/relays Windows de otro handshake.