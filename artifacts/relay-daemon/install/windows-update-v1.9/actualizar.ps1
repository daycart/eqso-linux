# eQSO ASORAPA Relay Windows - actualización v1.9
# Conserva la configuración existente y reemplaza únicamente el programa.
#Requires -Version 5.1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$packageDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$payloadDir = Join-Path $packageDir "dist"
$installDir = Join-Path $env:USERPROFILE "eqso-linux\artifacts\relay-daemon"
$targetDir = Join-Path $installDir "dist"
$taskName = "eQSO Relay CB"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $installDir "backup-dist-$timestamp"

if (-not (Test-Path (Join-Path $payloadDir "main.mjs"))) {
    throw "El paquete no contiene dist\main.mjs."
}
if (-not (Test-Path $installDir)) {
    throw "No se encontró la instalación existente en $installDir."
}

Write-Host "Deteniendo $taskName..."
$stopScript = "C:\eqso-relay\stop-CB.ps1"
if (Test-Path $stopScript) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript
} else {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3

Write-Host "Guardando copia en $backupDir..."
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
if (Test-Path $targetDir) {
    Copy-Item (Join-Path $targetDir "*") $backupDir -Recurse -Force
}

Write-Host "Instalando la versión v1.9..."
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
Copy-Item (Join-Path $payloadDir "*") $targetDir -Recurse -Force

Write-Host "Iniciando $taskName..."
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 8

$logPath = "C:\eqso-relay\relay-CB.log"
if (Test-Path $logPath) {
    Get-Content $logPath -Tail 25
}

Write-Host ""
Write-Host "Versión v1.9 instalada. La configuración CB.json no se ha modificado." -ForegroundColor Green