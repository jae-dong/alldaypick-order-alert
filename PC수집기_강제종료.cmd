@echo off
setlocal
set "LOCK=%~dp0backend\.agent-running.lock"

if not exist "%LOCK%" (
  echo No running ALLDAYPICK agent lock was found.
  pause
  exit /b 0
)

set /p AGENT_PID=<"%LOCK%"
if not defined AGENT_PID (
  del /F /Q "%LOCK%" >nul 2>nul
  echo Empty lock file removed.
  pause
  exit /b 0
)

taskkill /F /PID %AGENT_PID% >nul 2>nul
if errorlevel 1 (
  echo The saved process was not running. Removing the stale lock.
) else (
  echo ALLDAYPICK order agent was stopped. PID: %AGENT_PID%
)

del /F /Q "%LOCK%" >nul 2>nul
pause
