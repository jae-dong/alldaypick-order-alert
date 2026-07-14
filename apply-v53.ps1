
$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexPath = Join-Path $project "index.html"
$swPath = Join-Path $project "sw.js"
$backendPath = Join-Path $project "backend"
$patchBackend = Join-Path $project "v53-files\backend"

if (!(Test-Path $indexPath)) {
  Write-Host "ERROR: index.html not found." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}

Copy-Item (Join-Path $patchBackend "local-agent.js") (Join-Path $backendPath "local-agent.js") -Force
Copy-Item (Join-Path $patchBackend "package.json") (Join-Path $backendPath "package.json") -Force

$html = Get-Content -Raw -Encoding UTF8 $indexPath

if ($html -match 'V53_STABLE_CLOUD_TELEGRAM') {
  Write-Host "v53 is already installed." -ForegroundColor Yellow
  Read-Host "Press Enter"
  exit 0
}

$style = @'
<style id="V53_STABLE_CLOUD_TELEGRAM">
  #v53CloudLine{
    display:flex;
    align-items:center;
    gap:7px;
    margin-top:5px;
    font-size:12px;
    font-weight:900;
    color:#059669;
  }

  #v53CloudDot{
    width:9px;
    height:9px;
    border-radius:50%;
    background:#10b981;
    box-shadow:0 0 0 3px rgba(16,185,129,.12);
  }

  #v53TelegramTest{
    border:0;
    border-radius:10px;
    min-height:43px;
    padding:9px 12px;
    background:#229ED9;
    color:#fff;
    font-weight:900;
    cursor:pointer;
  }

  #v53TelegramTest:disabled{
    opacity:.6;
    cursor:wait;
  }

  #v53TelegramResult{
    font-size:11px;
    font-weight:800;
    color:#6b7280;
    margin-top:4px;
  }

  @media(max-width:800px){
    /* 접힌 화면에서도 펼친 화면과 동일한 표를 유지합니다. */
    #v52MobileShops{
      display:none!important;
    }

    #v50Shops .v50-table-wrap,
    #v49ShopSection .table-wrap,
    #v46ShopSection .table-wrap{
      display:block!important;
      overflow-x:auto!important;
      -webkit-overflow-scrolling:touch;
    }

    #v50ShopTable,
    #v49ShopTable,
    #v46ShopTable{
      display:table!important;
      min-width:760px!important;
      width:100%!important;
      border-collapse:collapse!important;
    }

    #v50ShopTable thead,
    #v49ShopTable thead,
    #v46ShopTable thead{
      display:table-header-group!important;
    }

    #v50ShopTable tbody,
    #v49ShopTable tbody,
    #v46ShopTable tbody{
      display:table-row-group!important;
    }

    #v50ShopTable tr,
    #v49ShopTable tr,
    #v46ShopTable tr{
      display:table-row!important;
    }

    #v50ShopTable th,
    #v50ShopTable td,
    #v49ShopTable th,
    #v49ShopTable td,
    #v46ShopTable th,
    #v46ShopTable td{
      display:table-cell!important;
      white-space:nowrap!important;
      font-size:11px!important;
      padding:9px 7px!important;
    }

    #v50ShopTable td::before,
    #v49ShopTable td::before,
    #v46ShopTable td::before{
      display:none!important;
      content:none!important;
    }

    #v53TelegramTest{
      width:100%;
    }
  }
</style>
'@

$html = $html.Replace('</head>', $style + "`r`n</head>")

$script = @'
const V53_STABLE_CLOUD_TELEGRAM=true;

