param(
  [Parameter(Mandatory=$true)]
  [string]$ProjectDir
)

$ErrorActionPreference = 'SilentlyContinue'
$ProjectDir = [System.IO.Path]::GetFullPath($ProjectDir)
$currentNote = '변경내역_v7.7.33.txt'

$patterns = @(
  '배포전_검증결과*.txt',
  '업데이트내역*.txt',
  '적용방법*.txt',
  '변경내역_v*.txt',
  '*.tmp',
  '*.bak'
)

foreach ($pattern in $patterns) {
  Get-ChildItem -LiteralPath $ProjectDir -File -Filter $pattern | ForEach-Object {
    if ($_.Name -ne $currentNote) {
      Remove-Item -LiteralPath $_.FullName -Force
    }
  }
}

$junkDirs = @('__pycache__', '.pytest_cache')
foreach ($dirName in $junkDirs) {
  Get-ChildItem -LiteralPath $ProjectDir -Directory -Recurse -Filter $dirName | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force
  }
}
