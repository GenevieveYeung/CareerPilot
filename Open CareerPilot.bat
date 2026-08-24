@echo off
setlocal
chcp 65001 >nul
set "CAREERPILOT_ROOT=%~dp0"
set "APP_ROOT=%CAREERPILOT_ROOT%dashboard"
if not defined CAREERPILOT_USER_DATA_ROOT set "CAREERPILOT_USER_DATA_ROOT=%LOCALAPPDATA%\CareerPilot"
set "NODE_EXE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE (
  echo Node.js was not found. Please install a current LTS version.
  pause
  exit /b 1
)
if not exist "%APP_ROOT%\server.js" (
  echo CareerPilot server files were not found.
  pause
  exit /b 1
)
if not exist "%CAREERPILOT_USER_DATA_ROOT%\config\settings.json" (
  call "%CAREERPILOT_ROOT%setup.bat"
  if errorlevel 1 exit /b 1
)

powershell.exe -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8420/api/health' -TimeoutSec 2; $j=$r.Content|ConvertFrom-Json; if($j.ready -eq $true){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>&1
if errorlevel 1 start "CareerPilot Server" /min "%NODE_EXE%" "%APP_ROOT%\server.js"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%APP_ROOT%\wait-dashboard.ps1" -Port 8420 -TimeoutSeconds 45
if errorlevel 1 (
  echo CareerPilot backend did not become ready.
  pause
  exit /b 1
)

start "" "http://127.0.0.1:8420/"
exit /b 0
