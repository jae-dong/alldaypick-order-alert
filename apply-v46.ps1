
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

if ($html -match 'V46_COMPACT_DASHBOARD') {
  Write-Host "v46 is already installed." -ForegroundColor Yellow
  Read-Host "Press Enter"
  exit 0
}

$style = @'
<style id="V46_COMPACT_DASHBOARD">
  :root{
    --v46-ink:#111827;
    --v46-muted:#6b7280;
    --v46-line:#e5e7eb;
    --v46-bg:#f5f6f8;
    --v46-card:#ffffff;
    --v46-red:#dc2626;
    --v46-blue:#2563eb;
    --v46-orange:#d97706;
    --v46-green:#059669;
    --v46-purple:#7c3aed;
  }

  body{background:var(--v46-bg)!important}
  .app{width:min(1060px,100%)!important;padding:14px!important}

  .topbar{
    background:#fff;
    border:1px solid var(--v46-line);
    border-radius:16px;
    padding:16px;
    margin-bottom:10px;
    box-shadow:none!important;
  }

  .brand h1{font-size:24px!important}
  .brand p{display:none}
  #cloudStatus{margin-top:5px;font-weight:800}

  .actions .btn{
    border-radius:10px!important;
    box-shadow:none!important;
  }

  .card{
    border-radius:14px!important;
    box-shadow:none!important;
    border:1px solid var(--v46-line)!important;
  }

  .section{
    padding:15px!important;
    margin-top:10px!important;
  }

  .section-head{
    margin-bottom:10px!important;
  }

  .section-head h2{
    font-size:18px!important;
    letter-spacing:-.3px;
  }

  #integrationSection{
    order:1;
  }

  #integrationSection .section-head{
    align-items:flex-start;
  }

  .integration-grid{
    grid-template-columns:repeat(6,minmax(0,1fr))!important;
    gap:7px!important;
  }

  .integration-card{
    padding:10px!important;
    border-radius:10px!important;
    background:#fff!important;
    min-height:72px;
  }

  .integration-head{
    display:block!important;
  }

  .integration-head strong{
    display:block;
    font-size:13px;
    margin-bottom:7px;
    white-space:nowrap;
    overflow:hidden;
    text-overflow:ellipsis;
  }

  .badge-connect{
    display:inline-flex!important;
    font-size:10px!important;
    padding:4px 7px!important;
  }

  .integration-card small{
    display:none!important;
  }

  .metrics{
    grid-template-columns:repeat(4,minmax(0,1fr))!important;
    gap:8px!important;
    margin-top:10px!important;
  }

  .metric{
    min-height:115px;
    padding:15px!important;
    text-align:center;
  }

  .metric span{
    display:block;
    font-size:13px!important;
    font-weight:800;
    color:var(--v46-muted)!important;
  }

  .metric strong{
    font-size:32px!important;
    margin-top:10px!important;
    letter-spacing:-1px;
  }

  .metric small{
    display:none!important;
  }

  .metrics .metric:nth-child(1) strong{color:var(--v46-blue)}
  .metrics .metric:nth-child(2) strong{color:var(--v46-red)}
  .metrics .metric:nth-child(3) strong{color:var(--v46-red)}
  .metrics .metric:nth-child(4) strong{color:var(--v46-ink)}

  .status-grid{
    grid-template-columns:repeat(5,minmax(0,1fr))!important;
    gap:7px!important;
  }

  .status-card{
    padding:12px 6px!important;
    border-radius:10px!important;
    background:#fff!important;
  }

  .status-card span{
    font-size:12px!important;
    font-weight:800;
  }

  .status-card strong{
    font-size:26px!important;
    margin-top:6px!important;
  }

  .status-card.selected{
    background:var(--v46-ink)!important;
  }

  .tabs{
    position:static!important;
    background:transparent!important;
    padding:0!important;
    margin:10px 0 0!important;
    backdrop-filter:none!important;
  }

  .tab{
    border-radius:10px!important;
  }

  #v46ShopSection{
    margin-top:10px;
  }

  #v46ShopTable{
    width:100%;
    min-width:0!important;
    border-collapse:separate;
    border-spacing:0;
  }

  #v46ShopTable th,
  #v46ShopTable td{
    padding:10px 8px;
    font-size:12px;
    text-align:center;
    border-right:1px solid var(--v46-line);
    border-bottom:1px solid var(--v46-line);
  }

  #v46ShopTable th:first-child,
  #v46ShopTable td:first-child{
    text-align:left;
    font-weight:900;
    width:150px;
  }

  #v46ShopTable thead th{
    position:static!important;
    background:#fafafa;
    color:#374151;
  }

  #v46ShopTable tr{
    cursor:pointer;
  }

  #v46ShopTable tbody tr:hover{
    background:#f9fafb;
  }

  #v46ShopTable .shop-selected{
    background:#eef2ff;
  }

  .v46-market-name{
    display:flex;
    align-items:center;
    gap:8px;
  }

  .v46-market-dot{
    width:9px;
    height:9px;
    border-radius:50%;
    background:#9ca3af;
    flex:none;
  }

  .v46-market-dot.connected{
    background:#10b981;
  }

  .v46-zero{color:#9ca3af}
  .v46-count{font-weight:900}
  .v46-new{color:var(--v46-blue)}
  .v46-wait{color:var(--v46-orange)}
  .v46-cancel{color:var(--v46-red)}
  .v46-return{color:var(--v46-purple)}
  .v46-exchange{color:var(--v46-green)}

  .toolbar{
    grid-template-columns:1fr 150px 150px!important;
  }

  .table-wrap{
    border:1px solid var(--v46-line);
    border-radius:10px;
    overflow:auto!important;
  }

  #orderBody tr{
    background:#fff;
  }

  #orderBody tr:hover{
    background:#f9fafb;
  }

  .footer{
    padding:15px!important;
  }

  @media(max-width:800px){
    .app{padding:8px 8px 78px!important}

    .topbar{
      padding:13px!important;
    }

    .brand h1{
      font-size:21px!important;
    }

    .integration-grid{
      grid-template-columns:repeat(3,minmax(0,1fr))!important;
    }

    .integration-card{
      min-height:66px;
    }

    .metrics{
      grid-template-columns:repeat(2,minmax(0,1fr))!important;
    }

    .metric{
      min-height:96px;
      padding:13px 8px!important;
    }

    .metric strong{
      font-size:28px!important;
    }

    .status-grid{
      grid-template-columns:repeat(3,minmax(0,1fr))!important;
    }

    .status-card strong{
      font-size:23px!important;
    }

    #v46ShopSection .table-wrap{
      overflow-x:auto!important;
    }

    #v46ShopTable{
      display:table!important;
      min-width:650px!important;
    }

    #v46ShopTable thead{
      display:table-header-group!important;
    }

    #v46ShopTable tbody{
      display:table-row-group!important;
    }

    #v46ShopTable tr{
      display:table-row!important;
      padding:0!important;
      border:0!important;
      border-radius:0!important;
    }

    #v46ShopTable td,
    #v46ShopTable th{
      display:table-cell!important;
    }

    #v46ShopTable td::before{
      display:none!important;
    }

    .toolbar{
      grid-template-columns:1fr 1fr!important;
    }

    .toolbar input{
      grid-column:1/-1!important;
    }

    .actions{
      grid-template-columns:repeat(3,minmax(0,1fr))!important;
    }
  }
