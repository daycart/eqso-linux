---
name: Reconexión de radioenlaces
description: Regla para recuperar automáticamente un indicativo de relay bloqueado por una sesión TCP anterior.
---

Un radioenlace `0R-` que se reconecta con un token válido debe sustituir
automáticamente cualquier sesión anterior con el mismo indicativo. Los clientes
normales continúan rechazando nombres duplicados.

**Why:** Una conexión TCP medio abierta podía permanecer registrada en el
servidor después de que Windows detectara la desconexión. Los reintentos eran
rechazados como “indicativo ya en uso” hasta que un administrador expulsaba
manualmente la sesión antigua.

**How to apply:** Mantener la sustitución limitada a radioenlaces autenticados y
limpiar sincrónicamente el registro de sala al cerrar administrativamente una
conexión. No ampliar esta conducta a clientes que comparten una contraseña
general.