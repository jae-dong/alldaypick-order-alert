@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "LEDGER_FILE=%CD%\backend\.daily-order-ledger-v2.json"
if not exist "%LEDGER_FILE%" (
  echo Daily ledger not found. Run START_AGENT.cmd and wait for all market syncs.
  echo Expected: %LEDGER_FILE%
  pause
  exit /b 1
)
start "" "%SystemRoot%\System32\notepad.exe" "%LEDGER_FILE%"
endlocal
exit /b 0
