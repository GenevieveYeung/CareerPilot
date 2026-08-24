@echo off
setlocal
set "CAREERPILOT_ROOT=%~dp0.."
cd /d "%CAREERPILOT_ROOT%"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  exit /b 1
)
node.exe core\reminder_worker.mjs
exit /b %errorlevel%
