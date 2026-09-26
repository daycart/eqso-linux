---
name: Transición de tokens de radioenlace
description: Criterio para migrar indicativos 0R- que usan eQSO 1.13 a credenciales individuales sin corte previo.
---

Mantener válidos tanto el token compartido anterior (si existe) como la contraseña general del servidor para cada indicativo `0R-` hasta su primera conexión con un token individual. Crear el token no migra al indicativo. Desde la primera conexión individual, solo admitir tokens individuales para ese indicativo, aunque se revoquen todos; los demás siguen con su contraseña anterior hasta migrar.

**Why:** El cliente eQSO 1.13 solo dispone de un campo de contraseña y varios equipos físicos comparten la contraseña general del servidor, sin usar el token compartido de radioenlaces. Los equipos no se pueden actualizar simultáneamente; cortar cualquiera de las dos credenciales anteriores al crear un token dejaría equipos desconectados.

**How to apply:** Al rotar credenciales, crear primero el token nuevo, configurarlo en el cliente y confirmar la primera conexión antes de retirar la contraseña anterior. Reutilizar el valor ya configurado del servidor: nunca pedir al usuario que pegue la clave en el chat ni duplicarla en código. La revocación debe desconectar las sesiones que usan el token revocado; el operador web usa autenticación de sesión independiente.