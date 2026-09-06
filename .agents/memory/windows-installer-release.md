---
name: Publicación inmediata del instalador Windows
description: Cómo evitar ejecutar una versión antigua del instalador justo después de publicarlo.
---

Al probar una versión recién publicada del instalador Windows, verificar que la descarga contiene las preguntas y funciones esperadas. Si la URL basada en `main` entrega contenido anterior, usar temporalmente la URL de `raw.githubusercontent.com` fijada al SHA completo del commit.

**Why:** GitHub sirvió el instalador antiguo desde la URL de la rama incluso después de actualizar `main`, mientras que la URL fijada al nuevo commit devolvió inmediatamente el archivo correcto.

**How to apply:** Para pruebas inmediatas de una publicación, descargar por commit y comparar tamaño o hash con el archivo publicado. Volver a la URL de `main` sólo después de confirmar que la caché se actualizó.