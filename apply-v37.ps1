
$ErrorActionPreference = "Stop"
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPath = Join-Path $project "backend"
$patchBackend = Join-Path $project "v37-files\backend"

if (!(Test-Path $backendPath)) {
  Write-Host "ERROR: backend folder not found." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}

Copy-Item (Join-Path $patchBackend "elevenst.js") (Join-Path $backendPath "elevenst.js") -Force
Copy-Item (Join-Path $patchBackend "local-agent.js") (Join-Path $backendPath "local-agent.js") -Force
Copy-Item (Join-Path $patchBackend "package.json") (Join-Path $backendPath "package.json") -Force

Write-Host ""
Write-Host "SUCCESS: v37 11st status sync installed." -ForegroundColor Green
Write-Host ""
Write-Host "Next: npm install and restart npm run agent." -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter"
