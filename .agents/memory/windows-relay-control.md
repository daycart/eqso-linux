---
name: Control del relay Windows
description: Comando operativo confirmado para apagar el radioenlace CB instalado en Windows.
---

Para apagar el relay Windows `0R-WINPC`, usar exactamente:

`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\eqso-relay\stop-CB.ps1"`

No sustituirlo por `Stop-Service` ni por un comando directo de NSSM.

**Why:** El usuario confirmó que la instalación se controla mediante scripts dedicados en `C:\eqso-relay`; asumir el nombre del servicio produce instrucciones incorrectas.

**How to apply:** Cuando se pida apagar o detener el relay Windows de la sala CB, proporcionar este comando exacto.