---
name: Banco eQSO 1.13 y recorrido RF
description: Validación reproducible de clientes 1.13 sintéticos contra la VM y el relay Windows físico.
---

El banco de pruebas debe usar el saludo `0x78` del cliente Windows 1.13, no el
saludo `0x82` del relay moderno. La validación completa requiere comprobar los
ecos propios de inicio y fin de PTT, la entrega exacta de paquetes GSM y la
recepción física desde una segunda radio.

**Why:** Una prueba con tres clientes modernos parecía estable, pero no ejercía
las respuestas especiales que necesita 1.13. Con el saludo correcto, dos
clientes realizaron tres turnos cada uno sin pérdidas ni desconexiones; el relay
Windows accionó el PTT en todos los turnos y una segunda radio recibió los seis
tonos correctamente.

**How to apply:** Ejecutar primero en `PRUEBAS`, con indicativos exclusivos y el
relay temporalmente en esa sala. Considerar aprobado solo si el informe lógico
pasa y una persona confirma PTT y recepción RF; después restaurar el relay a
`CB`.