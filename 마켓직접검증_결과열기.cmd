@echo off
setlocal
set "FILE=%~dp0backend\market-direct-audit.json"
if not exist "%FILE%" (
  echo.
  echo Audit result file was not found.
  echo Run START_AGENT.cmd and wait for the first synchronization to finish.
  echo.
  pause
  exit /b 1
)
start "" notepad.exe "%FILE%"
exit /b 0
