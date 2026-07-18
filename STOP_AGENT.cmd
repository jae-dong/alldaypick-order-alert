@echo off
setlocal
taskkill /F /IM node.exe >nul 2>nul
set "BACKEND=%~dp0backend"
if exist "%BACKEND%\.agent-running.lock" del /F /Q "%BACKEND%\.agent-running.lock" >nul 2>nul
echo ALLDAYPICK order agent was stopped.
pause
