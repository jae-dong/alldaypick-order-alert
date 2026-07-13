
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

if ($html -match 'V49_CLEAN_DASHBOARD') {
  Write-Host "v49 is already installed." -ForegroundColor Yellow
  Read-Host "Press Enter"
  exit 0
}

$style = @'
<style id="V49_CLEAN_DASHBOARD">
  #v49UpdateTime{
    font-size:12px;
    color:var(--muted);
    font-weight:700;
  }

  .metrics{
    grid-template-columns:repeat(4,minmax(0,1fr))!important;
    gap:8px!important;
  }

  .metric{
    min-height:110px!important;
    padding:14px!important;
    text-align:center;
  }

  .metric span{
    font-size:13px!important;
    font-weight:900!important;
  }

  .metric strong{
    display:block;
    margin-top:8px!important;
    font-size:30px!important;
    line-height:1.15;
  }

  .metric small{
    display:block!important;
    margin-top:6px!important;
    font-size:11px!important;
  }

  #v49ShopSection{
    margin-top:10px;
  }

  #v49ShopTable{
    width:100%;
    border-collapse:separate;
    border-spacing:0;
    min-width:760px;
  }

  #v49ShopTable th,
  #v49ShopTable td{
    padding:10px 8px;
    border-right:1px solid var(--line);
    border-bottom:1px solid var(--line);
    text-align:center;
    font-size:12px;
  }

  #v49ShopTable th{
    background:#fafafa;
    color:#374151;
    font-weight:900;
  }

  #v49ShopTable th:first-child,
  #v49ShopTable td:first-child{
    text-align:left;
    min-width:135px;
  }

  #v49ShopTable tbody tr{
    cursor:pointer;
    background:#fff;
  }

  #v49ShopTable tbody tr:hover{
    background:#f9fafb;
  }

  #v49ShopTable tbody tr.selected{
    background:#eef2ff;
  }

  .v49-market{
    display:flex;
    align-items:center;
    gap:8px;
    font-weight:900;
  }

  .v49-dot{
    width:9px;
    height:9px;
    border-radius:50%;
    background:#9ca3af;
    flex:none;
  }

  .v49-dot.connected{
    background:#10b981;
  }

  .v49-count{
    font-weight:900;
  }

  .v49-sales{
    color:#dc2626;
    font-weight:900;
  }

  .v49-new{color:#2563eb}
  .v49-wait{color:#d97706}
  .v49-claim{color:#dc2626}

  @media(max-width:800px){
    .metrics{
      grid-template-columns:repeat(2,minmax(0,1fr))!important;
    }

    .metric{
      min-height:94px!important;
    }

    .metric strong{
      font-size:26px!important;
    }

    #v49ShopSection .table-wrap{
      overflow-x:auto!important;
    }
  }
</style>
'@

$html = $html.Replace('</head>', $style + "`r`n</head>")

$script = @'
const V49_CLEAN_DASHBOARD=true;

function v49TodayOrders(){
  const today=todayKey();

  return orders.filter(order=>
    orderDay(order)===today
  );
}

function v49MonthOrders(){
  const now=new Date();
  const month=[
    now.getFullYear(),
    String(now.getMonth()+1).padStart(2,'0')
  ].join('-');

  return orders.filter(order=>
    String(orderDay(order)||'').slice(0,7)===month
  );
}

function v49SetMetric(id,label,value,note){
  const valueElement=document.getElementById(id);

  if(!valueElement) return;

  valueElement.textContent=value;

  const metric=valueElement.closest('.metric');
  const title=metric?.querySelector('span');

  if(title){
    title.textContent=label;
  }

  let noteElement=metric?.querySelector('.v49-note');

  if(metric&&!noteElement){
    noteElement=document.createElement('small');
    noteElement.className='v49-note';
    metric.appendChild(noteElement);
  }

  if(noteElement){
    noteElement.textContent=note;
  }
}

function v49RenderMetrics(){
  const today=v49TodayOrders();
  const monthly=v49MonthOrders();
  const monthLabel=`${new Date().getMonth()+1}월 1일부터 오늘까지`;

  v49SetMetric(
    'todayCount',
    '오늘 주문',
    today.length,
    '오늘 들어온 전체 주문'
  );

  v49SetMetric(
    'todaySales',
    '오늘 매출',
    fmt(
      today.reduce(
        (sum,order)=>sum+Number(order.amount||0),
        0
      )
    ),
    '오늘 주문금액 합계'
  );

  v49SetMetric(
    'unreadCount',
    '이번달 총주문',
    monthly.length,
    monthLabel
  );

  v49SetMetric(
    'allCount',
    '이번달 총매출',
    fmt(
      monthly.reduce(
        (sum,order)=>sum+Number(order.amount||0),
        0
      )
    ),
    monthLabel
  );
}

function v49ConnectionMap(){
  const result={};

  document
    .querySelectorAll('#integrationGrid .integration-card')
    .forEach(card=>{
      const name=card.querySelector('strong')?.textContent?.trim();

      if(!name) return;

      result[name]=Boolean(
        card.querySelector('.badge-connect.ready')
      );
    });

  return result;
}

function v49EnsureShopSection(){
  let section=document.getElementById('v49ShopSection');

  if(section) return section;

  section=document.createElement('section');
  section.id='v49ShopSection';
  section.className='card section';
  section.innerHTML=`
    <div class="section-head">
      <h2>쇼핑몰별 오늘 현황</h2>
      <span id="v49UpdateTime">업데이트 확인 중</span>
    </div>

    <div class="table-wrap">
      <table id="v49ShopTable">
        <thead>
          <tr>
            <th>판매처</th>
            <th>오늘 주문</th>
            <th>오늘 매출</th>
            <th>신규</th>
            <th>발송대기</th>
            <th>취소</th>
            <th>반품</th>
            <th>교환</th>
          </tr>
        </thead>
        <tbody id="v49ShopBody"></tbody>
      </table>
    </div>
  `;

  return section;
}

function v49RenderShopTable(){
  const section=v49EnsureShopSection();
  const tbody=section.querySelector('#v49ShopBody');

  if(!tbody) return;

  const markets=[
    '쿠팡',
    '스마트스토어',
    '11번가',
    'G마켓',
    '옥션',
    '롯데온'
  ];

  const today=todayKey();
  const connections=v49ConnectionMap();

  tbody.innerHTML=markets.map(market=>{
    const list=orders.filter(order=>
      order.market===market &&
      orderDay(order)===today
    );

    const count=key=>list.filter(order=>
      statusKey(order)===key
    ).length;

    const sales=list.reduce(
      (sum,order)=>sum+Number(order.amount||0),
      0
    );

    const selected=
      typeof activeMarket!=='undefined' &&
      activeMarket===market;

    return `
      <tr data-market="${market}" class="${selected?'selected':''}">
        <td>
          <span class="v49-market">
            <span class="v49-dot ${connections[market]?'connected':''}"></span>
            ${market}
          </span>
        </td>
        <td class="v49-count">${list.length}</td>
        <td class="v49-sales">${fmt(sales)}</td>
        <td class="v49-count v49-new">${count('new')}</td>
        <td class="v49-count v49-wait">${count('shipping_wait')}</td>
        <td class="v49-count v49-claim">${count('cancel')}</td>
        <td class="v49-count v49-claim">${count('return')}</td>
        <td class="v49-count v49-claim">${count('exchange')}</td>
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

  const update=document.getElementById('v49UpdateTime');

  if(update){
    update.textContent=
      `마지막 업데이트 ${new Date().toLocaleTimeString('ko-KR',{
        hour:'2-digit',
        minute:'2-digit'
      })}`;
  }
}

function v49Arrange(){
  const integration=document.getElementById('integrationSection');
  const metrics=document.querySelector('.metrics');
  const statusSection=document
    .getElementById('statusGrid')
    ?.closest('section');
  const shop=v49EnsureShopSection();

  if(!integration) return;

  if(metrics){
    integration.insertAdjacentElement('afterend',metrics);
  }

  if(metrics&&statusSection){
    metrics.insertAdjacentElement('afterend',statusSection);
  }

  if(statusSection){
    statusSection.insertAdjacentElement('afterend',shop);
  }

  document.querySelectorAll(
    '#v46ShopSection,.market-summary-top'
  ).forEach(section=>{
    if(section!==shop){
      section.style.display='none';
    }
  });
}

const v49OriginalRender=render;

render=function(){
  v49OriginalRender();
  v49RenderMetrics();
  v49Arrange();
  v49RenderShopTable();
};

setTimeout(()=>{
  v49RenderMetrics();
  v49Arrange();
  v49RenderShopTable();
},500);
'@

$html = $html.Replace('</script>', $script + "`r`n</script>")
$html = [regex]::Replace(
  $html,
  "order-alert-v\d+",
  "order-alert-v49"
)

Set-Content -Path $indexPath -Value $html -Encoding UTF8

if(Test-Path $swPath){
  $sw=Get-Content -Raw -Encoding UTF8 $swPath
  $sw=[regex]::Replace(
    $sw,
    "order-alert-v\d+",
    "order-alert-v49"
  )
  Set-Content -Path $swPath -Value $sw -Encoding UTF8
}

Write-Host ""
Write-Host "SUCCESS: v49 clean dashboard installed." -ForegroundColor Green
Write-Host ""
Write-Host "Next: Commit and Push with GitHub Desktop." -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter"
