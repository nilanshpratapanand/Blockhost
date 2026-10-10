@echo off
setlocal
title Blockhost - Minecraft server dashboard
cd /d "%~dp0"

if not exist "%~dp0dashboard\server.js" (
  echo [!] The "dashboard" folder is missing. Put this file and the dashboard folder
  echo     inside your Minecraft server folder ^(next to server.jar^).
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Installing Node.js LTS with winget...
  echo ^(Accept the Windows prompt if one appears.^)
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] Could not find Node.js. Install it from https://nodejs.org ^(LTS^), then run this again.
  pause
  exit /b 1
)

for /f "tokens=1 delims=v." %%v in ('node -v') do set "NODEMAJOR=%%v"
if %NODEMAJOR% LSS 22 (
  echo [!] Node.js %NODEMAJOR% is too old. Blockhost needs Node.js 22 or newer.
  echo     Update with:  winget upgrade OpenJS.NodeJS.LTS
  pause
  exit /b 1
)

echo.
echo   Starting Blockhost... your browser will open at http://localhost:8765
echo   Keep this window open while you play. Closing it stops the Minecraft server.
echo.
:run
node --max-old-space-size=192 "%~dp0dashboard\server.js"
set "RC=%ERRORLEVEL%"
if "%RC%"=="2" goto stopped
if not "%RC%"=="0" (
  echo.
  echo   Blockhost stopped unexpectedly - restarting in 5 seconds. Details: dashboard\blockhost-error.log
  timeout /t 5 >nul
  goto run
)
:stopped
echo.
pause
