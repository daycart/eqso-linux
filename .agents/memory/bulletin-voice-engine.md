---
name: Motor de voz para boletines
description: Decisión sobre la voz de los boletines meteorológicos y la prueba futura de Piper.
---

Durante la fase de prueba, generar las locuciones con OpenAI mediante Replit AI Integrations. Antes de habilitar emisiones periódicas o desatendidas, comparar el mismo boletín con Piper ejecutado localmente en la VM.

**Why:** OpenAI permite validar rápidamente claridad, pronunciación y duración, mientras que Piper podría eliminar el coste por locución y reducir la dependencia de servicios externos.

**How to apply:** Mantener OpenAI en la fase 1. Más adelante, evaluar una voz española de Piper escuchando el resultado también por RF; si la inteligibilidad es suficiente, usar Piper como motor principal y conservar OpenAI como alternativa.