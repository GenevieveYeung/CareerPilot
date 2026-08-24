@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODE_EXE="
if not defined NODE_EXE for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE (
  echo Node.js was not found. Please install Node.js or add it to PATH.
  pause
  exit /b 1
)

rem Reuse an already running local dashboard instead of starting a second server.
start "CareerPilot Server" /min "%NODE_EXE%" "%~dp0server.js"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0wait-dashboard.ps1" -Port 8420 -TimeoutSeconds 45
if errorlevel 1 (
  echo CareerPilot backend did not become ready. Check the local CareerPilot logs folder.
  pause
  exit /b 1
)
set "BROWSER_EXE="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "BROWSER_EXE=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not defined BROWSER_EXE if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" set "BROWSER_EXE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if defined BROWSER_EXE (start "" "%BROWSER_EXE%" "http://127.0.0.1:8420/") else (start "" "http://127.0.0.1:8420/")
