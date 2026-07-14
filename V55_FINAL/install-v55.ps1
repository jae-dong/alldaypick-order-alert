
$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Split-Path -Parent $source
$backup = Join-Path $target ("backup-before-v55-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Force -Path $backup | Out-Null

$envPath = Join-Path $target "backend\.env.local"
$envContent = $null
if(Test-Path $envPath){$envContent=Get-Content -Raw -Encoding UTF8 $envPath}

@("index.html","sw.js","manifest.json","icon.svg","firestore.rules.txt") | ForEach-Object {
  $old=Join-Path $target $_
  if(Test-Path $old){Copy-Item $old (Join-Path $backup $_) -Force}
  Copy-Item (Join-Path $source $_) (Join-Path $target $_) -Force
}

New-Item -ItemType Directory -Force -Path (Join-Path $target "backend") | Out-Null
Copy-Item (Join-Path $source "backend\*") (Join-Path $target "backend") -Recurse -Force

if($null -ne $envContent){Set-Content -Path $envPath -Value $envContent -Encoding UTF8}

Write-Host ""
Write-Host "v55 installed successfully." -ForegroundColor Green
Write-Host "backend\.env.local preserved." -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter"
