
$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexPath = Join-Path $project "index.html"
$swPath = Join-Path $project "sw.js"

if (!(Test-Path $indexPath)) {
  Write-Host "ERROR: index.html not found." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}

$html = Get-Content -Raw -Encoding UTF8 $indexPath

$html = $html.Replace("button.remove();","button.style.display='none';")
$html = $html.Replace("section.remove();","section.style.display='none';")

$old = "document.getElementById('v50UpdateTime').textContent="
$new = "const __v50Update=document.getElementById('v50UpdateTime'); if(__v50Update) __v50Update.textContent="
$html = $html.Replace($old,$new)

$stamp=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$html=[regex]::Replace(
  $html,
  "order-alert-v\d+(-\d+)?",
  "order-alert-v51-$stamp"
)

Set-Content -Path $indexPath -Value $html -Encoding UTF8

if(Test-Path $swPath){
  $sw=Get-Content -Raw -Encoding UTF8 $swPath
  $sw=[regex]::Replace(
    $sw,
    "order-alert-v\d+(-\d+)?",
    "order-alert-v51-$stamp"
  )
  Set-Content -Path $swPath -Value $sw -Encoding UTF8
}

Write-Host ""
Write-Host "SUCCESS: v51 cloud initialization hotfix installed." -ForegroundColor Green
Write-Host ""
Read-Host "Press Enter"
