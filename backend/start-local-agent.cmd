@echo off
cd /d "%~dp0"
if not exist ".env.local" (
  echo [오류] backend\.env.local 파일이 없습니다.
  echo .env.local.example 파일을 복사해 .env.local로 이름을 바꾸고 값을 입력하세요.
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo 필요한 패키지를 설치합니다...
  call npm install
)
title 올데이픽 주문 자동수집기
call npm run agent
pause
