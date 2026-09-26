---
name: VM deployment policy and build order
description: El push a main no publica en la VM; se actualiza manualmente desde la propia VM con update.sh.
---

## Regla

El `push` a `main` solo deja el código disponible en GitHub; no considerar
publicada la VM hasta que el usuario ejecute allí
`bash /opt/eqso-asorapa/artifacts/api-server/install/update.sh`.
Aunque exista un workflow de despliegue por push, el SSH de la VM no está
habilitado y ese mecanismo no funciona. No intentar acceder por SSH.

**Why:** El usuario confirmó que siempre actualiza desde la propia VM; el
workflow existente puede dar una falsa impresión de despliegue automático.

**How to apply:** Tras subir cambios, proporcionar el comando local de la VM
y distinguir claramente el estado del repositorio del estado de producción.

Si se compila manualmente fuera del script, siempre en este orden en la VM:

```bash
BASE_PATH=/ pnpm --filter @workspace/eqso-client run build
pnpm --filter @workspace/api-server run build
sudo systemctl restart eqso.service
```

**Why:** `artifacts/api-server/build.mjs` copia `../eqso-client/dist/public` al directorio de estáticos del servidor. Si el cliente no se recompila primero, el navegador ejecuta el JS antiguo aunque el servidor tenga código nuevo.

**How to apply:** Cualquier cambio en `artifacts/eqso-client/` requiere compilar el cliente explícitamente. El comando `pnpm --filter @workspace/api-server run build` solo no es suficiente.