</style>
'@

$html = $html.Replace('</head>', $style + "`r`n</head>")

$script = @'
const V46_COMPACT_DASHBOARD=true;

function v46StatusCount(market,key){
  return orders.filter(order=>
    order.market===market &&
    statusKey(order)===key
  ).length;
}

function v46ConnectionMap(){
  const result={};

  document
    .querySelectorAll('#integrationGrid .integration-card')
    .forEach(card=>{
      const name=card.querySelector('strong')?.textContent?.trim();
      const connected=card.querySelector('.badge-connect.ready');

      if(name){
        result[name]=Boolean(connected);
      }
    });

  return result;
}

function ensureV46ShopSection(){
  let section=document.getElementById('v46ShopSection');

  if(section) return section;

  section=document.createElement('section');
  section.id='v46ShopSection';
  section.className='card section';
  section.innerHTML=`
    <div class="section-head">
      <h2>쇼핑몰별 주문 현황</h2>
      <span class="subtle">행을 누르면 해당 쇼핑몰만 표시</span>
    </div>
    <div class="table-wrap">
      <table id="v46ShopTable">
        <thead>
          <tr>
            <th>판매처</th>
            <th>신규</th>
            <th>발송대기</th>
            <th>취소</th>
            <th>반품</th>
            <th>교환</th>
            <th>전체</th>
          </tr>
        </thead>
        <tbody id="v46ShopBody"></tbody>
      </table>
    </div>
  `;

  const integration=document.getElementById('integrationSection');

  if(integration){
    integration.insertAdjacentElement('afterend',section);
  }else{
    document.querySelector('.app')?.prepend(section);
  }

  return section;
}

