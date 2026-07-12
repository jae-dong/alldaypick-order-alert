
$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPath = Join-Path $project "backend"
$patchBackend = Join-Path $project "v34-files\backend"

if (!(Test-Path $backendPath)) {
  Write-Host "ERROR: backend folder not found." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}

Copy-Item (Join-Path $patchBackend "coupang.js") (Join-Path $backendPath "coupang.js") -Force
Copy-Item (Join-Path $patchBackend "coupang-claims.js") (Join-Path $backendPath "coupang-claims.js") -Force
Copy-Item (Join-Path $patchBackend "smartstore.js") (Join-Path $backendPath "smartstore.js") -Force
Copy-Item (Join-Path $patchBackend "elevenst.js") (Join-Path $backendPath "elevenst.js") -Force
Copy-Item (Join-Path $patchBackend "local-agent.js") (Join-Path $backendPath "local-agent.js") -Force
Copy-Item (Join-Path $patchBackend "package.json") (Join-Path $backendPath "package.json") -Force
Copy-Item (Join-Path $patchBackend ".env.local.example") (Join-Path $backendPath ".env.local.example") -Force

Write-Host ""
Write-Host "SUCCESS: v34 11st connection starter installed." -ForegroundColor Green
Write-Host ""
Write-Host "Next: add ELEVENST_API_KEY to backend\.env.local." -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter"
