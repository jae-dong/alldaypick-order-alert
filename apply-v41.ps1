
$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPath = Join-Path $project "backend"
$patchBackend = Join-Path $project "v41-files\backend"

if (!(Test-Path $backendPath)) {
  Write-Host "ERROR: backend folder not found." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}

Copy-Item (Join-Path $patchBackend "local-agent.js") (Join-Path $backendPath "local-agent.js") -Force
Copy-Item (Join-Path $patchBackend "package.json") (Join-Path $backendPath "package.json") -Force
Copy-Item (Join-Path $patchBackend ".env.local.example") (Join-Path $backendPath ".env.local.example") -Force
Copy-Item (Join-Path $patchBackend "lotteon.js") (Join-Path $backendPath "lotteon.js") -Force

Write-Host ""
Write-Host "SUCCESS: v41 LotteON authentication installed." -ForegroundColor Green
Write-Host ""
Write-Host "Next: add LOTTEON_API_KEY and LOTTEON_SELLER_ID to backend\.env.local." -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter"
