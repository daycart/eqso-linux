# ============================================================
#  eQSO ASORAPA — Instalador automático de Relay Daemon (Windows)
#  Compatibilidad: Windows 10 / 11 (PowerShell 5.1 o superior)
#
#  Instalación con un solo comando (PowerShell como Administrador):
#    irm https://raw.githubusercontent.com/daycart/eqso-linux/main/artifacts/relay-daemon/install/install-relay.ps1 | iex
#
#  O clonando el repo primero:
#    git clone https://github.com/daycart/eqso-linux
#    powershell -ExecutionPolicy Bypass -File eqso-linux\artifacts\relay-daemon\install\install-relay.ps1
# ============================================================

#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Verificar que somos Administrador ─────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host ""
    Write-Host "  Este script necesita ejecutarse como Administrador." -ForegroundColor Yellow
    Write-Host "  Haz clic derecho en PowerShell → 'Ejecutar como administrador'" -ForegroundColor Yellow
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

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Blue
Write-Host "    eQSO ASORAPA — Instalador Relay Daemon" -ForegroundColor Blue
Write-Host "  ============================================" -ForegroundColor Blue
Write-Host "  Instala el nodo de radioenlace eQSO en Windows."
Write-Host ""

# ── Función auxiliar: instalar con winget ─────────────────
function Install-WithWinget {
    param($Id, $Name)
    $installed = winget list --id $Id --accept-source-agreements 2>$null | Select-String $Id
    if (-not $installed) {
        Write-Info "Instalando $Name via winget..."
        winget install --id $Id --silent --accept-source-agreements --accept-package-agreements
        # Actualizar PATH en la sesión actual
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    } else {
        Write-Ok "$Name ya instalado"
    }
}

# ── Paso 1: Dependencias ───────────────────────────────────
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

# ── Paso 2: pnpm ───────────────────────────────────────────
Write-Step "2/6  Instalando pnpm"

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Info "Instalando pnpm..."
    npm install -g pnpm
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}
Write-Ok "pnpm $(pnpm --version 2>$null)"

# ── Paso 3: Código fuente ──────────────────────────────────
Write-Step "3/6  Código fuente"

if (Test-Path "$INSTALL_DIR\.git") {
    Write-Info "Repositorio existente → actualizando..."
    git -C $INSTALL_DIR pull --quiet
    Write-Ok "Código actualizado"
} else {
    Write-Info "Clonando repositorio en $INSTALL_DIR ..."
    git clone --quiet $REPO_URL $INSTALL_DIR
    Write-Ok "Repositorio clonado"
}

Set-Location $INSTALL_DIR

Write-Info "Instalando dependencias npm..."
pnpm install --reporter=silent 2>&1 | Where-Object { $_ -notmatch "^$|WARN|onlyBuiltDependencies|pnpm field" } | Out-Host

Write-Info "Compilando relay daemon..."
pnpm --filter "@workspace/relay-daemon" run build
Write-Ok "Compilación completada"

# ── Paso 4: Detectar dispositivos de audio y COM ──────────
Write-Step "4/6  Detectando dispositivos"

Write-Host ""
Write-Host "  Dispositivos de audio USB disponibles (copia el nombre exacto):" -ForegroundColor Cyan
ffmpeg -list_devices true -f dshow -i dummy 2>&1 | Select-String '".*"' | ForEach-Object {
    Write-Host "    $_"
}

Write-Host ""
Write-Host "  Puertos COM disponibles (para PTT serial):" -ForegroundColor Cyan
Get-WmiObject Win32_SerialPort 2>$null | ForEach-Object {
    Write-Host "    $($_.DeviceID)  — $($_.Name)"
}
if (-not (Get-WmiObject Win32_SerialPort 2>$null)) {
    Write-Host "    (ninguno detectado)"
}

# ── Paso 5: Configuración interactiva ─────────────────────
Write-Step "5/6  Configuración del relay"
Write-Host ""

$CALLSIGN = Read-Host "  Callsign del relay (formato 0R-NOMBRE, ej: 0R-WINPC)"
if (-not $CALLSIGN.StartsWith("0R-")) {
    Write-Warn "Se recomienda el formato 0R-NOMBRE para relays"
}

$AUDIO_DEVICE = Read-Host "  Nombre exacto del dispositivo de audio (copia de la lista anterior)"

$PTT_DEVICE = Read-Host "  Puerto COM para PTT (ej: COM3) [Enter si no hay cable PTT]"

$RELAY_TOKEN = Read-Host "  Token/contraseña del relay (facilitado por el administrador)" -AsSecureString
$RELAY_TOKEN_PLAIN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($RELAY_TOKEN))

$ROOM   = Read-Host "  Sala eQSO [default: CB]"
if (-not $ROOM) { $ROOM = "CB" }

$SERVER = Read-Host "  Servidor eQSO [default: asorapa.sytes.net]"
if (-not $SERVER) { $SERVER = "asorapa.sytes.net" }

