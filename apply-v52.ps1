
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

if ($html -match 'V52_MOBILE_CLOUD_FIX') {
  Write-Host "v52 is already installed." -ForegroundColor Yellow
  Read-Host "Press Enter"
  exit 0
}

$head = @'
<script id="V52_MOBILE_CLOUD_FIX">
(function(){
  const nativeGet=document.getElementById.bind(document);
  const ids=new Set([
    'cloudStatus','pushStatus','pushRegisterStatus','deviceStatus',
    'backgroundPushStatus','permissionStatus','notificationStatus',
    'phonePushStatus','vapidStatus','pushMessage','registrationMessage'
  ]);
  document.getElementById=function(id){
    const found=nativeGet(id);
    if(found) return found;
    if(!ids.has(String(id))) return null;
    const ghost=document.createElement('span');
    ghost.id=String(id);
    ghost.hidden=true;
    (document.body||document.documentElement).appendChild(ghost);
    return ghost;
  };
})();
</script>
<style>
#v52CloudState{display:inline-flex;align-items:center;gap:6px;margin-top:5px;font-size:12px;font-weight:900;color:#059669}
#v52CloudState:before{content:"";width:8px;height:8px;border-radius:50%;background:#10b981}
#v52MobileShops{display:none}
.v52-shop-card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:10px}
.v52-shop-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.v52-shop-name{display:flex;align-items:center;gap:6px;font-weight:900;font-size:13px}
.v52-dot{width:8px;height:8px;border-radius:50%;background:#9ca3af}
.v52-dot.connected{background:#10b981}
.v52-shop-sales{color:#dc2626;font-size:12px;font-weight:900}
.v52-shop-main{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:7px}
.v52-main-item{background:#f8fafc;border-radius:8px;padding:6px;text-align:center}
.v52-main-item span{display:block;color:#6b7280;font-size:10px;font-weight:800}
.v52-main-item strong{display:block;margin-top:2px;font-size:17px}
.v52-status-row{display:grid;grid-template-columns:repeat(5,1fr);gap:3px;font-size:9px;text-align:center}
.v52-status-row div{padding:4px 1px;border-radius:6px;background:#f3f4f6}
.v52-status-row b{display:block;margin-top:1px;font-size:11px}
#v52AnalysisToggle{display:none;width:100%;border:1px solid #e5e7eb;border-radius:10px;padding:10px;background:#fff;font-weight:900;text-align:left}
@media(max-width:800px){
  .app{padding:7px 7px 70px!important}
  .topbar{padding:10px!important}
  .brand h1{font-size:18px!important}
  .integration-grid{grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:5px!important}
  .integration-card{min-height:56px!important;padding:7px!important}
  #v50Metrics,.metrics{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:6px!important}
  .v50-metric,.metric{min-height:84px!important;padding:10px 5px!important}
  .v50-metric-value,.metric strong{font-size:23px!important}
  .v50-alert-grid,.status-grid{grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:5px!important}
  #v50Shops .v50-table-wrap,#v49ShopSection,#v46ShopSection{display:none!important}
  #v52MobileShops{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
  #v50Shops{padding:10px!important}
  #v52AnalysisToggle{display:block;margin-top:8px}
  #v52AnalysisToggle + .v52-analysis-target{display:none!important}
  #v52AnalysisToggle.open + .v52-analysis-target{display:block!important}
  .toolbar{grid-template-columns:1fr 1fr!important;gap:6px!important}
  .toolbar input{grid-column:1/-1!important}
}
</style>
'@

$html = $html.Replace('</head>', $head + "`r`n</head>")

$script = @'
(function(){
  const all=()=>{try{return Array.isArray(orders)?orders:[]}catch{return[]}};
  const today=()=>{try{return todayKey()}catch{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}};
  const day=o=>{try{return orderDay(o)}catch{return''}};
  const stat=o=>{try{return statusKey(o)}catch{return o?.status||''}};
  const money=v=>{try{return fmt(v)}catch{return `${Number(v||0).toLocaleString('ko-KR')}원`}};

  function connected(){
    const r={};
    document.querySelectorAll('#integrationGrid .integration-card').forEach(card=>{
      const n=card.querySelector('strong')?.textContent?.trim();
      if(n) r[n]=Boolean(card.querySelector('.badge-connect.ready'));
    });
    return r;
  }

  function cloud(){
    const brand=document.querySelector('.brand');
    if(!brand) return;
    let el=document.getElementById('v52CloudState');
    if(!el){el=document.createElement('div');el.id='v52CloudState';brand.appendChild(el)}
    const map=connected(), ok=Object.values(map).filter(Boolean).length, total=Object.keys(map).length;
    el.textContent=total?`클라우드 정상 · ${ok}/${total}개 쇼핑몰 연결`:'클라우드 연결 중';
    document.querySelectorAll('.brand p').forEach(p=>{
      if(p.textContent.includes('클라우드 초기화 오류')) p.style.display='none';
    });
  }

  function shops(){
    const host=document.getElementById('v50Shops');
    if(!host) return;
    let grid=document.getElementById('v52MobileShops');
    if(!grid){grid=document.createElement('div');grid.id='v52MobileShops';host.appendChild(grid)}
    const list=all().filter(o=>day(o)===today());
    const map=connected();
    const markets=['쿠팡','스마트스토어','11번가','G마켓','옥션','롯데온'];
    grid.innerHTML=markets.map(m=>{
      const rows=list.filter(o=>o.market===m);
      const c=k=>rows.filter(o=>stat(o)===k).length;
      const sales=rows.reduce((s,o)=>s+Number(o.amount||0),0);
      return `<article class="v52-shop-card" data-market="${m}">
        <div class="v52-shop-head"><span class="v52-shop-name"><span class="v52-dot ${map[m]?'connected':''}"></span>${m}</span><span class="v52-shop-sales">${money(sales)}</span></div>
        <div class="v52-shop-main"><div class="v52-main-item"><span>오늘 주문</span><strong>${rows.length}</strong></div><div class="v52-main-item"><span>발송대기</span><strong>${c('shipping_wait')}</strong></div></div>
        <div class="v52-status-row"><div>신규<b>${c('new')}</b></div><div>취소<b>${c('cancel')}</b></div><div>반품<b>${c('return')}</b></div><div>교환<b>${c('exchange')}</b></div><div>배송중<b>${c('delivering')}</b></div></div>
      </article>`;
    }).join('');

    grid.querySelectorAll('.v52-shop-card').forEach(card=>{
      card.onclick=()=>{try{
        activeMarket=activeMarket===card.dataset.market?'':card.dataset.market;
        currentPage=1;showOrdersTab();render();
        document.getElementById('ordersPanel')?.scrollIntoView({behavior:'smooth',block:'start'});
      }catch{}};
    });
  }

  function analysis(){
    const target=[...document.querySelectorAll('section,.card')].find(x=>x.querySelector('h2')?.textContent?.includes('오늘 분석'));
    if(!target||target.classList.contains('v52-analysis-target')) return;
    target.classList.add('v52-analysis-target');
    const b=document.createElement('button');
    b.id='v52AnalysisToggle';b.type='button';b.textContent='오늘 분석 펼쳐보기';
    b.onclick=()=>{b.classList.toggle('open');b.textContent=b.classList.contains('open')?'오늘 분석 접기':'오늘 분석 펼쳐보기'};
    target.insertAdjacentElement('beforebegin',b);
  }

  function refresh(){cloud();shops();analysis()}
  const old=typeof render==='function'?render:null;
  if(old){render=function(){old();setTimeout(refresh,0)}}
  setTimeout(refresh,300);setTimeout(refresh,1200);
})();
'@

$html = $html.Replace('</script>', $script + "`r`n</script>")

$stamp=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$html=[regex]::Replace($html,"order-alert-v\d+(-\d+)?","order-alert-v52-$stamp")
Set-Content -Path $indexPath -Value $html -Encoding UTF8

if(Test-Path $swPath){
  $sw=Get-Content -Raw -Encoding UTF8 $swPath
  $sw=[regex]::Replace($sw,"order-alert-v\d+(-\d+)?","order-alert-v52-$stamp")
  Set-Content -Path $swPath -Value $sw -Encoding UTF8
}

Write-Host ""
Write-Host "SUCCESS: v52 mobile cloud fix installed." -ForegroundColor Green
Write-Host ""
Read-Host "Press Enter"
