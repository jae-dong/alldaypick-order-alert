@echo off
chcp 65001 >nul
setlocal

echo.
echo ===============================================
echo  기존 프로젝트 설정 가져오기
echo ===============================================
echo.
echo 기존 alldaypick-order-alert 폴더의 전체 경로를 붙여넣으세요.
echo 예: C:\Users\사용자\OneDrive\문서\GitHub\alldaypick-order-alert
echo.
set /p "OLD=기존 프로젝트 경로: "

if not exist "%OLD%\backend\.env.local" (
  echo.
  echo [오류] backend\.env.local을 찾지 못했습니다.
  pause
  exit /b 1
)

if exist "%OLD%\.git" (
  echo Git 기록 복사 중...
  xcopy "%OLD%\.git" "%~dp0.git\" /E /I /H /Y >nul
)

copy /Y "%OLD%\backend\.env.local" "%~dp0backend\.env.local" >nul

if exist "%OLD%\backend\.telegram-alert-ledger.json" (
  copy /Y "%OLD%\backend\.telegram-alert-ledger.json" "%~dp0backend\.telegram-alert-ledger.json" >nul
)

if exist "%~dp0backend\.agent-running.lock" (
  del /F /Q "%~dp0backend\.agent-running.lock"
)

echo.
echo 설정 가져오기 완료
echo.
echo 이제 이 새 폴더를 GitHub Desktop에서 열어 주세요.
pause
