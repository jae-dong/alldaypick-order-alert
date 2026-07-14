@echo off
cd /d "%~dp0"
if not exist ".env.local" (
  echo ERROR: .env.local file not found.
  pause
  exit /b 1
)
if not exist "node_modules" (
  npm config set registry https://registry.npmjs.org/
  call npm install
  if errorlevel 1 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
  )
)
title Alldaypick Order Collector v30
call npm run agent
pause
