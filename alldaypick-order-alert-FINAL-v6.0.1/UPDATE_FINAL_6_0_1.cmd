@echo off
chcp 65001 >nul
setlocal
set "SOURCE=%~dp0"
set "TARGET=%~dp0.."

echo FINAL v6.0.1 업데이트를 적용합니다.

if not exist "%TARGET%\backend\.env.local" (
  echo [오류] 이 업데이트 폴더를 기존 프로젝트 폴더 안에 넣어주세요.
  pause
  exit /b 1
)

if exist "%TARGET%\backend\.agent-running.lock" del /F /Q "%TARGET%\backend\.agent-running.lock"

copy /Y "%SOURCE%index.html" "%TARGET%\index.html" >nul
copy /Y "%SOURCE%app.js" "%TARGET%\app.js" >nul
copy /Y "%SOURCE%styles.css" "%TARGET%\styles.css" >nul
copy /Y "%SOURCE%sw.js" "%TARGET%\sw.js" >nul
copy /Y "%SOURCE%manifest.json" "%TARGET%\manifest.json" >nul
copy /Y "%SOURCE%icon.svg" "%TARGET%\icon.svg" >nul
copy /Y "%SOURCE%firestore.rules.txt" "%TARGET%\firestore.rules.txt" >nul
copy /Y "%SOURCE%.gitignore" "%TARGET%\.gitignore" >nul
xcopy "%SOURCE%backend\*" "%TARGET%\backend\" /E /I /Y >nul

echo 업데이트 완료
pause
