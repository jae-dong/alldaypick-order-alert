
$ErrorActionPreference = "Stop"

$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Split-Path -Parent $source
$backup = Join-Path $target ("backup-before-v54-" + (Get-Date -Format "yyyyMMdd-HHmmss"))

New-Item -ItemType Directory -Force -Path $backup | Out-Null

$envPath = Join-Path $target "backend\.env.local"
$envContent = $null
if(Test-Path $envPath){
  $envContent = Get-Content -Raw -Encoding UTF8 $envPath
}

$files = @(
  "index.html","sw.js","manifest.json","icon.svg","firestore.rules.txt"
)

foreach($file in $files){
  $old = Join-Path $target $file
  if(Test-Path $old){
    Copy-Item $old (Join-Path $backup $file) -Force
  }
  Copy-Item (Join-Path $source $file) (Join-Path $target $file) -Force
}

New-Item -ItemType Directory -Force -Path (Join-Path $target "backend") | Out-Null
Copy-Item (Join-Path $source "backend\*") (Join-Path $target "backend") -Recurse -Force

if($null -ne $envContent){
  Set-Content -Path $envPath -Value $envContent -Encoding UTF8
}

Write-Host ""
Write-Host "v54 installed successfully." -ForegroundColor Green
Write-Host "backend\.env.local preserved." -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter"