(function(){
  const CLOUD_CACHE_KEY='alldaypick-v53-connections';

  function safeOrders(){
    try{
      return Array.isArray(orders)?orders:[];
    }catch{
      return [];
    }
  }

  function readConnectionCards(){
    const map={};

    document
      .querySelectorAll('#integrationGrid .integration-card')
      .forEach(card=>{
        const name=card.querySelector('strong')?.textContent?.trim();
        const badge=card.querySelector('.badge-connect');

        if(!name||!badge) return;

        const connected=
          badge.classList.contains('ready') ||
          badge.textContent.includes('연결됨');

        map[name]={
          connected,
          text:badge.textContent.trim(),
          savedAt:Date.now()
        };
      });

    return map;
  }

  function readCache(){
    try{
      return JSON.parse(
        localStorage.getItem(CLOUD_CACHE_KEY)||'{}'
      );
    }catch{
      return {};
    }
  }

  function saveCache(map){
    if(!Object.keys(map).length) return;

    try{
      localStorage.setItem(
        CLOUD_CACHE_KEY,
        JSON.stringify(map)
      );
    }catch{}
  }

  function restoreConnectionCards(){
    const cache=readCache();

    document
      .querySelectorAll('#integrationGrid .integration-card')
      .forEach(card=>{
        const name=card.querySelector('strong')?.textContent?.trim();
        const badge=card.querySelector('.badge-connect');

        if(!name||!badge||!cache[name]?.connected) return;

        const currentlyConnected=
          badge.classList.contains('ready') ||
          badge.textContent.includes('연결됨');

        if(!currentlyConnected){
          badge.textContent='연결됨';
          badge.classList.add('ready');
          badge.classList.remove('error','off');
          card.dataset.v53Restored='true';
        }
      });
  }

  function cloudLine(){
    const brand=document.querySelector('.brand');

    if(!brand) return;

    let line=document.getElementById('v53CloudLine');

    if(!line){
      line=document.createElement('div');
      line.id='v53CloudLine';
      line.innerHTML=`
        <span id="v53CloudDot"></span>
        <span id="v53CloudText">클라우드 상태 확인 중</span>
      `;
      brand.appendChild(line);
    }

    const cards=readConnectionCards();
    const cached=readCache();
    const merged={...cached,...cards};
    const connected=Object.values(merged)
      .filter(item=>item?.connected)
      .length;
    const total=Math.max(
      Object.keys(merged).length,
      document.querySelectorAll(
        '#integrationGrid .integration-card'
      ).length
    );

    const text=document.getElementById('v53CloudText');

    if(text){
      text.textContent=
        connected
          ? `클라우드 연결 유지 · ${connected}/${total||connected}개 쇼핑몰 정상`
          : '클라우드 데이터 불러오는 중';
    }

    document.querySelectorAll('.brand p').forEach(p=>{
      if(
        p.textContent.includes('클라우드 초기화 오류') ||
        p.textContent.includes('Cannot set properties of null')
      ){
        p.style.display='none';
      }
    });
  }

  function telegramButton(){
    const actions=document.querySelector('.actions');

    if(!actions) return;

    let wrap=document.getElementById('v53TelegramWrap');

    if(!wrap){
      wrap=document.createElement('div');
      wrap.id='v53TelegramWrap';
      wrap.innerHTML=`
        <button type="button" id="v53TelegramTest">
          텔레그램 테스트
        </button>
        <div id="v53TelegramResult"></div>
      `;

      actions.appendChild(wrap);
    }

    const button=document.getElementById('v53TelegramTest');

    if(button.dataset.bound==='true') return;

    button.dataset.bound='true';

    button.onclick=async()=>{
      button.disabled=true;
      button.textContent='전송 중…';

      const result=document.getElementById('v53TelegramResult');
      result.textContent='수집기에 테스트 전송을 요청했습니다.';

      try{
        if(
          typeof db==='undefined' ||
          !db?.collection
        ){
          throw new Error('클라우드 DB가 아직 준비되지 않았습니다.');
        }

        const requestId=
          `telegram-test-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2,8)}`;

        const ref=db
          .collection('system')
          .doc('commands')
          .collection('requests')
          .doc('coupang');

        await ref.set({
          status:'requested',
          action:'telegram_test',
          requestId,
          requestedAt:
            typeof firebase!=='undefined' &&
            firebase.firestore?.FieldValue
              ? firebase.firestore.FieldValue.serverTimestamp()
              : new Date().toISOString(),
          updatedAt:new Date().toISOString()
        },{merge:true});

        result.textContent=
          '요청 완료 · 텔레그램 메시지를 확인해 주세요.';

        let checks=0;
        const timer=setInterval(async()=>{
          checks+=1;

          try{
            const snap=await ref.get();
            const data=snap.data()||{};

            if(data.requestId!==requestId) return;

            if(data.status==='test_success'){
              clearInterval(timer);
              result.textContent='테스트 성공 · 메시지가 전송됐습니다.';
              button.disabled=false;
              button.textContent='텔레그램 테스트';
            }else if(data.status==='test_error'){
              clearInterval(timer);
              result.textContent=
                `테스트 실패 · ${data.error||'토큰과 Chat ID를 확인하세요.'}`;
              button.disabled=false;
              button.textContent='텔레그램 테스트';
            }
          }catch{}

          if(checks>=15){
            clearInterval(timer);
            result.textContent=
              '응답 대기 중 · 검은 수집기 창이 실행 중인지 확인하세요.';
            button.disabled=false;
            button.textContent='텔레그램 테스트';
          }
        },1000);
      }catch(error){
        result.textContent=
          `요청 실패 · ${error?.message||error}`;
        button.disabled=false;
        button.textContent='텔레그램 테스트';
      }
    };
  }

  function forceSameShopTable(){
    document
      .querySelectorAll('#v52MobileShops')
      .forEach(element=>{
        element.style.display='none';
      });

    document
      .querySelectorAll(
        '#v50Shops .v50-table-wrap,'+
        '#v49ShopSection .table-wrap,'+
        '#v46ShopSection .table-wrap'
      )
      .forEach(element=>{
        element.style.display='block';
      });
  }

  function refresh(){
    const current=readConnectionCards();

    if(
      Object.values(current)
        .some(item=>item.connected)
    ){
      saveCache({
        ...readCache(),
        ...current
      });
    }else{
      restoreConnectionCards();
    }

    cloudLine();
    telegramButton();
    forceSameShopTable();
  }

  const oldRender=
    typeof render==='function'
      ? render
      : null;

  if(oldRender){
    render=function(){
      oldRender();
      setTimeout(refresh,0);
    };
  }

  const observer=new MutationObserver(()=>{
    clearTimeout(window.__v53Refresh);
    window.__v53Refresh=setTimeout(refresh,120);
  });

  observer.observe(
    document.body,
    {
      childList:true,
      subtree:true,
      attributes:true
    }
  );

  setTimeout(refresh,200);
  setTimeout(refresh,1000);
})();
'@

$html = $html.Replace('</script>', $script + "`r`n</script>")

$stamp=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$html=[regex]::Replace(
  $html,
  "order-alert-v\d+(-\d+)?",
  "order-alert-v53-$stamp"
)

Set-Content -Path $indexPath -Value $html -Encoding UTF8

if(Test-Path $swPath){
  $sw=Get-Content -Raw -Encoding UTF8 $swPath
  $sw=[regex]::Replace(
    $sw,
    "order-alert-v\d+(-\d+)?",
    "order-alert-v53-$stamp"
  )
  Set-Content -Path $swPath -Value $sw -Encoding UTF8
}

Write-Host ""
Write-Host "SUCCESS: v53 stable cloud and Telegram test installed." -ForegroundColor Green
Write-Host ""
Write-Host "Restart npm run agent after Commit/Push." -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter"
