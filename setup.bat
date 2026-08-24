@echo off
setlocal
chcp 65001 >nul
set "CAREERPILOT_ROOT=%~dp0"
if not defined CAREERPILOT_USER_DATA_ROOT set "CAREERPILOT_USER_DATA_ROOT=%LOCALAPPDATA%\CareerPilot"
set "NODE_EXE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE (
  echo Node.js was not found. Please install a current LTS version and run setup again.
  pause
  exit /b 1
)
cd /d "%CAREERPILOT_ROOT%"
"%NODE_EXE%" "scripts\setup\first_run_setup.mjs"
if errorlevel 1 (
  echo CareerPilot setup failed.
  pause
  exit /b 1
)
exit /b 0
