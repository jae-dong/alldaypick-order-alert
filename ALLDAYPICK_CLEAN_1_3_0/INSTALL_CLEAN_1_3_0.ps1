$ErrorActionPreference = "Stop"
$source=Split-Path -Parent $MyInvocation.MyCommand.Path
$target=Split-Path -Parent $source
$envPath=Join-Path $target "backend\.env.local"
$envContent=$null
if(Test-Path $envPath){$envContent=Get-Content -Raw -Encoding UTF8 $envPath}
@("index.html","app.js","styles.css","sw.js","manifest.json","icon.svg","firestore.rules.txt",".gitignore")|ForEach-Object{Copy-Item (Join-Path $source $_) (Join-Path $target $_) -Force}
New-Item -ItemType Directory -Force -Path (Join-Path $target "backend")|Out-Null
Copy-Item (Join-Path $source "backend\*") (Join-Path $target "backend") -Recurse -Force
if($null -ne $envContent){Set-Content -Path $envPath -Value $envContent -Encoding UTF8}
Write-Host "CLEAN v1.3.0 installed." -ForegroundColor Green
Read-Host "Press Enter"
