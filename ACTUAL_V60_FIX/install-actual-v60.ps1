$ErrorActionPreference = "Stop"

$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Split-Path -Parent $source
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

Copy-Item (Join-Path $target "index.html") (Join-Path $target "index-before-actual-v60-$stamp.html") -Force
Copy-Item (Join-Path $target "sw.js") (Join-Path $target "sw-before-actual-v60-$stamp.js") -Force

Copy-Item (Join-Path $source "index.html") (Join-Path $target "index.html") -Force
Copy-Item (Join-Path $source "sw.js") (Join-Path $target "sw.js") -Force

Write-Host ""
Write-Host "Actual v60 fix installed." -ForegroundColor Green
Write-Host "Only index.html and sw.js were replaced." -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter"
