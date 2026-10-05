# Comparar VOX de eQSO 1.13 sin compartir contraseñas

El cliente 1.13 libera VOX con el servidor original, pero en algunas sesiones con
el servidor propio deja de enviar voz sin liberar la sala. CTS no inicia en ninguno
de los dos servidores de esta instalación; las pruebas comparativas deben usar VOX.

1. En el PC Windows del cliente 1.13, captura una prueba corta en la sala
   `PRUEBAS` conectada al servidor original. Repite con los mismos ajustes,
   misma radio y duración aproximada contra el servidor propio, cerrando y
   reabriendo 1.13 entre pruebas. Apunta si soltó solo o hubo que cerrar el
   cliente. Limita la captura en Wireshark al puerto TCP real del servidor.
2. Sin sacar las capturas de ese PC, ejecuta desde PowerShell (con Node.js y
   Wireshark/tshark instalados):

   ```powershell
   node .\artifacts\api-server\tools\summarize-v113-capture.mjs "C:\ruta\original.pcapng" 8008
   node .\artifacts\api-server\tools\summarize-v113-capture.mjs "C:\ruta\propio.pcapng" 2171
   ```

   Sustituye los puertos por los que realmente usó 1.13. Si hay varios clientes
   en el mismo puerto, añade el número de `tcp.stream` al final para elegir uno.
   La herramienta reconoce automáticamente el saludo 1.13 (`0a 78 00 00 00`),
   salta el JOIN, agrupa la voz y solo muestra la secuencia de control y tamaños
   de los segmentos próximos al inicio y fin de la transmisión.
3. Comparte **solo la salida resumida** junto con el resultado visible de cada
   prueba. No compartas las capturas PCAP/PCAPNG: incluyen el JOIN con la
   contraseña y pueden incluir otros datos de la red. Bórralas o consérvalas
   localmente según tu política de diagnóstico; no las subas a GitHub.

Una captura histórica del servidor original y otra de una sesión bloqueada ya
mostraron, respectivamente, un `0x0d` de fin y ausencia de liberación espontánea
tras cesar la voz. Son de fechas diferentes y no bastan para elegir un cambio
seguro del protocolo actual. En esas capturas, el servidor original separó el
primer marcador de propietario de la siguiente actualización unos 103 ms; en
la sesión bloqueada ambos salieron separados solo 2 ms tras llegar tres bloques
de voz juntos. Es una hipótesis de temporización, **no una causa confirmada**.
No sustituir esta comparación por un timeout de desbloqueo: intentos anteriores
hicieron que 1.13 se desconectara.

## Ensayo aislado de liberación VOX

Las capturas completas posteriores muestran que el servidor original libera
el PTT aproximadamente 1,3 s después del último bloque GSM sin recibir
`0x0d`/`0x03`. Envía `0x08`, después `0x06 0x00` unos 60 ms más tarde y la
actualización de usuario liberado unos 250 ms después. El servidor local sólo
liberó tras el `0x0d` del botón (y el cliente volvió a transmitir) o el `0x03`
del cierre manual.

Existe una variante **experimental, apagada por defecto**:
`EQSO_V113_VOX_TRIAL=1` al arrancar **una instancia separada de pruebas**.
Sólo actúa en conexiones TCP v1.13 de las salas `PRUEBAS` y `CB`; el resto de salas,
clientes modernos y liberaciones explícitas mantienen el comportamiento
anterior. No activar en la instancia habitual ni añadir la variable a un
entorno compartido de producción. Eliminar la variable y reiniciar la
instancia de pruebas para desactivarla.

