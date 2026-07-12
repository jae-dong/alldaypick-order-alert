
$ErrorActionPreference = "Stop"
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $project "backend"
$patch = Join-Path $project "v23-files\backend"

if (!(Test-Path $backend)) {
  Write-Host "ERROR: backend folder not found." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}

Copy-Item (Join-Path $patch "coupang.js") (Join-Path $backend "coupang.js") -Force
Copy-Item (Join-Path $patch "coupang-claims.js") (Join-Path $backend "coupang-claims.js") -Force
Copy-Item (Join-Path $patch "local-agent.js") (Join-Path $backend "local-agent.js") -Force

Write-Host ""
Write-Host "SUCCESS: v23 cancel-return-exchange sync installed." -ForegroundColor Green
Write-Host ""
Write-Host "Next: restart npm run agent." -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter"
