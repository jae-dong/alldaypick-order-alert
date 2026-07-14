
$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Split-Path -Parent $source
$backup = Join-Path $target ("backup-before-clean-" + (Get-Date -Format "yyyyMMdd-HHmmss"))

New-Item -ItemType Directory -Path $backup | Out-Null

$keep = @(
  "index.html","sw.js","manifest.json","icon.svg","firestore.rules.txt",
  "backend\local-agent.js","backend\package.json","backend\package-lock.json",
  "backend\coupang.js","backend\coupang-claims.js","backend\smartstore.js",
  "backend\elevenst.js","backend\lotteon.js","backend\esm.js","backend\poller.js"
)

foreach($file in $keep){
  $existing = Join-Path $target $file
  if(Test-Path $existing){
    $dest = Join-Path $backup $file
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    Copy-Item $existing $dest -Force
  }
}

$envFile = Join-Path $target "backend\.env.local"
$envBackup = $null
if(Test-Path $envFile){
  $envBackup = Get-Content -Raw -Encoding UTF8 $envFile
}

Copy-Item (Join-Path $source "index.html") (Join-Path $target "index.html") -Force
Copy-Item (Join-Path $source "sw.js") (Join-Path $target "sw.js") -Force
Copy-Item (Join-Path $source "manifest.json") (Join-Path $target "manifest.json") -Force
Copy-Item (Join-Path $source "icon.svg") (Join-Path $target "icon.svg") -Force
Copy-Item (Join-Path $source "firestore.rules.txt") (Join-Path $target "firestore.rules.txt") -Force

New-Item -ItemType Directory -Force -Path (Join-Path $target "backend") | Out-Null
Copy-Item (Join-Path $source "backend\*") (Join-Path $target "backend") -Recurse -Force

if($null -ne $envBackup){
  Set-Content -Path $envFile -Value $envBackup -Encoding UTF8
}

Write-Host ""
Write-Host "CLEAN FINAL installed successfully." -ForegroundColor Green
Write-Host "Your backend\.env.local was preserved." -ForegroundColor Cyan
Write-Host "Backup: $backup" -ForegroundColor Yellow
Write-Host ""
Read-Host "Press Enter"