Prueba con el cliente Windows: inicia la captura antes de conectar, conecta
en `PRUEBAS`, transmite unos segundos por VOX y deja de hablar sin pulsar
«soltar PTT» ni desconectar. Espera al menos 5 s; si se libera, repite una
segunda transmisión VOX sin reconectar. Si vuelve a azul, reinicia el PTT
o se desconecta, detén la variante y conserva sólo el resumen de la captura.
Las pruebas automáticas verifican la secuencia y dos ciclos sintéticos. En
un primer ensayo con el cliente 1.13 real en la VM de pruebas, el usuario
confirmó que el PTT se liberó correctamente en dos transmisiones VOX
separadas por cinco segundos. Es un resultado positivo limitado a ese
ensayo; aún no justifica activar la variante por defecto o en otras salas.

En un ensayo posterior, al transmitir desde el cliente web hacia el 1.13
receptor, el audio llegó a la radio, pero 1.13 inició una transmisión propia
unos 0,4–0,5 s después de recibir el cierre del PTT web. La liberación VOX
experimental cerró ese nuevo PTT tras la inactividad y unos 0,4 s después
se produjo un error de socket y se desconectó el cliente. Ocurrió varias
veces. El servidor registró cero paquetes de voz pendientes en la cola al
cerrarse el socket; la causa de la nueva transmisión y del error TCP sigue
sin confirmarse. Desactivar la variante antes de más ensayos; no extenderla
fuera de `PRUEBAS` ni confundir este fallo de recepción con los dos ciclos
correctos de transmisión VOX.

Una repetición con la variable experimental eliminada y el servicio reiniciado
confirmó que el problema RX→TX también existe sin la variante: al terminar
la emisión web, `0R-PRUEBAS` volvió a enviar voz y dejó ocupada la sala,
esta vez sin liberación automática ni desconexión inmediata. Por tanto, la
variante agravó el síntoma con la desconexión, pero no originó el nuevo PTT.
El usuario aclaró que el indicador de PTT del programa 1.13 sí se soltó:
era el cliente web el que seguía mostrando a `0R-PRUEBAS` como emisor.
Al desconectar 1.13, desapareció de la web. El registro confirmó que, tras
el nuevo inicio de voz, 1.13 dejó
de enviarla sin mandar liberación (`readMultiByte=false`, sin bytes pendientes).
El primer comando de fin fue `0x03` varios minutos después, al desconectar.
La web reflejaba correctamente el bloqueo que aún mantenía el servidor;
no era sólo un indicador visual desactualizado.

En una prueba posterior con la variante experimental desactivada, el usuario
puso temporalmente a cero el nivel de la entrada de audio usada por 1.13:
después de una emisión web, el cliente web ya no quedó bloqueado. Esto
implica a la captura de audio de 1.13 en el nuevo TX posterior a la recepción,
pero no identifica todavía la fuente del sonido (retorno de la radio,
acoplamiento acústico u otra entrada), ni explica por sí solo por qué 1.13
deja de enviar voz sin mandar el comando de liberación. No modificar aún el
protocolo ni activar la liberación experimental por este resultado aislado.
El usuario indica que la fuente seleccionada en 1.13 figura como «Micrófono»
y está conectada por cable a la radio, no es un micrófono ambiental. Queda
por determinar si la señal procede de la salida de la radio durante TX, de
un retorno eléctrico en el cable/interfaz o de otra causa.
Con el nivel de entrada restaurado, el usuario observó dos picos pequeños en
el medidor de «Micrófono»: uno al pulsar el PTT web y otro al soltarlo. El
segundo coincide temporalmente con el nuevo inicio de voz observado tras el
cierre web del ensayo anterior, pero en esta repetición la sala se liberó.
Por tanto, esos picos por sí solos no demuestran que activen el VOX ni
explican el bloqueo intermitente. No ajustar la sensibilidad ni el protocolo
basándose sólo en esta observación.

## Ensayo de control ordenado sin filtrar audio RF

Sin la variante, el temporizador de inactividad sólo avisa y **no desbloquea**
el PTT: radio → web puede dejar 1.13 en azul y la web ocupada. Esto no es un
modo operativo aceptable. El usuario descartó una propuesta de suprimir la
voz que comience al terminar la recepción web porque podría perder una
respuesta inmediata desde la radio portátil.

