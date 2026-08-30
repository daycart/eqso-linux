@echo off
setlocal EnableExtensions DisableDelayedExpansion
title eQSO ASORAPA - Instalador Relay Windows

rem Este lanzador se puede abrir con doble clic.
rem Si install-relay.ps1 esta en la misma carpeta, lo usa directamente.
rem Si se descarga solo, obtiene el instalador desde GitHub.
set "SCRIPT_DIR=%~dp0"
set "LOCAL_SCRIPT=%SCRIPT_DIR%install-relay.ps1"
set "REMOTE_URL=https://raw.githubusercontent.com/daycart/eqso-linux/test/windows-relay-installer/artifacts/relay-daemon/install/install-relay.ps1"
set "DOWNLOADED_SCRIPT=%TEMP%\eqso-install-relay-%RANDOM%.ps1"
set "SCRIPT_PATH="
set "DOWNLOADED=0"

echo.
echo  ============================================
echo    eQSO ASORAPA - Instalador Relay Windows
echo  ============================================
echo.

rem Elevar este mismo lanzador antes de iniciar la instalacion.
net session >nul 2>&1
if not "%ERRORLEVEL%"=="0" (
    echo  Se necesitan permisos de Administrador.
    echo  Se abrira una ventana de confirmacion de Windows...
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%ComSpec%' -ArgumentList '/c ""%~f0""' -Verb RunAs"
    if errorlevel 1 (
        echo.
        echo  No se pudo obtener permiso de Administrador.
        pause
        exit /b 1
    )
    exit /b 0
)

if exist "%LOCAL_SCRIPT%" (
    set "SCRIPT_PATH=%LOCAL_SCRIPT%"
    echo  Usando el instalador local.
) else (
    echo  El instalador no esta en esta carpeta.
    echo  Descargando la version actual desde GitHub...
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '%REMOTE_URL%' -OutFile '%DOWNLOADED_SCRIPT%'"
    if errorlevel 1 (
        echo.
        echo  No se pudo descargar el instalador.
        echo  Comprueba la conexion a Internet y vuelve a intentarlo.
        pause
        exit /b 1
    )
    set "SCRIPT_PATH=%DOWNLOADED_SCRIPT%"
    set "DOWNLOADED=1"
)

echo.
echo  Iniciando el instalador...
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_PATH%"
set "EXIT_CODE=%ERRORLEVEL%"

if "%DOWNLOADED%"=="1" del /q "%DOWNLOADED_SCRIPT%" >nul 2>&1

echo.
if "%EXIT_CODE%"=="0" (
    echo  Instalacion finalizada correctamente.
) else (
    echo  La instalacion termino con errores. Codigo: %EXIT_CODE%
)
echo.
pause
exit /b %EXIT_CODE%