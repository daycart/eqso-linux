@echo off
setlocal
title eQSO ASORAPA - Actualizacion Windows v1.9
net session >nul 2>&1
if not "%ERRORLEVEL%"=="0" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%ComSpec%' -ArgumentList '/c ""%~f0""' -Verb RunAs"
  exit /b
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0actualizar.ps1"
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" (
  echo Actualizacion completada.
) else (
  echo La actualizacion termino con errores. Codigo: %CODE%
)
pause
exit /b %CODE%