La revisión del ensayo `EQSO_V113_VOX_TRIAL=1` conserva todas las
tramas de voz y la liberación por inactividad para 1.13 en `PRUEBAS` y `CB`, pero
encola tanto las confirmaciones de inicio propias como la secuencia de
liberación propia detrás del audio y del cierre de recepción ya pendientes
para ese socket. La cola mantiene las separaciones de 60 y 250 ms de la
liberación experimental. Las pruebas sintéticas cubren dos TX propios y
web → RF con recepción todavía en cola. En la VM de ensayos, con la revisión
ordenada compilada y el indicador experimental activado, el usuario confirmó
que «va perfecto en todos los sentidos» tras probar radio → web y web →
radio en `PRUEBAS`. El alcance se amplió a `CB` a petición del usuario para
un piloto; esa sala todavía requiere validación física. Es una validación
física positiva de la configuración de `PRUEBAS`, no una prueba
de fiabilidad prolongada ni autorización para activarla por defecto en otras
salas. Si reaparece un bloqueo o una desconexión, quitar la variable y
reiniciar el servicio para revertir el ensayo. No ejecutar `update.sh` en la
VM de ensayos: reemplazaría esta rama por `origin/main`.

Para registrar varias sesiones y decidir si ampliar a otra sala, usar la
[lista de validación de eQSO 1.13](./v113-validation-checklist.md).

## Diagnóstico de ruido RF seguido de desconexión

La instrumentación de diagnóstico conserva el mismo ensayo en `PRUEBAS` y
`CB`. Por sí sola no cambia tiempos, bytes de protocolo, PTT ni audio;
**no corrige la desconexión**. El parche experimental posterior para TX
de un solo bloque se describe al final de esta guía.

El registro de la VM mostró un nuevo TX de 1.13 después del cierre de una
recepción web, seguido de liberación por inactividad y error TCP. El nombre
del radioenlace no identifica su sala: en ese episodio `0R-PRUEBAS` estaba
en `CB`.

La nueva instrumentación registra:

- `voiceBlocksInTx`: todos los bloques GSM completos del TX, no el contador
  de etapa de confirmación (`selfAckBlocks`: 0, 1 o 2). La etapa 2 puede
  completarse al cerrar un TX de un único bloque; no equivale a recibir
  dos bloques de audio.
- Las dos confirmaciones propias en `Legacy v1.13 self PTT ack queued`.
- `origin` en actualizaciones de PTT: `self-trial` o `room-broadcast`.
- `errorCode`, `errorMessage` y `errorSyscall`, junto con la cola y el parser,
  en `TCP socket error`, **antes de limpiar la conexión**.
- En el cierre, `queueStateAfterCleanup` indica si ya se hizo la limpieza.
  Si es `true`, una cola vacía no acredita que estuviera vacía al fallar.
- Nombre y sala conservados en el cierre, incluso después de retirar al
  cliente de la lista de conexiones.

No se registran audio, paquetes crudos, contraseñas ni tokens. Tras reproducir
una sola emisión breve, obtener los eventos relevantes en la VM:

```bash
sudo journalctl -u eqso.service --since "3 minutes ago" --no-pager -o cat |
grep -E 'eQSO PTT start command received|eQSO PTT release command received|Trial v1.13 VOX idle release|Legacy v1.13 self PTT ack queued|Legacy v1.13 outbound PTT update|Legacy v1.13 socket closed|TCP socket error|TCP write error|TCP legacy voice write error|TCP eQSO client disconnected'
```

Mantener supervisión y detener la prueba si la radio queda en TX. No pedir
ni compartir `.env`, credenciales o PCAPs.

## Parche experimental: completar la confirmación de un TX de un solo bloque

