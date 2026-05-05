# Instalación del Radioenlace eQSO ASORAPA

Guía para operadores que quieren conectar su zona a la red de radio CB por internet de ASORAPA.

## ¿Qué es esto?

Un programa que corre en tu ordenador Linux y conecta tu radio CB a la red de radioenlaces de ASORAPA. Todo lo que escuche tu radio se retransmite a todos los demás enlaces de España, y todo lo que digan por red lo emite tu radio al aire.

```
        Tu zona                              Red ASORAPA
   ┌─────────────┐                      ┌─────────────────────┐
   │  Radio CB   │◄──── CM108 USB ────►│  Este ordenador     │
   │  + antena   │                      │  (relay daemon)     │──── Internet ──── Servidor
   └─────────────┘                      └─────────────────────┘                   ASORAPA
```

## Requisitos

### Hardware
- **Interfaz de audio USB** tipo CM108, C-Media o PCM2902 (el típico "sonido USB barato")
  para conectar el audio de la radio (micrófono y altavoz)
- **Cable PTT USB** con chip CH340/CH341 para activar la emisión de la radio
  (muchos interfaces tienen ambas cosas integradas)
- Ordenador con Linux (Ubuntu 20.04 / 22.04 / 24.04 recomendado)
- Conexión a internet estable

### Software
El instalador se encarga de todo automáticamente:
- Node.js 20
- ffmpeg
- alsa-utils
- El demonio de radioenlace (compilado desde este repositorio)

### Credenciales
Necesitas que el administrador te facilite:
- Tu **indicativo** (el que usarás en la red, ej: `EA4IKU`, `CB30RCI184`, `ASORAPA`)
- Un **token de acceso** único para tu enlace

---

## Instalación

### Opción A — Instalación directa (recomendada)

```bash
curl -fsSL https://raw.githubusercontent.com/daycart/eqso-linux-client/main/artifacts/relay-daemon/install/install-operator.sh | sudo bash
```

El script te preguntará tu indicativo, el token y detectará automáticamente tu interfaz de audio.

### Opción B — Descarga y ejecuta

```bash
wget https://raw.githubusercontent.com/daycart/eqso-linux-client/main/artifacts/relay-daemon/install/install-operator.sh
sudo bash install-operator.sh
```

---

## Ajuste de audio

Tras la instalación, el audio puede necesitar ajuste según tu radio y tu interfaz. Edita:

```bash
sudo nano /etc/eqso-relay/CB.json
```

Parámetros más importantes:

| Parámetro | Descripción | Valor inicial | Ajuste |
|---|---|---|---|
| `voxThresholdRms` | Umbral de activación VOX | 1500 | Sube si dispara con ruido de fondo; baja si no activa con la voz |
| `inputGain` | Ganancia del micrófono | 0.3 | Sube si el audio llega bajo al servidor; baja si se satura |
| `outputGain` | Ganancia del altavoz | 1.0 | Sube si la radio suena baja; baja si hay distorsión |
| `captureDevice` | Dispositivo de entrada ALSA | plughw:1,0 | Usa `arecord -l` para ver los disponibles |
| `playbackDevice` | Dispositivo de salida ALSA | plughw:1,0 | Usa `aplay -l` para ver los disponibles |
| `postRxSuppressMs` | Tiempo de supresión VOX tras RX | 6000 | Aumenta si tu radio activa el VOX al terminar de recibir |

Tras cambiar la config:
```bash
sudo systemctl restart eqso-relay@CB
```

---

## Comandos útiles

```bash
# Ver qué está pasando en tiempo real
journalctl -u eqso-relay@CB -f

# Estado del servicio
systemctl status eqso-relay@CB

# Reiniciar
sudo systemctl restart eqso-relay@CB

# Estado de la conexión (desde otro terminal)
curl http://127.0.0.1:8009/status

# Activar PTT manualmente (para probar sin radio)
curl -X POST http://127.0.0.1:8009/ptt/start
curl -X POST http://127.0.0.1:8009/ptt/stop

# Forzar reconexión al servidor
curl -X POST http://127.0.0.1:8009/reconnect
```

---

## Detectar tu interfaz de audio

```bash
# Ver tarjetas de captura (micrófonos)
arecord -l

# Ver tarjetas de reproducción (altavoces)
aplay -l

# Ver dispositivos USB conectados
lsusb
```

El CM108 suele aparecer como `C-Media USB Audio Device` o `USB Audio`. Apunta el número de tarjeta (`card X`) y usa `plughw:X,0` en la config.

---

## Detectar el cable PTT

```bash
# Ver puertos serie USB disponibles
ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null

# Ver detalles del dispositivo
udevadm info /dev/ttyACM0 | grep -E "ID_VENDOR|ID_MODEL|ID_PRODUCT"
```

El cable CH340/CH341 aparece con `ID_VENDOR_ID=1a86`. El instalador crea automáticamente el symlink `/dev/eqso-ptt` que apunta al dispositivo correcto.

Si el PTT no funciona:
```bash
# Probar PTT manualmente con Python
python3 -c "
import serial, time
p = serial.Serial('/dev/eqso-ptt')
p.setRTS(True); print('PTT ON'); time.sleep(2)
p.setRTS(False); print('PTT OFF'); p.close()
"
```

---

## Actualizar a una versión nueva

```bash
cd /opt/eqso-relay
sudo git pull
cd artifacts/relay-daemon
sudo -u eqso pnpm run build
sudo systemctl restart eqso-relay@CB
```

---

## Solución de problemas comunes

### El servicio no arranca
```bash
journalctl -u eqso-relay@CB -n 50 --no-pager
```

### No hay audio en RX (no escucha la red)
- Comprueba `playbackDevice` en la config con `aplay -l`
- Prueba: `aplay -D plughw:1,0 /usr/share/sounds/alsa/Front_Center.wav`

### No sube audio en TX (la red no escucha tu radio)
- Comprueba `captureDevice` en la config con `arecord -l`
- Prueba: `arecord -D plughw:1,0 -r 48000 -f S16_LE -d 3 /tmp/test.wav && aplay /tmp/test.wav`
- Puede que el `voxThresholdRms` sea demasiado alto — bájalo a 500 para probar

### El VOX dispara solo (activa TX con el audio del altavoz)
- Aumenta `postRxSuppressMs` a 8000 o más
- Baja `outputGain` para que el altavoz no sature el micrófono

### El PTT no activa la radio
- Verifica que `/dev/eqso-ptt` existe: `ls -la /dev/eqso-ptt`
- Si no existe, reinicia el servicio: `sudo systemctl restart eqso-relay@CB`
- Prueba con PTT DTR si RTS no funciona: cambia `"method": "dtr"` en la config

---

## Contacto

Para obtener tu token de acceso o reportar problemas, contacta con el administrador de la red ASORAPA.
