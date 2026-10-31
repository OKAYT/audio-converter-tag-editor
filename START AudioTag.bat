@echo off
setlocal
title AudioTag - Local Server
cd /d "%~dp0"

set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY where py >nul 2>nul && set "PY=py"
if not defined PY (
  echo.
  echo Python was not found on this PC.
  echo You can still open index.html directly, but the microphone needs this server.
  echo Install Python from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
  echo.
  pause
  exit /b 1
)

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:8000'"

echo.
echo Serving folder:
echo   %CD%
echo.
echo URL: http://localhost:8000
echo Keep this window open while you use the app. Press Ctrl+C to stop.
echo.

%PY% -m http.server 8000
pause
