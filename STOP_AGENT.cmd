@echo off
setlocal
set "BACKEND=%~dp0backend"
set "LOCK=%BACKEND%\.agent-running.lock"
set "STOPMARK=%BACKEND%\.agent-stop-requested"

>"%STOPMARK%" echo stop

if not exist "%LOCK%" (
  echo No running ALLDAYPICK agent lock was found.
  echo Stop request marker created so auto-restart will not relaunch it.
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
