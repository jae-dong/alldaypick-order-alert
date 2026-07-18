@echo off
chcp 65001 >nul
cd /d "%~dp0backend"

if exist ".agent-running.lock" del /F /Q ".agent-running.lock"

if not exist "node_modules" (
  echo 필요한 프로그램 설치 중...
  call npm install
  if errorlevel 1 (
    echo npm install 실패
    pause
    exit /b 1
  )
)

echo.
echo 올데이픽 주문 수집기를 시작합니다.
echo 이 검은 창은 닫지 마세요.
echo.
call npm run agent
pause
