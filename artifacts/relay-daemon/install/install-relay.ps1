# ============================================================
#  eQSO ASORAPA - Instalador automatico de Relay Daemon (Windows)
#  Compatibilidad: Windows 10 / 11 (PowerShell 5.1 o superior)
#
#  Instalacion con un solo comando (PowerShell como Administrador):
#    irm https://raw.githubusercontent.com/daycart/eqso-linux/main/artifacts/relay-daemon/install/install-relay.ps1 | iex
#
#  O clonando el repo primero:
#    git clone https://github.com/daycart/eqso-linux
#    powershell -ExecutionPolicy Bypass -File eqso-linux\artifacts\relay-daemon\install\install-relay.ps1
# ============================================================

#Requires -Version 5.1

# Permitir ejecutar scripts en esta sesion (necesario para que npm/pnpm funcionen).
# Solo afecta a este proceso - no cambia la politica global del sistema.
Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force

Set-StrictMode -Version Latest
# pnpm y Node.js pueden escribir avisos en stderr aunque terminen correctamente.
# Los pasos criticos comprueban explicitamente sus resultados mas abajo.
$ErrorActionPreference = 'Continue'

# -- Verificar que somos Administrador ----------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host ""
    Write-Host "  Este script necesita ejecutarse como Administrador." -ForegroundColor Yellow
    Write-Host "  Haz clic derecho en PowerShell -> 'Ejecutar como administrador'" -ForegroundColor Yellow
    Write-Host "  y vuelve a ejecutar el script." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "  Pulsa Enter para salir"
    exit 1
}

$REPO_URL    = "https://github.com/daycart/eqso-linux"
$INSTALL_DIR = "$env:USERPROFILE\eqso-linux"
$CONFIG_DIR  = "C:\eqso-relay"

