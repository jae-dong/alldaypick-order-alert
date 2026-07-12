
$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$file = Join-Path $project "backend\local-agent.js"

if (!(Test-Path $file)) {
  Write-Host "ERROR: backend\local-agent.js not found." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}

$text = Get-Content -Raw -Encoding UTF8 $file

$text = $text.Replace(
  "const minutes = source === 'interval' ? 30 : 24 * 60;",
  "const minutes = source === 'interval' ? 30 : 23 * 60 + 59;"
)

$text = $text.Replace(
  "minutes === 1440 ? '최근 24시간' : '최근 30분'",
  "minutes === 1439 ? '최근 23시간 59분' : '최근 30분'"
)

$text = $text.Replace(
  "시작/웹 즉시수집 최근 24시간",
  "시작/웹 즉시수집 최근 23시간 59분"
)

Set-Content -Path $file -Value $text -Encoding UTF8

Write-Host ""
Write-Host "SUCCESS: Coupang time range fixed to 23 hours 59 minutes." -ForegroundColor Green
Write-Host ""
Write-Host "Next: restart npm run agent." -ForegroundColor Cyan
Write-Host ""

Read-Host "Press Enter"