$PORT   = Read-Host "  Puerto del servidor [default: 2172]"
if (-not $PORT) { $PORT = "2172" }

# ── Crear config JSON ─────────────────────────────────────
New-Item -ItemType Directory -Path $CONFIG_DIR -Force | Out-Null

$configJson = @"
{
  "backend": "ffmpeg",
  "callsign": "$CALLSIGN",
  "room": "$ROOM",
  "password": "$RELAY_TOKEN_PLAIN",
  "message": "Radio Enlace CB",
  "server": "$SERVER",
  "port": $PORT,
  "audio": {
    "captureDevice":   "$AUDIO_DEVICE",
    "playbackDevice":  "$AUDIO_DEVICE",
    "captureFormat":   "dshow",
    "playbackFormat":  "wasapi",
    "vox": true,
    "voxThresholdRms": 1500,
    "voxHangMs": 5000,
    "txGateRms": 50,
    "inputGain": 0.3,
    "outputGain": 1.0,
    "postRxSuppressMs": 6000
  },
  "ptt": {
    "device": "$PTT_DEVICE",
    "method": "rts",
    "inverted": false
  }
}
"@

$configPath = "$CONFIG_DIR\$ROOM.json"
$configJson | Out-File -FilePath $configPath -Encoding utf8
Write-Ok "Configuración guardada en $configPath"

# ── Paso 6: Instalar como tarea programada ────────────────
Write-Step "6/6  Instalando como servicio de Windows"

$nodePath  = (Get-Command node).Source
$scriptDir = "$INSTALL_DIR\artifacts\relay-daemon"

# Crear script de arranque con variables de entorno
$startScript = @"
@echo off
set RELAY_INSTANCE=$ROOM
set NODE_ENV=production
set CONFIG_FILE=$configPath
cd /d "$scriptDir"
"$nodePath" --enable-source-maps dist\main.mjs
"@

$startScriptPath = "$CONFIG_DIR\start-$ROOM.cmd"
$startScript | Out-File -FilePath $startScriptPath -Encoding ascii
Write-Ok "Script de arranque: $startScriptPath"

# Registrar tarea en el Programador de tareas de Windows
$taskName = "eQSO Relay $ROOM"
$action   = New-ScheduledTaskAction -Execute $startScriptPath
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
    -RestartOnFailure `
    -RestartInterval  (New-TimeSpan -Minutes 1) `
    -RestartCount     10 `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

# Eliminar tarea existente si hay
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName $taskName `
    -Action   $action `
    -Trigger  $trigger `
    -Settings $settings `
    -RunLevel Highest `
    -Force | Out-Null

Write-Ok "Tarea programada registrada: '$taskName'"

# Arrancar ahora mismo
Write-Info "Arrancando el relay..."
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3

$taskStatus = (Get-ScheduledTask -TaskName $taskName).State

# ── Resultado ─────────────────────────────────────────────
Write-Host ""
if ($taskStatus -eq "Running") {
    Write-Host "  ============================================" -ForegroundColor Green
    Write-Host "    OK  INSTALACION COMPLETADA — Relay ACTIVO" -ForegroundColor Green
    Write-Host "  ============================================" -ForegroundColor Green
} else {
    Write-Host "  ============================================" -ForegroundColor Yellow
    Write-Host "    !  INSTALACION COMPLETADA — Verifica estado" -ForegroundColor Yellow
    Write-Host "  ============================================" -ForegroundColor Yellow
    Write-Warn "Estado de la tarea: $taskStatus"
}

Write-Host ""
Write-Host "  Callsign : $CALLSIGN"
Write-Host "  Servidor : ${SERVER}:${PORT}"
Write-Host "  Sala     : $ROOM"
Write-Host "  Audio    : $AUDIO_DEVICE"
if ($PTT_DEVICE) { Write-Host "  PTT      : $PTT_DEVICE" } else { Write-Host "  PTT      : deshabilitado" }
Write-Host "  Config   : $configPath"
Write-Host "  Código   : $INSTALL_DIR"
Write-Host ""
Write-Host "  Comandos útiles:" -ForegroundColor Cyan
Write-Host "    Ver log en tiempo real:"
Write-Host "      Get-Content `"$CONFIG_DIR\relay-$ROOM.log`" -Wait -Tail 20"
Write-Host "    Parar el relay:"
Write-Host "      Stop-ScheduledTask -TaskName '$taskName'"
Write-Host "    Reiniciar el relay:"
Write-Host "      Stop-ScheduledTask -TaskName '$taskName'; Start-ScheduledTask -TaskName '$taskName'"
Write-Host "    Desinstalar:"
Write-Host "      Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
Write-Host ""
Write-Host "  Calibración VOX: edita $configPath" -ForegroundColor Cyan
Write-Host "    Sube voxThresholdRms si dispara con ruido de fondo."
Write-Host "    Baja voxThresholdRms si no detecta la voz de la radio."
Write-Host ""

Read-Host "  Pulsa Enter para cerrar"
