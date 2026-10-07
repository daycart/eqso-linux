# Programación automática de boletines

## Uso desde admin

En **Admin → Boletines → Programación automática**, configurar:

- **Generación automática**: crear texto y voz actualizados. Intervalo de
  15 a 10080 minutos; por defecto, 180 minutos.
- **Transmisión automática**: emitir el último boletín vigente. Intervalo de
  5 a 10080 minutos; por defecto, 60 minutos.
- **Sala**: destino de las emisiones automáticas.
- **Antigüedad máxima**: límite para la edad del boletín y de la consulta de
  sus datos meteorológicos; por defecto, 360 minutos.

Ambos controles empiezan desactivados. Se puede habilitar únicamente la
generación para comprobar la actualización sin emitir audio.
Cada guardado que habilite transmisión exige marcar expresamente la
confirmación RF. Tener relays conectados puede convertir una emisión en sala
en una emisión por radio; comprobar destino, condiciones de uso y calidad
antes de activarla.

**Guardar no genera ni transmite inmediatamente.** Inicia un intervalo nuevo
desde ese momento. El panel muestra las próximas ejecuciones, actividad,
resultados y errores; actualiza el estado cada diez segundos.

## Comportamiento seguro

- Si coinciden creación y transmisión, primero se crea el boletín.
- Si la creación de ese ciclo falla, se omite su transmisión.
- Solo se emite un boletín cuya creación y consulta meteorológica estén dentro
  de la antigüedad configurada y cuya previsión incluya la fecha actual en
  Europe/Madrid. Sin boletín vigente, se registra una omisión.
- Si la sala está ocupada, se omite ese ciclo. No se interrumpe la conversación,
  no se acumula una cola de emisiones pendientes ni se reintenta inmediatamente.
- La programación no ejecuta ciclos simultáneos. La creación manual y
  automática comparten la protección contra síntesis concurrentes; las
  transmisiones comparten el bloqueo de sala existente.
- Un cambio de configuración o desactivación cancela una emisión programada
  que aún no haya comenzado. Una transmisión ya iniciada, incluida su
  preparación, termina con su liberación normal de PTT.
- Los errores se muestran y registran; el siguiente intento ocurre según el
  intervalo, no en un bucle de reintentos.

## Persistencia y reinicios

La configuración, próximas fechas y últimos resultados se guardan de forma
atómica en `data/bulletins/schedule.json`, bajo el directorio de trabajo del
servidor, junto al almacenamiento de boletines existente.

En un reinicio se conservan las opciones y últimos resultados, pero empieza
un intervalo completo nuevo. No se recuperan emisiones perdidas durante una
parada. Una programación anteriormente habilitada sigue habilitada; para
detenerla, desactivar el control y guardar antes de reiniciar.

Si el archivo es inválido o no se puede guardar, el programador falla
explícitamente. No se habilita RF con una configuración que no pudo persistir.
Una inicialización fallida deja el programador sin arrancar y muestra
indisponibilidad en admin; revisar los registros y recuperar un archivo válido.
No sustituir un archivo dañado por una programación RF habilitada sin revisar.

La configuración pertenece a cada instalación: desarrollo y VM no comparten
este archivo automáticamente. Esta funcionalidad no publica ni actualiza la
VM. El despliegue y la activación RF requieren una actuación separada.

## Límites de la validación

Los ensayos automáticos de la lógica usan reloj, almacenamiento y transmisor
controlados, sin radio ni servicios de voz externos. La comprobación de UI
puede utilizar respuestas interceptadas para verificar los controles de RF
sin activar emisiones reales.

No se modifica GSM, ganancia, cadencia TCP, VOX ni ACK/PTT de Windows 1.13.
La distorsión residual y la validación física prolongada en PRUEBAS y CB
siguen pendientes. Antes de habilitar emisión periódica en la VM, comprobar
primero generación automática y persistencia sin RF y después acordar una
prueba supervisada de transmisión.