function Write-Ok   { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Info { param($msg) Write-Host "   ->  $msg" -ForegroundColor Cyan }
function Write-Warn { param($msg) Write-Host "   !   $msg" -ForegroundColor Yellow }
function Write-Step { param($msg)
    Write-Host ""
    Write-Host "  ============================================" -ForegroundColor Blue
    Write-Host "    $msg" -ForegroundColor Blue
    Write-Host "  ============================================" -ForegroundColor Blue
}

function Repair-NativeUtf8Text {
    param([string]$Text)

    if ([string]::IsNullOrEmpty($Text) -or $Text -notmatch "[\u251C\u2502\u252C\uFFFD]") {
        return $Text
    }

    $utf8 = New-Object System.Text.UTF8Encoding($false)
    foreach ($codePage in @(437, 850)) {
        try {
            $encoding = [System.Text.Encoding]::GetEncoding($codePage)
            $candidate = $utf8.GetString($encoding.GetBytes($Text))
            if ($candidate -notmatch "[\u251C\u2502\u252C\uFFFD]") {
                return $candidate
            }
        } catch {
            # El code page puede no estar disponible en algunas instalaciones.
        }
    }

    return $Text
}

function Get-DirectShowAudioDevices {
    param([string]$FfmpegPath)

    $tempPath = [System.IO.Path]::GetTempFileName()
    try {
        Start-Process -FilePath $FfmpegPath `
            -ArgumentList @("-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy") `
            -RedirectStandardError $tempPath `
            -NoNewWindow -Wait | Out-Null
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        $lines = @(
            [System.IO.File]::ReadAllLines($tempPath, $utf8) |
                ForEach-Object { Repair-NativeUtf8Text $_ }
        )
    } finally {
        Remove-Item -Path $tempPath -Force -ErrorAction SilentlyContinue
    }

    $devices = @()

    foreach ($line in $lines) {
        if ($line -match '"([^"]+)"\s+\(audio\)\s*$') {
            $name = $Matches[1]
            if ($devices -notcontains $name) {
                $devices += $name
            }
        }
    }

    return $devices
}

function Get-WindowsAudioEndpoints {
    if (-not (Get-Command Get-PnpDevice -ErrorAction SilentlyContinue)) {
        return @()
    }

    return @(
        Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue |
            Where-Object { $_.Status -eq "OK" -and $_.FriendlyName } |
            Select-Object -ExpandProperty FriendlyName -Unique
    )
}

function Read-RequiredValue {
    param([string]$Prompt)

    while ($true) {
        $value = (Read-Host $Prompt).Trim()
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return $value
        }
        Write-Warn "Este valor es obligatorio."
    }
}

function Read-DeviceChoice {
    param(
        [string]$Prompt,
        [object[]]$Devices
    )

    $choices = @($Devices)
    if ($choices.Count -eq 0) {
        return (Read-RequiredValue "$Prompt (nombre exacto)")
    }

    while ($true) {
        if ($choices.Count -eq 1) {
            $selection = (Read-Host "$Prompt [Enter para usar 1]").Trim()
            if ([string]::IsNullOrWhiteSpace($selection)) {
                return [string]$choices[0]
            }
        } else {
            $selection = (Read-Host "$Prompt [1-$($choices.Count)]").Trim()
        }

        [int]$index = 0
        if ([int]::TryParse($selection, [ref]$index) -and $index -ge 1 -and $index -le $choices.Count) {
            return [string]$choices[$index - 1]
        }
        if ($choices -contains $selection) {
            return $selection
        }

        Write-Warn "Selecciona un numero de la lista o copia un nombre exactamente."
    }
}

function Test-AudioDevices {
    param(
        [string]$FfmpegPath,
        [string]$FfplayPath,
        [string]$CaptureDevice,
        [string]$PlaybackDevice
    )

    Write-Info "Probando la entrada DirectShow durante 1 segundo..."
    & $FfmpegPath -hide_banner -loglevel error -f dshow -i "audio=$CaptureDevice" -t 1 -f null NUL
    if ($LASTEXITCODE -ne 0) {
        Write-Host "No se pudo abrir la entrada de audio '$CaptureDevice'." -ForegroundColor Red
        return $false
    }
    Write-Ok "Entrada de audio valida"

    Write-Info "Probando la salida seleccionada con un tono corto..."
    $previousAudioDevice = $env:SDL_AUDIO_DEVICE_NAME
    try {
        $env:SDL_AUDIO_DEVICE_NAME = $PlaybackDevice
        & $FfplayPath -hide_banner -loglevel error -nodisp -autoexit -f lavfi -i "sine=frequency=700:sample_rate=48000:duration=1"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "No se pudo abrir la salida de audio '$PlaybackDevice'." -ForegroundColor Red
            return $false
        }
    } finally {
        $env:SDL_AUDIO_DEVICE_NAME = $previousAudioDevice
    }
    Write-Ok "Salida de audio valida"

    return $true
}

function Test-RelayConfig {
    param([string]$Path)

    try {
        $config = Get-Content -Path $Path -Raw | ConvertFrom-Json
    } catch {
        Write-Host "El JSON generado no es valido: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }

    $missing = @()
    if ([string]::IsNullOrWhiteSpace([string]$config.backend)) { $missing += "backend" }
    if ([string]$config.backend -ne "ffmpeg") { $missing += "backend=ffmpeg" }
    if ([string]::IsNullOrWhiteSpace([string]$config.callsign)) { $missing += "callsign" }
    if ([string]::IsNullOrWhiteSpace([string]$config.room)) { $missing += "room" }
    if ([string]::IsNullOrWhiteSpace([string]$config.password)) { $missing += "password" }
    if ([string]::IsNullOrWhiteSpace([string]$config.server)) { $missing += "server" }
    if (-not $config.port -or [int]$config.port -lt 1 -or [int]$config.port -gt 65535) { $missing += "port" }
    if ([string]::IsNullOrWhiteSpace([string]$config.audio.captureDevice)) { $missing += "audio.captureDevice" }
    if ([string]::IsNullOrWhiteSpace([string]$config.audio.playbackDevice)) { $missing += "audio.playbackDevice" }
    if ([string]$config.audio.captureFormat -ne "dshow") { $missing += "audio.captureFormat=dshow" }
    if ([string]$config.audio.playbackFormat -ne "ffplay") { $missing += "audio.playbackFormat=ffplay" }

    if ($missing.Count -gt 0) {
        Write-Host "Faltan o son incorrectos estos valores: $($missing -join ', ')" -ForegroundColor Red
        return $false
    }

    return $true
}

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Blue
Write-Host "    eQSO ASORAPA - Instalador Relay Daemon" -ForegroundColor Blue
Write-Host "  ============================================" -ForegroundColor Blue
Write-Host "  Instala el nodo de radioenlace eQSO en Windows."
Write-Host ""

# -- Funcion auxiliar: instalar con winget ------------------
function Install-WithWinget {
    param($Id, $Name)
    $installed = winget list --id $Id --accept-source-agreements 2>$null | Select-String $Id
    if (-not $installed) {
        Write-Info "Instalando $Name via winget..."
        winget install --id $Id --silent --accept-source-agreements --accept-package-agreements
        # Actualizar PATH en la sesion actual
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    } else {
        Write-Ok "$Name ya instalado"
    }
}

# -- Paso 1: Dependencias -----------------------------------
Write-Step "1/6  Instalando dependencias del sistema"

# Git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Install-WithWinget "Git.Git" "Git"
}
Write-Ok "git $(git --version 2>$null)"

# Node.js LTS
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Install-WithWinget "OpenJS.NodeJS.LTS" "Node.js LTS"
}
Write-Ok "node $(node --version 2>$null)"

# ffmpeg
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Install-WithWinget "Gyan.FFmpeg" "FFmpeg"
}
Write-Ok "ffmpeg $(ffmpeg -version 2>$null | Select-Object -First 1)"

# -- Paso 2: npm --------------------------------------------
Write-Step "2/6  Verificando npm"

# Usamos npm.cmd directamente para evitar el wrapper npm.ps1, que puede
# estar bloqueado por la politica de ejecucion de PowerShell.
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    Write-Host "npm no esta disponible. Reinstala Node.js LTS y vuelve a intentarlo." -ForegroundColor Red
    exit 1
}
Write-Ok "npm $(npm.cmd --version 2>$null)"

# -- Paso 3: Codigo fuente ----------------------------------
Write-Step "3/6  Codigo fuente"

if (Test-Path "$INSTALL_DIR\.git") {
    Write-Info "Repositorio existente -> actualizando..."
    if (Test-Path "$INSTALL_DIR\.git\MERGE_HEAD") {
        Write-Host "El repositorio tiene una fusion de Git sin terminar." -ForegroundColor Red
        Write-Host "Ejecuta: git -C `"$INSTALL_DIR`" merge --abort" -ForegroundColor Yellow
        Write-Host "Despues vuelve a ejecutar este instalador." -ForegroundColor Yellow
        exit 1
    }
    git -C $INSTALL_DIR pull --quiet
    if ($LASTEXITCODE -ne 0) {
        Write-Host "No se pudo actualizar el repositorio." -ForegroundColor Red
        Write-Host "Revisa el estado con: git -C `"$INSTALL_DIR`" status" -ForegroundColor Yellow
        exit 1
    }
    Write-Ok "Codigo actualizado"
} else {
    Write-Info "Clonando repositorio en $INSTALL_DIR ..."
    git clone --quiet $REPO_URL $INSTALL_DIR
    Write-Ok "Repositorio clonado"
}

$relayDir = "$INSTALL_DIR\artifacts\relay-daemon"
Set-Location $relayDir

Write-Info "Instalando dependencias del relay..."
# Se instala solo relay-daemon, fuera del workspace pnpm. Esto evita que
# Windows cargue dependencias y restricciones especificas del entorno Linux.
npm.cmd install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
    Write-Host "La instalacion de dependencias del relay ha fallado." -ForegroundColor Red
    exit 1
}

Write-Info "Compilando relay daemon..."
npm.cmd run build
if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$INSTALL_DIR\artifacts\relay-daemon\dist\main.mjs")) {
    Write-Host "La compilacion del relay ha fallado o no ha generado dist\main.mjs." -ForegroundColor Red
    Write-Host "Revisa el mensaje anterior y vuelve a ejecutar el instalador." -ForegroundColor Red
    exit 1
}
Write-Ok "Compilacion completada"

# -- Paso 4: Detectar dispositivos de audio y COM -----------
Write-Step "4/6  Detectando dispositivos"

Write-Host ""
Write-Host "  Entradas de audio DirectShow disponibles:" -ForegroundColor Cyan
$ffmpegPath = (Get-Command ffmpeg -ErrorAction Stop).Source
$ffplayCommand = Get-Command ffplay -ErrorAction SilentlyContinue
if (-not $ffplayCommand) {
    Write-Host "FFplay no esta disponible. Reinstala FFmpeg con winget y vuelve a intentarlo." -ForegroundColor Red
    exit 1
}
$ffplayPath = $ffplayCommand.Source
$captureDevices = @(Get-DirectShowAudioDevices $ffmpegPath)
if ($captureDevices.Count -eq 0) {
    Write-Warn "No se han detectado entradas DirectShow. Conecta la interfaz USB y vuelve a ejecutar el instalador."
} else {
    for ($i = 0; $i -lt $captureDevices.Count; $i++) {
        Write-Host "    $($i + 1). $($captureDevices[$i])"
    }
}

Write-Host ""
Write-Host "  Salidas de audio Windows disponibles (WASAPI):" -ForegroundColor Cyan
$audioEndpoints = @(Get-WindowsAudioEndpoints)
$playbackDevices = @($audioEndpoints | Where-Object {
    $_ -match "(?i)(speaker|speakers|altavoz|altavoces|headphone|headphones|auricular|auriculares|output|salida|line out)"
})
if ($playbackDevices.Count -eq 0) {
    $playbackDevices = $audioEndpoints
}
if ($playbackDevices.Count -eq 0) {
    Write-Warn "No se han detectado salidas de audio Windows. Puedes introducir el nombre manualmente."
} else {
    for ($i = 0; $i -lt $playbackDevices.Count; $i++) {
        Write-Host "    $($i + 1). $($playbackDevices[$i])"
    }
}

Write-Host ""
Write-Host "  Puertos COM disponibles (para PTT serial):" -ForegroundColor Cyan
$serialPorts = @(Get-WmiObject Win32_SerialPort -ErrorAction SilentlyContinue)
if ($serialPorts.Count -eq 0) {
    Write-Host "    (ninguno detectado)"
} else {
    foreach ($serialPort in $serialPorts) {
        Write-Host "    $($serialPort.DeviceID) - $($serialPort.Name)"
    }
}

# -- Paso 5: Configuracion interactiva -----------------------
Write-Step "5/6  Configuracion del relay"
Write-Host ""

$CALLSIGN = Read-RequiredValue "  Callsign del relay (formato 0R-NOMBRE, ej: 0R-WINPC)"
if (-not $CALLSIGN.StartsWith("0R-")) {
    Write-Warn "Se recomienda el formato 0R-NOMBRE para relays"
}

$CAPTURE_DEVICE = Read-DeviceChoice -Prompt "  Selecciona la entrada de audio DirectShow" -Devices $captureDevices
$PLAYBACK_DEVICE = Read-DeviceChoice -Prompt "  Selecciona la salida de audio Windows" -Devices $playbackDevices

if (-not (Test-AudioDevices -FfmpegPath $ffmpegPath -FfplayPath $ffplayPath -CaptureDevice $CAPTURE_DEVICE -PlaybackDevice $PLAYBACK_DEVICE)) {
    Write-Host "La tarea programada no se creara hasta que ambos dispositivos funcionen." -ForegroundColor Red
    exit 1
}

$PTT_DEVICE = ""
while ($true) {
    $PTT_DEVICE = (Read-Host "  Puerto COM para PTT (ej: COM3) [Enter si no hay cable PTT]").Trim()
    if ([string]::IsNullOrWhiteSpace($PTT_DEVICE) -or $PTT_DEVICE -match "^COM\d+$") {
        break
    }
    Write-Warn "El puerto debe tener el formato COM seguido de un numero, o dejarse vacio."
}

$RELAY_TOKEN = Read-Host "  Token/contrasena del relay (facilitado por el administrador)" -AsSecureString
$tokenBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($RELAY_TOKEN)
try {
    $RELAY_TOKEN_PLAIN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenBstr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenBstr)
}

$ROOM   = Read-Host "  Sala eQSO [default: CB]"
if (-not $ROOM) { $ROOM = "CB" }

$SERVER = Read-Host "  Servidor eQSO [default: asorapa.sytes.net]"
if (-not $SERVER) { $SERVER = "asorapa.sytes.net" }

$PORT_INPUT = Read-Host "  Puerto del servidor [default: 2172]"
if (-not $PORT_INPUT) { $PORT_INPUT = "2172" }
[int]$PORT = 0
if (-not [int]::TryParse($PORT_INPUT, [ref]$PORT) -or $PORT -lt 1 -or $PORT -gt 65535) {
    Write-Host "El puerto debe ser un numero entre 1 y 65535." -ForegroundColor Red
    exit 1
}

# -- Crear config JSON --------------------------------------
New-Item -ItemType Directory -Path $CONFIG_DIR -Force | Out-Null

$configPath = "$CONFIG_DIR\$ROOM.json"
$configObject = [ordered]@{
    backend = "ffmpeg"
    callsign = $CALLSIGN
    room = $ROOM
    password = $RELAY_TOKEN_PLAIN
    message = "Radio Enlace CB"
    server = $SERVER
    port = $PORT
    reconnectMinMs = 3000
    reconnectMaxMs = 60000
    audio = [ordered]@{
        captureDevice = $CAPTURE_DEVICE
        playbackDevice = $PLAYBACK_DEVICE
        captureFormat = "dshow"
        playbackFormat = "ffplay"
        vox = $true
        voxThresholdRms = 1500
        voxHangMs = 800
        txGateRms = 50
        inputGain = 0.3
        outputGain = 1.0
        postRxSuppressMs = 2500
        postTxSuppressMs = 1000
    }
    control = [ordered]@{
        enabled = $true
        port = 8009
        host = "127.0.0.1"
    }
    ptt = [ordered]@{
        device = $PTT_DEVICE
        method = "rts"
        inverted = $false
    }
}
$configJson = $configObject | ConvertTo-Json -Depth 10
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($configPath, $configJson + [Environment]::NewLine, $utf8NoBom)
Write-Ok "Configuracion guardada en $configPath"

$RELAY_TOKEN_PLAIN = $null

if (-not (Test-RelayConfig $configPath)) {
    Write-Host "Corrige los datos indicados y vuelve a ejecutar el instalador." -ForegroundColor Red
    exit 1
}
Write-Ok "Configuracion JSON validada"

# -- Paso 6: Instalar como tarea programada -----------------
Write-Step "6/6  Instalando como servicio de Windows"

$nodePath  = (Get-Command node).Source
$scriptDir = "$INSTALL_DIR\artifacts\relay-daemon"

# Crear script de arranque con variables de entorno
$startScript = @"
@echo off
set "RELAY_INSTANCE=$ROOM"
set "NODE_ENV=production"
set "CONFIG_FILE=$configPath"
set "FFMPEG_PATH=$ffmpegPath"
set "FFPLAY_PATH=$ffplayPath"
cd /d "$scriptDir"
"$nodePath" --enable-source-maps dist\main.mjs
"@

$startScriptPath = "$CONFIG_DIR\start-$ROOM.cmd"
$startScript | Out-File -FilePath $startScriptPath -Encoding ascii
Write-Ok "Script de arranque: $startScriptPath"

# Registrar tarea en el Programador de tareas de Windows.
# No usamos New-ScheduledTaskSettingsSet -RestartOnFailure porque ese
# parametro no existe en algunas versiones de Windows PowerShell 5.1.
# El XML mantiene el reinicio automatico y es compatible con esas versiones.
$taskName = "eQSO Relay $ROOM"
$userId = "$env:USERDOMAIN\$env:USERNAME"
$xmlUserId = [System.Security.SecurityElement]::Escape($userId)
$xmlComSpec = [System.Security.SecurityElement]::Escape($env:ComSpec)
$xmlArguments = [System.Security.SecurityElement]::Escape("/c `"$startScriptPath`"")
$taskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>eQSO Relay $ROOM</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <UserId>$xmlUserId</UserId>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$xmlUserId</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>10</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$xmlComSpec</Command>
      <Arguments>$xmlArguments</Arguments>
      <WorkingDirectory>$scriptDir</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

# Eliminar tarea existente si hay
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

try {
    Register-ScheduledTask -TaskName $taskName -Xml $taskXml -Force -ErrorAction Stop | Out-Null
    Get-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
} catch {
    Write-Host "No se pudo registrar la tarea '$taskName'." -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    throw
}

Write-Ok "Tarea programada registrada: '$taskName'"

# Arrancar ahora mismo
Write-Info "Arrancando el relay..."
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3

$taskStatus = (Get-ScheduledTask -TaskName $taskName).State

# -- Resultado ----------------------------------------------
Write-Host ""
if ($taskStatus -eq "Running") {
    Write-Host "  ============================================" -ForegroundColor Green
    Write-Host "    OK  INSTALACION COMPLETADA - Relay ACTIVO" -ForegroundColor Green
    Write-Host "  ============================================" -ForegroundColor Green
} else {
    Write-Host "  ============================================" -ForegroundColor Yellow
    Write-Host "    !  INSTALACION COMPLETADA - Verifica estado" -ForegroundColor Yellow
    Write-Host "  ============================================" -ForegroundColor Yellow
    Write-Warn "Estado de la tarea: $taskStatus"
}

Write-Host ""
Write-Host "  Callsign : $CALLSIGN"
Write-Host "  Servidor : ${SERVER}:${PORT}"
Write-Host "  Sala     : $ROOM"
Write-Host "  Captura  : $CAPTURE_DEVICE"
Write-Host "  Playback : $PLAYBACK_DEVICE"
if ($PTT_DEVICE) { Write-Host "  PTT      : $PTT_DEVICE" } else { Write-Host "  PTT      : deshabilitado" }
Write-Host "  Config   : $configPath"
Write-Host "  Codigo   : $INSTALL_DIR"
Write-Host ""
Write-Host "  Comandos utiles:" -ForegroundColor Cyan
Write-Host "    Ver log en tiempo real:"
Write-Host "      Get-Content `"$CONFIG_DIR\relay-$ROOM.log`" -Wait -Tail 20"
Write-Host "    Parar el relay:"
Write-Host "      Stop-ScheduledTask -TaskName '$taskName'"
Write-Host "    Reiniciar el relay:"
Write-Host "      Stop-ScheduledTask -TaskName '$taskName'; Start-ScheduledTask -TaskName '$taskName'"
Write-Host "    Desinstalar:"
Write-Host "      Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
Write-Host ""
Write-Host "  Calibracion VOX: edita $configPath" -ForegroundColor Cyan
Write-Host "    Sube voxThresholdRms si dispara con ruido de fondo."
Write-Host "    Baja voxThresholdRms si no detecta la voz de la radio."
Write-Host ""

Read-Host "  Pulsa Enter para cerrar"
