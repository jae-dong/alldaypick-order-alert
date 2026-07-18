@echo off
setlocal
title ALLDAYPICK ORDER AGENT v7.1.1

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"

if not exist "%BACKEND%\package.json" (
  echo.
  echo [ERROR] backend\package.json was not found.
  echo Extract the entire ZIP file and run this file inside the project folder.
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

if exist ".agent-running.lock" del /F /Q ".agent-running.lock" >nul 2>nul

if not exist ".env.local" (
  echo.
  echo [ERROR] backend\.env.local is missing.
  echo Restore your existing settings file and try again.
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
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed.
    popd
    pause
    exit /b 1
  )
)

echo.
echo Starting ALLDAYPICK order agent...
echo Keep this window open.
echo.
call npm run agent
set "EXITCODE=%ERRORLEVEL%"
popd
echo.
echo Agent stopped. Exit code: %EXITCODE%
pause
exit /b %EXITCODE%
