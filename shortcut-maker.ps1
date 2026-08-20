$ErrorActionPreference = "Stop"
$ProjectDir = $PSScriptRoot
$Target = Join-Path $ProjectDir "START_AGENT.cmd"
$Icon = Join-Path $ProjectDir "주문알림.ico"
if (-not (Test-Path -LiteralPath $Target)) {
  Write-Host "[오류] START_AGENT.cmd를 찾을 수 없습니다." -ForegroundColor Red
  exit 1
}
$Desktop = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $Desktop "올데이픽 주문알림.lnk"
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $Target
$Shortcut.WorkingDirectory = $ProjectDir
$Shortcut.Description = "올데이픽 쇼핑몰 주문알림 PC 수집기 시작"
if (Test-Path -LiteralPath $Icon) { $Shortcut.IconLocation = "$Icon,0" }
$Shortcut.Save()
Write-Host "완료: 바탕화면에 '올데이픽 주문알림' 아이콘을 만들었습니다." -ForegroundColor Green