El diagnóstico físico mostró un TX de retorno con un único bloque GSM,
una sola confirmación propia y `ECONNRESET` después de la liberación por
inactividad. La cola y el parser estaban vacíos antes de la limpieza.
Esto identifica una confirmación incompleta como causa candidata, pero
**no demuestra todavía que sea la causa del reset de Windows**.

Tras el primer bloque se encola `06`; normalmente, el segundo completa
`<nameLen><name>` y la actualización de TX iniciado. Si termina el TX sin
segundo bloque, el parche encola esos mismos bytes pendientes antes de
la liberación. No repite `06`, añade bloques GSM, descarta voz, cambia
el temporizador de 1,3 s ni las separaciones de 60 y 250 ms. Todo sigue
ordenado detrás del audio y cierre de recepción pendientes.

Sólo cambia el cierre `trial-vox-idle` de 1.13 en el ensayo opt-in de
`PRUEBAS` y `CB`. El cierre explícito, clientes modernos y demás salas
mantienen su comportamiento. El ruido físico de la radio no se elimina.

Las pruebas sintéticas comprueban, en ambas salas, una recepción seguida de
TX de un bloque, la confirmación completa antes de liberar, la entrega de
ese único bloque sin inventar otro y un segundo TX normal en la misma
conexión. **No sustituyen la validación del cliente 1.13 real.**

En la VM, probar una emisión web corta y el retorno observado, comprobar
liberación física del PTT y conexión estable, y después una respuesta real
desde la portátil. Conservar el diagnóstico anterior y añadir al filtro:

```text
Legacy v1.13 single-block TX ack completed before release
```

Si sigue fallando, detener la prueba y recoger el código TCP y la secuencia
de confirmaciones; no extender a otras salas ni introducir filtros de voz.

## Comprobar la intercalación de keepalive sin cambiar la VM

Desde la raíz del repositorio, ejecutar:

```bash
node artifacts/api-server/tools/probe-v113-ack-keepalive.mjs
```

Para compilar sólo el TCP de una revisión histórica, añadir su hash como
argumento. No hace checkout; los demás módulos son los del workspace, por
lo que deben comprobarse sus diferencias antes de interpretar esa comparación.

El diagnóstico arranca un servidor aislado en un puerto loopback efímero y
recibe el flujo TCP real con clientes sintéticos. Sin alterar relojes ni
temporizadores, sincroniza una ráfaga con el keepalive periódico. Compara
dos bloques rápidos, dos separados por el keepalive y uno con cierre por
inactividad. Informa si aparece `0c` entre el opcode `06` y los datos de
propietario, sin volcar audio, credenciales ni paquetes completos.

No cambia el servidor de la aplicación, la VM ni sus servicios. La sonda
es independiente de las regresiones normales. En el workspace exige ausencia
de intercalación en PRUEBAS y CB; con una revisión histórica informa del
resultado sólo en PRUEBAS, sin exigir que esté corregido. No emula el parser de
Windows ni reproduce su reset: un resultado positivo acredita la
intercalación, **no demuestra por sí solo la causa de la desconexión**.

En la comprobación local del 2026-10-05 se reprodujo la intercalación tanto
con el TCP de la revisión ordenada previa a habilitar CB como con el TCP
actual. Los demás módulos usados eran idénticos entre esas revisiones:

- Dos bloques rápidos: datos de propietario completos, sin keepalive en medio.
- Dos bloques que cruzan el keepalive: se recibe `06 0c` antes de los datos
  de propietario. Para el nombre sintético de diez bytes, el siguiente byte
  esperado era `0a`, no `0c`.
- Un bloque: también se recibe el keepalive antes de los datos de propietario.
  La revisión actual completa esos datos antes del cierre, pero eso no elimina
  el keepalive que ya se envió. La revisión antigua no completa esos datos.