function renderV46ShopOverview(){
  ensureV46ShopSection();

  const markets=[
    '스마트스토어',
    '쿠팡',
    '11번가',
    'G마켓',
    '옥션',
    '롯데온'
  ];

  const connections=v46ConnectionMap();
  const tbody=document.getElementById('v46ShopBody');

  if(!tbody) return;

  tbody.innerHTML=markets.map(market=>{
    const counts={
      new:v46StatusCount(market,'new'),
      wait:v46StatusCount(market,'shipping_wait'),
      cancel:v46StatusCount(market,'cancel'),
      return:v46StatusCount(market,'return'),
      exchange:v46StatusCount(market,'exchange'),
      total:orders.filter(order=>order.market===market).length
    };

    const selected=
      typeof activeMarket!=='undefined' &&
      activeMarket===market;

    const cell=(value,cls)=>
      `<td class="${value?'v46-count '+cls:'v46-zero'}">${value}</td>`;

    return `
      <tr data-market="${market}" class="${selected?'shop-selected':''}">
        <td>
          <span class="v46-market-name">
            <span class="v46-market-dot ${connections[market]?'connected':''}"></span>
            ${market}
          </span>
        </td>
        ${cell(counts.new,'v46-new')}
        ${cell(counts.wait,'v46-wait')}
        ${cell(counts.cancel,'v46-cancel')}
        ${cell(counts.return,'v46-return')}
        ${cell(counts.exchange,'v46-exchange')}
        ${cell(counts.total,'')}
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('tr').forEach(row=>{
    row.onclick=()=>{
      if(typeof activeMarket==='undefined') return;

      activeMarket=
        activeMarket===row.dataset.market
          ? ''
          : row.dataset.market;

      if(typeof currentPage!=='undefined'){
        currentPage=1;
      }

      showOrdersTab();
      render();

      document
        .getElementById('ordersPanel')
        ?.scrollIntoView({
          behavior:'smooth',
          block:'start'
        });
    };
  });
}

function v46MoveSections(){
  const integration=document.getElementById('integrationSection');
  const metrics=document.querySelector('.metrics');
  const statusSection=document.getElementById('statusGrid')?.closest('section');
  const app=document.querySelector('.app');

  if(!app||!integration) return;

  const shop=ensureV46ShopSection();

  integration.insertAdjacentElement('afterend',shop);

  if(metrics){
    shop.insertAdjacentElement('afterend',metrics);
  }

  if(statusSection&&metrics){
    metrics.insertAdjacentElement('afterend',statusSection);
  }

  document.querySelectorAll('.market-grid').forEach(grid=>{
    const section=grid.closest('section');

    if(section&&section.id!=='v46ShopSection'){
      section.style.display='none';
    }
  });
}

const v46OriginalRender=render;

render=function(){
  v46OriginalRender();
  v46MoveSections();
  renderV46ShopOverview();
};

const v46Observer=new MutationObserver(()=>{
  renderV46ShopOverview();
});

const integrationGrid=document.getElementById('integrationGrid');

if(integrationGrid){
  v46Observer.observe(
    integrationGrid,
    {
      childList:true,
      subtree:true,
      attributes:true
    }
  );
}

setTimeout(()=>{
  v46MoveSections();
  renderV46ShopOverview();
},400);
'@

$html = $html.Replace('</script>', $script + "`r`n</script>")
$html = [regex]::Replace(
  $html,
  "order-alert-v\d+",
  "order-alert-v46"
)

Set-Content -Path $indexPath -Value $html -Encoding UTF8

if(Test-Path $swPath){
  $sw=Get-Content -Raw -Encoding UTF8 $swPath
  $sw=[regex]::Replace(
    $sw,
    "order-alert-v\d+",
    "order-alert-v46"
  )
  Set-Content -Path $swPath -Value $sw -Encoding UTF8
}

Write-Host ""
Write-Host "SUCCESS: v46 compact dashboard installed." -ForegroundColor Green
Write-Host ""
Write-Host "Next: Commit and Push with GitHub Desktop." -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter"
