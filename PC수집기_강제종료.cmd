@echo off
chcp 65001 >nul
taskkill /F /IM node.exe >nul 2>nul
cd /d "%~dp0backend"
if exist ".agent-running.lock" del /F /Q ".agent-running.lock"
echo 수집기와 잠금파일을 정리했습니다.
pause
