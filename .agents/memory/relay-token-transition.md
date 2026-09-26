---
name: Transición de tokens de radioenlace
description: Criterio para migrar indicativos 0R- que usan eQSO 1.13 a credenciales individuales sin corte previo.
---

Mantener válido el token compartido para cada indicativo `0R-` hasta su primera conexión con un token individual. Desde esa conexión, solo admitir tokens individuales para ese indicativo, aunque se revoquen todos; los demás indicativos siguen con el token antiguo hasta migrar.

**Why:** El cliente eQSO 1.13 solo dispone de un campo de contraseña y los radioenlaces físicos no se pueden actualizar simultáneamente. Cortar el token compartido globalmente dejaría equipos desconectados.

**How to apply:** Al rotar credenciales, crear primero el token nuevo, configurarlo en el cliente y confirmar la primera conexión antes de revocar el anterior. La revocación debe desconectar las sesiones que usan el token revocado; el operador web usa autenticación de sesión independiente.