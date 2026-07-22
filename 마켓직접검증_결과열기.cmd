@echo off
setlocal
set "FILE=%~dp0backend\market-direct-audit.json"
if not exist "%FILE%" (
  echo.
  echo 아직 직접검증 결과 파일이 없습니다.
  echo START_AGENT.cmd를 실행하고 시작 동기화가 끝난 뒤 다시 실행하세요.
  echo.
  pause
  exit /b 1
)
start "" notepad.exe "%FILE%"
exit /b 0
