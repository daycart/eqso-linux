# Validación de PTT con eQSO 1.13

**Alcance actual:** VM de ensayos, cliente Windows 1.13 en modo VOX, sala
`PRUEBAS` (validada físicamente) y `CB` (piloto pendiente de validación física),
con respuestas de control ordenadas. La variante `EQSO_V113_VOX_TRIAL=1`
solo actúa en esas dos salas; **no habilita las demás**. Registrar cada sala
por separado.
No usar `update.sh` durante el ensayo: volvería a `origin/main`.

## Antes de cada sesión

- [ ] Servicio activo (`sudo systemctl is-active eqso.service` → `active`).
- [ ] 1.13 conectado a la sala que se prueba (`PRUEBAS` o `CB`); nivel de entrada de la radio en su valor
      habitual, no a cero. Anotar la revisión (`git rev-parse --short HEAD`).
- [ ] Comprobar que el PTT de la radio está suelto y que la web muestra la
      sala libre antes de comenzar. Usar emisiones cortas y respetar las
      condiciones de uso de la radio.

## Pruebas por sesión

- [ ] **Radio → web:** al menos 10 emisiones VOX desde la portátil, con pausas
      y una segunda transmisión sin reconectar 1.13. Tras cada una, comprobar
      que llega la voz completa a la web, 1.13 deja el azul, el PTT físico
      se suelta y la web queda libre.
- [ ] **Web → radio:** al menos 10 emisiones web. Comprobar que el audio llega
      a la radio, que ambos indicadores liberan el PTT y que 1.13 no se
      desconecta.
- [ ] **Cambio rápido de sentido:** en al menos 4 de las recepciones web,
      responder desde la portátil en 1–2 segundos. Comprobar en la web que
      se oye el **comienzo** de la respuesta RF; no vale contar solo que
      aparece el indicador de TX.
- [ ] Una vez, desconectar y reconectar 1.13 con la sala libre; comprobar que
      puede transmitir de nuevo. Repetir una conexión normal de otro cliente
      compatible si está disponible.

Para emisiones de prueba de 2–3 segundos, anotar cualquier PTT o sala que
siga ocupado **más de 5 segundos** después de terminar el audio. No esperar
indefinidamente si la radio permanece en TX.

## Registro por sesión

| Fecha y hora | Sala | Revisión | Radio→web correctas/total | Web→radio correctas/total | Respuestas rápidas con voz completa/total | ¿1.13 conectado al final? | Incidentes y hora |
|---|---|---|---:|---:|---:|---|---|
| | | | / | / | / | | |
| | | | / | / | / | | |
| | | | / | / | / | | |

**Si hay un incidente:** anotar dirección, hora aproximada, si 1.13 estaba
azul, si la web seguía ocupada, si la radio seguía físicamente en TX y si
1.13 continuaba conectado. Compartir solo un resumen de los registros de
esa hora; **no compartir `.env`, contraseñas ni PCAPs**.

## Decisión

**Apto para un piloto en otra sala** solo tras al menos **3 sesiones en
2 días distintos**, sumando **30 radio→web, 30 web→radio y 10 respuestas RF
rápidas**, sin PTT pegado, pérdida del inicio de voz, desconexión de 1.13
ni sala ocupada persistentemente. Un fallo detiene la ampliación hasta
entenderlo y repetir la validación afectada.

El usuario autorizó un piloto en `CB`, habilitado junto con `PRUEBAS`.
Mantenerlo supervisado durante varios días, con posibilidad de desactivar
la variante y reiniciar el servicio. Los buenos resultados de `PRUEBAS`
no sustituyen la validación de `CB`. Cualquier sala adicional requiere
**un cambio de código separado**. Solo después considerar el resto de salas; esta
lista no convierte una prueba positiva en garantía de fiabilidad permanente.

**Si falla durante el ensayo:** dejar de transmitir, desconectar 1.13 para
liberar la sala si es necesario, quitar `EQSO_V113_VOX_TRIAL=1` de la
configuración de la VM de pruebas y reiniciar `eqso.service`. No borrar
archivos ni ejecutar `update.sh` como método de reversión.