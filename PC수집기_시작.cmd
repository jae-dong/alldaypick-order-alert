@echo off
setlocal
title ALLDAYPICK ORDER AGENT v7.7.1 FAST PHOTO

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"

if not exist "%BACKEND%\package.json" (
  echo.
  echo [ERROR] backend\package.json was not found.
  echo Extract the entire ZIP and run this file from the project root folder.
  echo Current folder: %ROOT%
  echo.
  pause
  exit /b 1
)

pushd "%BACKEND%"
if errorlevel 1 (
  echo [ERROR] Cannot open backend folder.
  pause
  exit /b 1
)

if exist ".agent-running.lock" (
  echo.
  echo [ERROR] Another order agent may already be running.
  echo Close the old black window first, or run STOP_AGENT.cmd once.
  echo.
  popd
  pause
  exit /b 1
)

if not exist "firebase-service-account.json" (
  echo.
  echo [ERROR] backend\firebase-service-account.json is missing.
  echo Keep the downloaded Firebase JSON in the backend folder with this exact name.
  echo.
  popd
  pause
  exit /b 1
)

if not exist ".env.local" (
  echo.
  echo [ERROR] backend\.env.local is missing.
  echo Restore the settings file before starting the agent.
  echo.
  popd
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js is not installed or not available in PATH.
  echo.
  popd
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing required packages...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed.
    popd
    pause
    exit /b 1
  )
)

echo.
echo Starting ALLDAYPICK order agent v7.7.1 FAST PHOTO...
echo Keep this window open.
echo.
call npm run agent
set "EXITCODE=%ERRORLEVEL%"
popd
echo.
echo Agent stopped. Exit code: %EXITCODE%
pause
exit /b %EXITCODE%
