# Relay eQSO en Windows

Configuración validada para ejecutar el relay de radio y, opcionalmente, el
cliente eQSO 1.13 en el mismo ordenador.

## Configuración validada del relay

| Recurso | Uso |
|---|---|
| Audio | Sound Blaster Play! 3, con entrada y salida separadas |
| PTT | Adaptador serie CH343 en `COM5`, control mediante RTS |
| Reproducción | FFplay mediante SDL |
| Python | Python 3.12 localizado por el instalador y guardado como `PYTHON_PATH` |
| Sala | `CB` |
| Indicativo de referencia | `0R-WINPC` |

El instalador de Windows instala o localiza Node.js, FFmpeg/FFplay y Python.
También genera la configuración, los scripts de arranque/parada y la tarea
programada del relay.

El daemon aplica un bloqueo de instancia asociado a `CB.json`. Si Windows o el
Programador de tareas intentan abrir una segunda copia del mismo relay, esa
copia termina antes de conectar al servidor o abrir los dispositivos. Si un
cierre forzado deja un bloqueo huérfano, se recupera automáticamente cuando el
PID anterior ya no existe.

La contraseña o token de la sala no debe escribirse en esta documentación,
registros compartidos ni capturas públicas.

## Temporización recomendada

```json
{
  "audio": {
    "voxThresholdRms": 800,
    "voxHangMs": 1800,
    "rxHangMs": 1200,
    "postRxSuppressMs": 2500,
    "postTxSuppressMs": 600
  }
}
```

- `voxThresholdRms`: activa con voz normal de la radio sin exigir hablar fuerte.
- `voxHangMs`: mantiene la transmisión durante pausas breves entre palabras para
  que no se corte y vuelva a abrir.
- `rxHangMs`: mantiene el PTT durante 1,2 segundos desde el último paquete de
  audio recibido. El valor anterior de 4000 ms producía un cambio de turno
  innecesariamente lento.
- `postTxSuppressMs`: margen corto después de terminar una transmisión propia.
  Un valor de 600 ms permite recuperar antes el audio si el VOX se cerrase.
- `postRxSuppressMs`: impide temporalmente que el VOX retransmita el final del
  audio recibido como si fuese una nueva transmisión. No mantiene pulsado el
  PTT. Si el cambio radio → sala resulta lento y no hay realimentación, se puede
  probar gradualmente entre 800 y 1500 ms.

## Probar eQSO 1.13 en el mismo Windows

El relay y eQSO 1.13 pueden funcionar simultáneamente si no comparten recursos.

### Separación obligatoria

| Programa | Entrada/salida de audio | Puerto serie |
|---|---|---|
| Relay `0R-WINPC` | Sound Blaster Play! 3 | `COM5` |
| Cliente eQSO 1.13 | Realtek u otro dispositivo independiente | Ninguno |

No se debe usar `0R-WINPC` como indicativo del cliente 1.13 mientras el relay
esté conectado. Para pruebas se debe utilizar otro indicativo autorizado.

No se debe activar en eQSO 1.13 el control RTS/DTR ni el modo radioenlace sobre
`COM5`. Ese puerto pertenece exclusivamente al relay.

### Ajustes de sonido comprobados

En **Preferencias de dispositivo y volumen de la aplicación** de Windows:

- Salida de eQSO 1.13: altavoces o auriculares Realtek.
- Entrada de eQSO 1.13: micrófono Realtek.
- El relay/FFmpeg conserva la Sound Blaster Play! 3.

Configuración de micrófono validada durante la prueba:

- Nivel del micrófono Realtek: `60`.
- Amplificación de micrófono: desactivada.

Estos valores pertenecen a Windows y al controlador Realtek; no forman parte de
la configuración del relay. Windows suele conservarlos, pero pueden cambiar al
reinstalar el controlador, conectar otro dispositivo o restablecer las
preferencias de sonido.

eQSO 1.13 es una aplicación antigua. Si no respeta la asignación por aplicación:

1. Cerrar completamente eQSO 1.13.
2. Ejecutar `mmsys.cpl`.
3. Establecer Realtek como dispositivo predeterminado y dispositivo de
   comunicación predeterminado, tanto en reproducción como en grabación.
4. Volver a iniciar eQSO 1.13.

## Capturas Wireshark

El protocolo eQSO 1.13 no cifra toda la información de la sesión. Las capturas
PCAP pueden contener información de acceso y deben tratarse como archivos
privados; no deben publicarse ni adjuntarse a incidencias públicas.