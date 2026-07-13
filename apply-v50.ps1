
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

if ($html -match 'V50_FORCE_DASHBOARD') {
  Write-Host "v50 is already installed." -ForegroundColor Yellow
  Read-Host "Press Enter"
  exit 0
}

$style = @'
<style id="V50_FORCE_DASHBOARD">
body{background:#f5f6f8!important}
.app{width:min(1080px,100%)!important;padding:10px!important}
.card,.section,.topbar{box-shadow:none!important;border:1px solid #e5e7eb!important;border-radius:14px!important}
#v50Dashboard{display:grid;gap:10px;margin-top:10px}
#v50Metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.v50-metric,#v50Alerts,#v50Shops{background:#fff;border:1px solid #e5e7eb;border-radius:14px}
.v50-metric{padding:16px 12px;text-align:center}
.v50-metric-label{font-size:13px;font-weight:900;color:#6b7280}
.v50-metric-value{margin-top:7px;font-size:30px;line-height:1.15;font-weight:1000;letter-spacing:-1px;color:#111827}
.v50-metric-note{margin-top:5px;font-size:11px;color:#9ca3af;font-weight:700}
#v50Alerts,#v50Shops{padding:14px}
.v50-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px}
.v50-head h2{margin:0;font-size:18px}
.v50-update{font-size:11px;color:#6b7280;font-weight:700}
.v50-alert-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:7px}
.v50-alert{border:1px solid #e5e7eb;border-radius:10px;padding:11px 6px;text-align:center;cursor:pointer;background:#fff}
.v50-alert span{display:block;font-size:12px;color:#6b7280;font-weight:900}
.v50-alert strong{display:block;margin-top:5px;font-size:24px;color:#111827}
.v50-alert.active{background:#111827}
.v50-alert.active span,.v50-alert.active strong{color:#fff}
.v50-table-wrap{overflow-x:auto;border:1px solid #e5e7eb;border-radius:10px}
#v50ShopTable{width:100%;min-width:760px;border-collapse:collapse}
#v50ShopTable th,#v50ShopTable td{padding:10px 8px;border-bottom:1px solid #e5e7eb;border-right:1px solid #e5e7eb;text-align:center;font-size:12px}
#v50ShopTable th{background:#fafafa;color:#374151;font-weight:900}
#v50ShopTable th:first-child,#v50ShopTable td:first-child{text-align:left;min-width:135px}
#v50ShopTable tbody tr{cursor:pointer}
#v50ShopTable tbody tr:hover{background:#f9fafb}
#v50ShopTable tbody tr.selected{background:#eef2ff}
.v50-market{display:flex;align-items:center;gap:8px;font-weight:900}
.v50-dot{width:9px;height:9px;border-radius:50%;background:#9ca3af}
.v50-dot.connected{background:#10b981}
.v50-sales{color:#dc2626;font-weight:900}
.v50-new{color:#2563eb;font-weight:900}
.v50-wait{color:#d97706;font-weight:900}
.v50-claim{color:#dc2626;font-weight:900}
@media(max-width:800px){
  #v50Metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
  .v50-alert-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
  .v50-metric{padding:13px 8px}
  .v50-metric-value{font-size:26px}
}
</style>
'@

$html = $html.Replace('</head>', $style + "`r`n</head>")

$script = @'
const V50_FORCE_DASHBOARD=true;

function v50Orders(){
  try{
    return Array.isArray(orders)?orders:[];
  }catch{
    return [];
  }
}

function v50TodayKey(){
  const now=new Date();
  return [
    now.getFullYear(),
    String(now.getMonth()+1).padStart(2,'0'),
    String(now.getDate()).padStart(2,'0')
  ].join('-');
}

function v50DateKey(order){
  try{
    if(typeof orderDay==='function') return orderDay(order);
  }catch{}

  const raw=order?.datetime||order?.createdAt||order?.orderDate||'';
  const date=new Date(raw);
  if(Number.isNaN(date.getTime())) return '';

  return [
    date.getFullYear(),
    String(date.getMonth()+1).padStart(2,'0'),
    String(date.getDate()).padStart(2,'0')
  ].join('-');
}

function v50Status(order){
  try{
    if(typeof statusKey==='function') return statusKey(order);
  }catch{}
  return order?.status||'';
}

function v50Money(value){
  try{
    if(typeof fmt==='function') return fmt(value);
  }catch{}
  return `${Number(value||0).toLocaleString('ko-KR')}원`;
}

function v50ConnectionMap(){
  const result={};
  document.querySelectorAll('#integrationGrid .integration-card').forEach(card=>{
    const name=card.querySelector('strong')?.textContent?.trim();
    if(name) result[name]=Boolean(card.querySelector('.badge-connect.ready'));
  });
  return result;
}

function v50Ensure(){
  let root=document.getElementById('v50Dashboard');
  if(root) return root;

  root=document.createElement('section');
  root.id='v50Dashboard';
  root.innerHTML=`
    <div id="v50Metrics"></div>
    <div id="v50Alerts">
      <div class="v50-head"><h2>처리 알림</h2><span class="v50-update">오늘 기준</span></div>
      <div class="v50-alert-grid" id="v50AlertGrid"></div>
    </div>
    <div id="v50Shops">
      <div class="v50-head"><h2>쇼핑몰별 오늘 현황</h2><span class="v50-update" id="v50UpdateTime">업데이트 확인 중</span></div>
      <div class="v50-table-wrap">
        <table id="v50ShopTable">
          <thead>
            <tr>
              <th>판매처</th><th>오늘 주문</th><th>오늘 매출</th><th>신규</th><th>발송대기</th><th>취소</th><th>반품</th><th>교환</th>
            </tr>
          </thead>
          <tbody id="v50ShopBody"></tbody>
        </table>
      </div>
    </div>
  `;

  const integration=document.getElementById('integrationSection');
  const app=document.querySelector('.app')||document.body;
  if(integration) integration.insertAdjacentElement('afterend',root);
  else app.prepend(root);

  return root;
}

function v50Metric(label,value,note){
  return `<div class="v50-metric">
    <div class="v50-metric-label">${label}</div>
    <div class="v50-metric-value">${value}</div>
    <div class="v50-metric-note">${note}</div>
  </div>`;
}

function v50Render(){
  v50Ensure();

  const all=v50Orders();
  const todayKey=v50TodayKey();
  const today=all.filter(order=>v50DateKey(order)===todayKey);
  const now=new Date();
  const month=[now.getFullYear(),String(now.getMonth()+1).padStart(2,'0')].join('-');
  const monthly=all.filter(order=>v50DateKey(order).slice(0,7)===month);
  const monthLabel=`${now.getMonth()+1}월 1일부터 오늘까지`;

  document.getElementById('v50Metrics').innerHTML=[
    v50Metric('오늘 주문',today.length,'오늘 들어온 전체 주문'),
    v50Metric('오늘 매출',v50Money(today.reduce((s,o)=>s+Number(o.amount||0),0)),'오늘 주문금액 합계'),
    v50Metric('이번달 총주문',monthly.length,monthLabel),
    v50Metric('이번달 총매출',v50Money(monthly.reduce((s,o)=>s+Number(o.amount||0),0)),monthLabel)
  ].join('');

  const alertDefs=[
    ['new','신규주문'],
    ['shipping_wait','발송대기'],
    ['delivering','배송중'],
    ['cancel','취소'],
    ['return','반품'],
    ['exchange','교환']
  ];

  const alertGrid=document.getElementById('v50AlertGrid');
  alertGrid.innerHTML=alertDefs.map(([key,label])=>{
    const count=today.filter(order=>v50Status(order)===key).length;
    const active=typeof activeStatus!=='undefined'&&activeStatus===key;
    return `<button type="button" class="v50-alert ${active?'active':''}" data-status="${key}">
      <span>${label}</span><strong>${count}</strong>
    </button>`;
  }).join('');

  alertGrid.querySelectorAll('button').forEach(button=>{
    button.onclick=()=>{
      if(typeof activeStatus==='undefined') return;
      activeStatus=activeStatus===button.dataset.status?'':button.dataset.status;
      if(typeof currentPage!=='undefined') currentPage=1;
      if(typeof showOrdersTab==='function') showOrdersTab();
      if(typeof render==='function') render();
    };
  });

  const connections=v50ConnectionMap();
  const markets=['쿠팡','스마트스토어','11번가','G마켓','옥션','롯데온'];
  const tbody=document.getElementById('v50ShopBody');

  tbody.innerHTML=markets.map(market=>{
    const list=today.filter(order=>order.market===market);
    const count=key=>list.filter(order=>v50Status(order)===key).length;
    const sales=list.reduce((s,o)=>s+Number(o.amount||0),0);
    const selected=typeof activeMarket!=='undefined'&&activeMarket===market;

    return `<tr data-market="${market}" class="${selected?'selected':''}">
      <td><span class="v50-market"><span class="v50-dot ${connections[market]?'connected':''}"></span>${market}</span></td>
      <td><strong>${list.length}</strong></td>
      <td class="v50-sales">${v50Money(sales)}</td>
      <td class="v50-new">${count('new')}</td>
      <td class="v50-wait">${count('shipping_wait')}</td>
      <td class="v50-claim">${count('cancel')}</td>
      <td class="v50-claim">${count('return')}</td>
      <td class="v50-claim">${count('exchange')}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('tr').forEach(row=>{
    row.onclick=()=>{
      if(typeof activeMarket==='undefined') return;
      activeMarket=activeMarket===row.dataset.market?'':row.dataset.market;
      if(typeof currentPage!=='undefined') currentPage=1;
      if(typeof showOrdersTab==='function') showOrdersTab();
      if(typeof render==='function') render();
      document.getElementById('ordersPanel')?.scrollIntoView({behavior:'smooth',block:'start'});
    };
  });

  document.getElementById('v50UpdateTime').textContent=
    `마지막 업데이트 ${new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})}`;

  document.querySelectorAll('.metrics,#v46ShopSection,#v49ShopSection,.market-summary-top').forEach(el=>{
    if(!el.closest('#v50Dashboard')) el.style.display='none';
  });

  const oldStatus=document.getElementById('statusGrid')?.closest('section');
  if(oldStatus&&!oldStatus.closest('#v50Dashboard')) oldStatus.style.display='none';
}

const oldRender=typeof render==='function'?render:null;
if(oldRender){
  render=function(){
    oldRender();
    setTimeout(v50Render,0);
  };
}

setTimeout(v50Render,300);
setTimeout(v50Render,1200);
'@

$html = $html.Replace('</script>', $script + "`r`n</script>")

$stamp=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$html=[regex]::Replace($html,"order-alert-v\d+(-\d+)?","order-alert-v50-$stamp")

Set-Content -Path $indexPath -Value $html -Encoding UTF8

if(Test-Path $swPath){
  $sw=Get-Content -Raw -Encoding UTF8 $swPath
  $sw=[regex]::Replace($sw,"order-alert-v\d+(-\d+)?","order-alert-v50-$stamp")
  Set-Content -Path $swPath -Value $sw -Encoding UTF8
}

Write-Host ""
Write-Host "SUCCESS: v50 force dashboard installed." -ForegroundColor Green
Write-Host ""
Read-Host "Press Enter"
