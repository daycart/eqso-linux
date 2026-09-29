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
Sólo actúa en conexiones TCP v1.13 de la sala `PRUEBAS`; el resto de salas,
clientes modernos y liberaciones explícitas mantienen el comportamiento
anterior. No activar en la instancia habitual ni añadir la variable a un
entorno compartido de producción. Eliminar la variable y reiniciar la
instancia de pruebas para desactivarla.

Prueba con el cliente Windows: inicia la captura antes de conectar, conecta
en `PRUEBAS`, transmite unos segundos por VOX y deja de hablar sin pulsar
«soltar PTT» ni desconectar. Espera al menos 5 s; si se libera, repite una
segunda transmisión VOX sin reconectar. Si vuelve a azul, reinicia el PTT
o se desconecta, detén la variante y conserva sólo el resumen de la captura.
Las pruebas automáticas verifican la secuencia y dos ciclos sintéticos; el
comportamiento del cliente 1.13 real sigue pendiente de este ensayo.