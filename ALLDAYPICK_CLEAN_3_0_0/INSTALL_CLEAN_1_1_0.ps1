$ErrorActionPreference = "Stop"

$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Split-Path -Parent $source
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path $target "backup-before-clean-v1.1.0-$stamp"

if(!(Test-Path (Join-Path $target ".git"))){
  Write-Host "ERROR: ALLDAYPICK_CLEAN_1_1_0 must be directly inside the GitHub project folder." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}

New-Item -ItemType Directory -Force -Path $backup | Out-Null

$envPath = Join-Path $target "backend\.env.local"
$envContent = $null

if(Test-Path $envPath){
  $envContent = Get-Content -Raw -Encoding UTF8 $envPath
}

@(
  "index.html",
  "app.js",
  "styles.css",
  "sw.js",
  "manifest.json",
  "icon.svg",
  "firestore.rules.txt",
  ".gitignore"
) | ForEach-Object {
  $old = Join-Path $target $_

  if(Test-Path $old){
    Copy-Item $old (Join-Path $backup $_) -Force
  }

  Copy-Item (Join-Path $source $_) $old -Force
}

if(Test-Path (Join-Path $target "backend")){
  Copy-Item (Join-Path $target "backend") (Join-Path $backup "backend") -Recurse -Force
}

New-Item -ItemType Directory -Force -Path (Join-Path $target "backend") | Out-Null
Copy-Item (Join-Path $source "backend\*") (Join-Path $target "backend") -Recurse -Force

if($null -ne $envContent){
  Set-Content -Path $envPath -Value $envContent -Encoding UTF8
}

Write-Host ""
Write-Host "CLEAN v1.1.0 installed to the repository root." -ForegroundColor Green
Write-Host "backend\.env.local preserved." -ForegroundColor Cyan
Write-Host "Old version folders were not copied into this clean package." -ForegroundColor Yellow
Write-Host ""
Read-Host "Press Enter"
