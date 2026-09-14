---
name: Git push desde Replit
description: Quirk de autenticación Git cuando la GitHub App está conectada pero el helper automático entrega una credencial inválida.
---

La GitHub App puede quedar conectada y con permisos de escritura mientras `replit-git-askpass` sigue entregando una credencial que GitHub rechaza. En ese caso, configurar `credential.helper` para leer `GH_PUSH_TOKEN` en tiempo de ejecución, sin guardar ni imprimir su valor.

**Why:** En este workspace, la API del conector confirmó permiso `push`, pero el helper automático produjo `Invalid username or token`; la credencial `GH_PUSH_TOKEN` sí permitió un `git push --dry-run`.

**How to apply:** Ante ese patrón exacto, comprobar primero permisos con el conector y luego hacer que el helper local devuelva `username=token` y `password=$GH_PUSH_TOKEN`. Mantener la referencia a la variable, nunca el token expandido.