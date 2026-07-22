@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "AUDIT_FILE=%CD%\backend\market-direct-audit.json"
if not exist "%AUDIT_FILE%" (
  echo Audit file not found. Run START_AGENT.cmd first and wait for market sync.
  echo Expected: %AUDIT_FILE%
  pause
  exit /b 1
)
start "" "%SystemRoot%\System32\notepad.exe" "%AUDIT_FILE%"
endlocal
exit /b 0
