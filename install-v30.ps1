$ErrorActionPreference = "Stop"
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$payload = Join-Path $project "v30-project"
$currentIndex = Join-Path $project "index.html"

if (!(Test-Path $currentIndex)) {
  Write-Host "ERROR: Run this installer inside the alldaypick-order-alert folder." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}

$current = Get-Content -Raw -Encoding UTF8 $currentIndex
$match = [regex]::Match($current, 'const\s+firebaseConfig\s*=\s*(\{.*?\});', [System.Text.RegularExpressions.RegexOptions]::Singleline)
if (!$match.Success) {
  Write-Host "ERROR: Existing Firebase configuration was not found." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}
$config = $match.Groups[1].Value

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path $project "backup-v30-$stamp"
New-Item -ItemType Directory -Path $backup | Out-Null

$backupItems = @("index.html","sw.js","manifest.json","icon.svg","firestore.rules.txt")
foreach ($name in $backupItems) {
  $source = Join-Path $project $name
  if (Test-Path $source) { Copy-Item $source (Join-Path $backup $name) -Force }
}
if (Test-Path (Join-Path $project "backend")) {
  Copy-Item (Join-Path $project "backend") (Join-Path $backup "backend") -Recurse -Force
}

$template = Get-Content -Raw -Encoding UTF8 (Join-Path $payload "index.template.html")
$template = $template.Replace("__FIREBASE_CONFIG__", $config)
Set-Content -Path $currentIndex -Value $template -Encoding UTF8

$sw = Get-Content -Raw -Encoding UTF8 (Join-Path $payload "sw.template.js")
$sw = $sw.Replace("__FIREBASE_CONFIG__", $config)
Set-Content -Path (Join-Path $project "sw.js") -Value $sw -Encoding UTF8

Copy-Item (Join-Path $payload "manifest.json") (Join-Path $project "manifest.json") -Force
Copy-Item (Join-Path $payload "icon.svg") (Join-Path $project "icon.svg") -Force
Copy-Item (Join-Path $payload "firestore.rules.txt") (Join-Path $project "firestore.rules.txt") -Force
Copy-Item (Join-Path $payload ".gitignore") (Join-Path $project ".gitignore") -Force

$targetBackend = Join-Path $project "backend"
if (!(Test-Path $targetBackend)) { New-Item -ItemType Directory -Path $targetBackend | Out-Null }
$envFile = Join-Path $targetBackend ".env.local"
$envBackup = $null
if (Test-Path $envFile) {
  $envBackup = Get-Content -Raw -Encoding UTF8 $envFile
}

Get-ChildItem (Join-Path $payload "backend") -File | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $targetBackend $_.Name) -Force
}

if ($null -ne $envBackup) {
  Set-Content -Path $envFile -Value $envBackup -Encoding UTF8
}

Write-Host ""
Write-Host "SUCCESS: v30 clean project installed." -ForegroundColor Green
Write-Host "Firebase settings and backend .env.local were preserved." -ForegroundColor Green
Write-Host "Backup: $backup" -ForegroundColor Yellow
Write-Host ""
Write-Host "Next: GitHub Desktop Commit and Push, then restart npm run agent." -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter"
