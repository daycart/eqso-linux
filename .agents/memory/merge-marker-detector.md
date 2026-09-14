---
name: Detector de marcadores durante reconciliaciones
description: Falso positivo del flujo de continuación cuando un archivo contiene separadores decorativos con siete signos igual.
---

Durante una reconciliación gestionada, evitar secuencias literales de siete signos igual en los archivos conflictivos, incluso si solo forman parte de banners o separadores visuales.

**Why:** El verificador de `continueMergeResolution` puede interpretar esas secuencias como marcadores de conflicto restantes aunque no estén entre `<<<<<<<` y `>>>>>>>`.

**How to apply:** Si la continuación afirma que quedan marcadores pero no aparecen cabeceras de conflicto, buscar las tres secuencias por separado. Sustituir los separadores decorativos por guiones sin alterar la lógica.