Los sockets sintéticos permanecieron conectados: no emulan el parser de
Windows y no reproducen su reset. Esto acredita un riesgo de framing en ambas
revisiones, no la causa física confirmada de cada desconexión observada.

## Corrección candidata: reserva de la confirmación de propietario

Sólo con `EQSO_V113_VOX_TRIAL=1`, saludo `0a78000000` y sala `PRUEBAS`
o `CB`, el primer bloque GSM completo reserva un mensaje en la cola de
salida. Al llegar su turno escribe `06` y no deja pasar ningún otro byte
hasta escribir `<nameLen><name>` y la actualización propia de TX iniciado.
El segundo bloque completa esa misma reserva, sin repetir el opcode.

El cierre explícito `0d` o `03`, el cierre por inactividad, un cambio de
sala/identidad y una nueva transmisión completan la reserva pendiente antes
de continuar. La desconexión elimina reserva, cola y temporizadores. Se
conserva el nombre original al cambiar de sala o indicativo.

Una espera de framing acotada a 1,3 s desde el primer bloque completa sólo
el ACK si no llega el segundo bloque. También funciona si el parser queda
esperando un bloque GSM parcial: **no libera PTT ni descarta ese bloque**.
La liberación sigue dependiendo del temporizador VOX existente o de un
cierre explícito. Cuando el bloque parcial se completa se reenvía íntegro,
sin emitir otra confirmación.

**Consecuencia de la reserva:** el keepalive sigue programándose cada 2,5 s
y VOX sigue usando 1,3 s, pero sus controles y cualquier otra salida
(incluidos audio, listas y respuestas directas) esperan detrás del ACK.
Los controles aplazados no se descartan ni cambian de orden. La espera
adicional de la reserva está acotada a 1,3 s, además de la recepción ya
encolada. Si el ACK aún no ha llegado a la cabeza por una recepción pendiente,
puede quedar listo antes de escribir `06`; sus datos se escriben al llegar
su turno, sin adelantarse al audio ni al cierre de recepción.

No se generan bloques GSM para cerrar el ACK. Fuera de este ensayo, las
salas y clientes mantienen su comportamiento anterior. Esta corrección
no elimina ruido RF ni demuestra que se haya resuelto el reset de Windows.

### Verificación local y ensayo físico pendiente

Desde la raíz del repositorio:

```bash
pnpm --filter @workspace/api-server test
pnpm --filter @workspace/api-server typecheck
node artifacts/api-server/tools/probe-v113-ack-keepalive.mjs
```

Las regresiones conservan recepción pendiente, todos los bloques RF y
segundas transmisiones. Añaden cruces reales del keepalive en ambas salas,
controles directos y broadcast, cierres explícitos, inactividad, cambio de
sala, nuevo TX, desconexión y parser parcial. Comprueban bytes concatenados,
no un evento TCP por escritura.

La sonda local corregida muestra seis escenarios (dos rápidos, dos que
cruzan el keepalive y uno con inactividad, en cada sala), todos con
`interleavingDetected=false`, `unexpectedBytesBeforeOwner=0` y propietario
completo antes de la liberación. Ningún socket sintético se desconecta.
Esto sólo confirma el framing observado en loopback.

**No se ha publicado en main ni actualizado la VM.** No hay acceso SSH:
la actualización manual requiere autorización del usuario. Cuando autorice
esa actualización, entregar los comandos apropiados a su instalación y
probar físicamente en ambas salas: recepción web corta, retorno RF de un
bloque y de varios bloques, al menos dos ciclos TX, PTT físico liberado y
conexión estable. Recoger el código TCP y los logs si vuelve a fallar.

Para el nuevo filtro de logs usar:

```text
Legacy v1.13 reserved owner ack completed
Legacy v1.13 socket closed with outbound queue state
TCP socket error
```

El diagnóstico incluye `ownerAckReserved` y `ownerAckWaiting`. No declarar
resuelto el reset hasta validar con eQSO 1.13 real en Windows.