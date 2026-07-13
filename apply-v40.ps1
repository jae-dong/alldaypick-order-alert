
$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPath = Join-Path $project "backend"
$patchBackend = Join-Path $project "v40-files\backend"

if (!(Test-Path $backendPath)) {
  Write-Host "ERROR: backend folder not found." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}

Copy-Item (Join-Path $patchBackend "local-agent.js") (Join-Path $backendPath "local-agent.js") -Force
Copy-Item (Join-Path $patchBackend "package.json") (Join-Path $backendPath "package.json") -Force
Copy-Item (Join-Path $patchBackend ".env.local.example") (Join-Path $backendPath ".env.local.example") -Force
Copy-Item (Join-Path $patchBackend "esm.js") (Join-Path $backendPath "esm.js") -Force

Write-Host ""
Write-Host "SUCCESS: v40 fast sync and ESM starter installed." -ForegroundColor Green
Write-Host ""
Write-Host "Next: restart npm run agent." -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter"
