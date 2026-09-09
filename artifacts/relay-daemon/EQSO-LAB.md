# Banco de pruebas eQSO 1.13

Este ejecutor conecta varios clientes sintéticos al servidor eQSO sin usar
micrófonos ni altavoces. Cada cliente usa el saludo `0x78` del cliente Windows
1.13, mantiene su heartbeat, entra con un indicativo distinto y transmite por
turnos un tono GSM 06.10 generado por FFmpeg.

## Seguridad

- Ejecutar únicamente en una sala de pruebas autorizada.
- Reservar los indicativos con el administrador del servidor.
- No reutilizar el indicativo del relay físico ni el de un cliente 1.13 real.
- La contraseña se recibe mediante `EQSO_LAB_PASSWORD`; no se guarda en archivos
  ni aparece en el informe.
- Es obligatorio definir `EQSO_LAB_LIVE=YES` para evitar conexiones accidentales.

## Ejecución

Desde `artifacts/relay-daemon`, después de `pnpm run build`:

```bash
export EQSO_LAB_LIVE=YES
export EQSO_LAB_HOST=asorapa.sytes.net
export EQSO_LAB_PORT=2172
export EQSO_LAB_ROOM=PRUEBAS
export EQSO_LAB_CALLSIGNS=LAB113-A,LAB113-B,LAB113-C
export EQSO_LAB_DURATION_SECONDS=300
export EQSO_LAB_TONE_SECONDS=3
export EQSO_LAB_TURN_GAP_SECONDS=8
export EQSO_LAB_PASSWORD='configurar mediante Replit Secrets'
pnpm run lab
```

En PowerShell se usa `$env:NOMBRE="valor"` en vez de `export`.

Para validar el camino radio → relay → servidor sin generar tonos desde el
laboratorio, usar:

```bash
export EQSO_LAB_TRANSMIT=NO
export EQSO_LAB_DURATION_SECONDS=120
pnpm run lab
```

En este modo el informe exige recibir al menos un inicio de PTT, paquetes de
audio y un final de PTT en cada cliente conectado.

## Informe

Al finalizar se crea `eqso-lab-report.json`, o la ruta indicada en
`EQSO_LAB_REPORT`. Para cada cliente registra conexiones, desconexiones,
errores, audio enviado/recibido y los ecos de inicio y fin de PTT. Un cliente
1.13 compatible debe recibir del servidor el eco de sus propios cambios de PTT.
El campo `passed` solo es verdadero cuando no hay desconexiones ni errores, se
recibe todo el audio esperado y cada transmisión obtiene ambos ecos propios.

La primera prueba recomendada dura cinco minutos en la sala `PRUEBAS`. Después
se puede ampliar a una hora y, finalmente, a 8–24 horas sin tonos frecuentes.