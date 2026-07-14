
$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexPath = Join-Path $project "index.html"
$swPath = Join-Path $project "sw.js"

if(!(Test-Path $indexPath)){
  Write-Host "ERROR: index.html not found." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}

$stamp=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

$indexBackup=Join-Path $project ("index-before-v59-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".html")
Copy-Item $indexPath $indexBackup -Force

$html=Get-Content -Raw -Encoding UTF8 $indexPath

# renderStatus에서 존재하지 않는 dedupeInfo를 직접 참조해 전체 JS가 중단되는 문제 수정
$html=$html.Replace(
  "$('dedupeInfo').textContent='미처리 주문은 날짜가 지나도 계속 표시 · 기준 오전 7:45';",
  "const dedupeInfo=$('dedupeInfo'); if(dedupeInfo){dedupeInfo.textContent='실제 미처리 상태만 표시 · 완료 시 자동 제외';}"
)

# 이미 다른 문구로 교체돼 있어도 안전하게 방어
$html=[regex]::Replace(
  $html,
  "\$\('dedupeInfo'\)\.textContent\s*=\s*([^;]+);",
  "const dedupeInfo=$('dedupeInfo'); if(dedupeInfo){dedupeInfo.textContent=`$1;}",
  1
)

# statusGrid 자체가 없을 경우에도 화면 전체가 멈추지 않도록 방어
$html=$html.Replace(
  "$('statusGrid').innerHTML=STATUS_ITEMS.map",
  "const statusGrid=$('statusGrid'); if(!statusGrid){return;} statusGrid.innerHTML=STATUS_ITEMS.map"
)

$html=$html.Replace(
  "$('statusGrid').querySelectorAll('button').forEach",
  "statusGrid.querySelectorAll('button').forEach"
)

# 캐시 버전 강제 변경
$html=[regex]::Replace(
  $html,
  "order-alert-v\d+(-\d+)?",
  "order-alert-v59-$stamp"
)

$html=[regex]::Replace(
  $html,
  "sw\.js\?v=[^'`""]+",
  "sw.js?v=v59-$stamp"
)

Set-Content -Path $indexPath -Value $html -Encoding UTF8

if(Test-Path $swPath){
  $swBackup=Join-Path $project ("sw-before-v59-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".js")
  Copy-Item $swPath $swBackup -Force

  $sw=@"
const CACHE='alldaypick-order-alert-v59-$stamp';
const STATIC=['./','./index.html','./manifest.json','./icon.svg'];

self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE)
      .then(cache=>cache.addAll(STATIC))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(
        keys
          .filter(key=>key!==CACHE)
          .map(key=>caches.delete(key))
      ))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',event=>{
  const request=event.request;
  const url=new URL(request.url);

  if(
    request.method!=='GET' ||
    !['http:','https:'].includes(url.protocol)
  ){
    return;
  }

  if(request.mode==='navigate'){
    event.respondWith(
      fetch(request,{cache:'no-store'})
        .then(response=>{
          if(response.ok&&url.origin===self.location.origin){
            const copy=response.clone();
            caches.open(CACHE)
              .then(cache=>cache.put('./index.html',copy))
              .catch(()=>{});
          }

          return response;
        })
        .catch(()=>caches.match('./index.html'))
    );

    return;
  }

  event.respondWith(
    fetch(request)
      .then(response=>{
        if(
          response.ok &&
          url.origin===self.location.origin
        ){
          const copy=response.clone();

          caches.open(CACHE)
            .then(cache=>cache.put(request,copy))
            .catch(()=>{});
        }

        return response;
      })
      .catch(()=>caches.match(request))
  );
});
"@

  Set-Content -Path $swPath -Value $sw -Encoding UTF8
}

Write-Host ""
Write-Host "SUCCESS: v59 render and service-worker hotfix installed." -ForegroundColor Green
Write-Host "Backup: $indexBackup" -ForegroundColor Yellow
Write-Host ""
Read-Host "Press Enter"
