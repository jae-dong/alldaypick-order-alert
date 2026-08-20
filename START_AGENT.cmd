@echo off
setlocal EnableExtensions EnableDelayedExpansion
title ALLDAYPICK ORDER AGENT v7.7.33 SELF HEAL

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "STOPMARK=%BACKEND%\.agent-stop-requested"

if not exist "%BACKEND%\package.json" (
  echo.
  echo [ERROR] backend\package.json was not found.
  echo Current folder: %ROOT%
  echo.
  pause
  exit /b 1
)

if exist "%STOPMARK%" del /F /Q "%STOPMARK%" >nul 2>nul

rem Safe cleanup of obsolete update notes and temporary files.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%cleanup-junk.ps1" -ProjectDir "%ROOT%" >nul 2>nul

:START_AGENT
pushd "%BACKEND%"
if errorlevel 1 (
  echo [ERROR] Cannot open backend folder.
  pause
  exit /b 1
)

if exist ".agent-running.lock" (
  set "OLD_AGENT_PID="
  set /p OLD_AGENT_PID=<".agent-running.lock"
  if defined OLD_AGENT_PID (
    set "OLD_AGENT_IMAGE="
    for /f "tokens=1 delims=," %%A in ('tasklist /FI "PID eq !OLD_AGENT_PID!" /FO CSV /NH 2^>nul') do set "OLD_AGENT_IMAGE=%%~A"
    if /I "!OLD_AGENT_IMAGE!"=="node.exe" (
      echo Stopping previous ALLDAYPICK agent automatically. PID: !OLD_AGENT_PID!
      taskkill /F /PID !OLD_AGENT_PID! >nul 2>nul
      timeout /t 1 /nobreak >nul
    ) else (
      echo Removing a stale ALLDAYPICK agent lock.
    )
  )
  del /F /Q ".agent-running.lock" >nul 2>nul
)

if not exist "firebase-service-account.json" (
  echo [ERROR] backend\firebase-service-account.json is missing.
  popd
  pause
  exit /b 1
)
if not exist ".env.local" (
  echo [ERROR] backend\.env.local is missing.
  popd
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not available in PATH.
  popd
  pause
  exit /b 1
)
if not exist "node_modules\" (
  echo Installing required packages...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    popd
    pause
    exit /b 1
  )
)

echo.
echo Starting ALLDAYPICK order agent v7.7.33 SELF HEAL...
echo Keep this window open. If the agent crashes, it will restart automatically.
echo.
call npm run agent
set "EXITCODE=%ERRORLEVEL%"

if exist ".agent-stop-requested" (
  del /F /Q ".agent-stop-requested" >nul 2>nul
  popd
  echo.
  echo ALLDAYPICK agent stopped by user request.
  pause
  exit /b 0
)

popd
echo.
echo [AUTO RECOVERY] Agent stopped unexpectedly. Exit code: %EXITCODE%
echo Restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto START_AGENT
