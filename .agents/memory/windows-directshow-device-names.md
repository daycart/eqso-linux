---
name: Nombres DirectShow en Windows
description: Cómo tratar nombres de audio acentuados que cambian de representación entre versiones y páginas de códigos de Windows.
---

Los nombres de captura DirectShow deben resolverse contra la enumeración real de
FFmpeg al arrancar; no se debe confiar en la representación visual que muestra
PowerShell ni en una única conversión de página de códigos.

**Why:** Un nombre Unicode correcto puede mostrarse como `MicrÃ³fono`,
`MicrÃƒÂ³fono` o `Micr├│fono`. Guardar literalmente esa representación puede hacer
que FFmpeg no encuentre el dispositivo, aunque otra representación dañada en el
log sea solo un problema de visualización.

**How to apply:** En cambios de audio Windows, conserva el nombre Unicode
enumerado por DirectShow, valida que FFmpeg pueda abrirlo y cubre variantes de
mojibake con pruebas. No uses el nombre amistoso de PnP como sustituto directo.