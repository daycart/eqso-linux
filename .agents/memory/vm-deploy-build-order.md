---
name: VM deploy build order
description: En la VM, el build.mjs del api-server solo COPIA el cliente ya compilado — no lo recompila. Siempre compilar eqso-client primero.
---

## Regla

Siempre en este orden en la VM:

```bash
BASE_PATH=/ pnpm --filter @workspace/eqso-client run build
pnpm --filter @workspace/api-server run build
sudo systemctl restart eqso.service
```

**Why:** `artifacts/api-server/build.mjs` copia `../eqso-client/dist/public` al directorio de estáticos del servidor. Si el cliente no se recompila primero, el navegador ejecuta el JS antiguo aunque el servidor tenga código nuevo.

**How to apply:** Cualquier cambio en `artifacts/eqso-client/` requiere compilar el cliente explícitamente. El comando `pnpm --filter @workspace/api-server run build` solo no es suficiente.
