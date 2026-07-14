
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

$backup = Join-Path $project ("index-before-v56-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".html")
Copy-Item $indexPath $backup -Force

# 동적 Firebase 로더 블록을 제거합니다.
$loaderPattern = '(?s)<script>\s*function loadFirebaseFile\(primary,fallback\).*?window\.firebaseReady=\(async\(\)=>\{.*?\}\)\(\);\s*</script>'

$staticFirebase = @'
<script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js"></script>
<script>
window.firebaseReady=Promise.resolve(true);
</script>
'@

if([regex]::IsMatch($html,$loaderPattern)){
  $html=[regex]::Replace(
    $html,
    $loaderPattern,
    $staticFirebase,
    1
  )
}else{
  # 블록을 못 찾은 경우에도 body 시작 직전에 고정 SDK를 추가합니다.
  if($html -notmatch 'firebase-app-compat\.js'){
    $html=$html.Replace(
      '</head>',
      $staticFirebase + "`r`n</head>"
    )
  }

  $html=[regex]::Replace(
    $html,
    'window\.firebaseReady\s*=\s*\(async\(\)=>\{.*?\}\)\(\);',
    'window.firebaseReady=Promise.resolve(true);',
    1,
    [System.Text.RegularExpressions.RegexOptions]::Singleline
  )
}

# 클라우드 로딩 상태가 20초 이상 멈추면 실제 오류를 표시하고 재연결합니다.
if($html -notmatch 'V56_FIREBASE_WATCHDOG'){
$watchdog = @'
<script id="V56_FIREBASE_WATCHDOG">
(function(){
  let attempts=0;

  function checkFirebase(){
    attempts+=1;

    const status=document.getElementById('cloudStatus');
    const text=status?.textContent||'';

    if(window.firebase&&typeof window.initCloud==='function'){
      if(
        text.includes('Firebase SDK') ||
        text.includes('연결 준비')
      ){
        window.initCloud();
      }
      return;
    }

    if(attempts>=10&&status){
      status.textContent=
        'Firebase SDK 연결 실패 · 인터넷 또는 광고차단 설정을 확인하세요.';
    }

    if(attempts<15){
      setTimeout(checkFirebase,2000);
    }
  }

  window.addEventListener('load',()=>{
    setTimeout(checkFirebase,1000);
  });
})();
</script>
'@

  $html=$html.Replace('</body>',$watchdog + "`r`n</body>")
}

$stamp=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

$html=[regex]::Replace(
  $html,
  'alldaypick-clean-v\d+',
  "alldaypick-clean-v56-$stamp"
)

$html=[regex]::Replace(
  $html,
  'sw\.js\?v=[^''"]+',
  "sw.js?v=v56-$stamp"
)

Set-Content -Path $indexPath -Value $html -Encoding UTF8

if(Test-Path $swPath){
  $sw=Get-Content -Raw -Encoding UTF8 $swPath
  $sw=[regex]::Replace(
    $sw,
    "const CACHE='[^']+';",
    "const CACHE='alldaypick-clean-v56-$stamp';"
  )
  Set-Content -Path $swPath -Value $sw -Encoding UTF8
}

Write-Host ""
Write-Host "SUCCESS: v56 Firebase loader fixed." -ForegroundColor Green
Write-Host "Backup: $backup" -ForegroundColor Yellow
Write-Host ""
Read-Host "Press Enter"
