---
name: VM Deploy Process (asorapa.sytes.net)
description: Cómo desplegar el cliente web en la VM Ubuntu del usuario
---

El servidor `eqso.service` (Node.js) sirve los estáticos desde `artifacts/api-server/dist/public`, NO desde `/var/www/html`. Nginx hace reverse proxy a Node.js.

**Why:** El `app.ts` del api-server tiene `express.static(path.join(__dirname, "public"))` en producción. El `__dirname` resuelve a `dist/`, así que los archivos van a `dist/public/`.

**How to apply:** Al hacer deploy del cliente en la VM:
1. Build con `BASE_PATH=/ pnpm --filter @workspace/eqso-client run build`
2. `cp -r artifacts/eqso-client/dist/public/* artifacts/api-server/dist/public/`
3. Eliminar JS/CSS viejos de `api-server/dist/public/assets/` (evita que el browser los cachee)
4. `sudo systemctl restart eqso.service`
