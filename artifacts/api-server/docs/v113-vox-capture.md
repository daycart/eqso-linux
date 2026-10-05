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

La revisión de diagnóstico conserva el mismo ensayo en `PRUEBAS` y `CB`.
No cambia tiempos, bytes de protocolo, PTT ni audio; **no corrige todavía
la desconexión**.

El registro de la VM mostró un nuevo TX de 1.13 después del cierre de una
recepción web, seguido de liberación por inactividad y error TCP. El nombre
del radioenlace no identifica su sala: en ese episodio `0R-PRUEBAS` estaba
en `CB`.

La nueva instrumentación registra:

- `voiceBlocksInTx`: todos los bloques GSM completos del TX, no el contador
  limitado a los dos bloques de confirmación (`selfAckBlocks`).
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