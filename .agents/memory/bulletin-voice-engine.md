---
name: Motor de voz para boletines
description: Decisión sobre la voz de los boletines meteorológicos y la prueba futura de Piper.
---

Piper está instalado en la VM y la voz `es_ES-sharvard-medium` genera WAV correctamente. En producción, usar Piper local; en Replit, conservar OpenAI mediante Replit AI Integrations.

**Why:** La integración OpenAI de Replit no está disponible desde la VM de Asorapa. Piper elimina esa dependencia y permite generar los boletines directamente en el servidor que conecta con la radio.

**How to apply:** La selección automática usa Piper cuando encuentra su Python y el modelo local; si no están presentes, usa OpenAI. No ocultar fallos de ejecución de Piper con un cambio silencioso de motor. La prueba RF sigue siendo necesaria para validar inteligibilidad y nivel de audio.