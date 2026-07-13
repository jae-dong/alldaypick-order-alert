
$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexPath = Join-Path $project "index.html"
$backendPath = Join-Path $project "backend"
$patchBackend = Join-Path $project "v47-files\backend"
$swPath = Join-Path $project "sw.js"

if (!(Test-Path $indexPath)) {
  Write-Host "ERROR: index.html not found." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}

Copy-Item (Join-Path $patchBackend "local-agent.js") (Join-Path $backendPath "local-agent.js") -Force
Copy-Item (Join-Path $patchBackend "package.json") (Join-Path $backendPath "package.json") -Force
Copy-Item (Join-Path $patchBackend ".env.local.example") (Join-Path $backendPath ".env.local.example") -Force

$html = Get-Content -Raw -Encoding UTF8 $indexPath

if ($html -match 'V47_MONTHLY_DASHBOARD') {
  Write-Host "v47 is already installed." -ForegroundColor Yellow
  Read-Host "Press Enter"
  exit 0
}

$style = @'
<style id="V47_MONTHLY_DASHBOARD">
  .v47-period-note{
    display:block;
    margin-top:4px;
    color:var(--muted);
    font-size:11px;
    font-weight:700;
  }

  #v46ShopSection .section-head .subtle::after{
    content:" · 오늘 기준";
  }
</style>
'@

$html = $html.Replace('</head>', $style + "`r`n</head>")

$script = @'
const V47_MONTHLY_DASHBOARD=true;

function v47MonthKey(){
  const now=new Date();
  return [
    now.getFullYear(),
    String(now.getMonth()+1).padStart(2,'0')
  ].join('-');
}

function v47MonthOrders(){
  const month=v47MonthKey();

  return orders.filter(order=>
    String(orderDay(order)||'').slice(0,7)===month
  );
}

function v47SetMetric(id,label,value,note){
  const element=document.getElementById(id);

  if(!element) return;

  element.textContent=value;

  const metric=element.closest('.metric');
  const title=metric?.querySelector('span');

  if(title){
    title.textContent=label;
  }

  let noteElement=metric?.querySelector('.v47-period-note');

  if(metric&&!noteElement){
    noteElement=document.createElement('small');
    noteElement.className='v47-period-note';
    metric.appendChild(noteElement);
  }

  if(noteElement){
    noteElement.textContent=note;
  }
}

function v47RenderMonthlyMetrics(){
  const monthly=v47MonthOrders();
  const monthLabel=`${new Date().getMonth()+1}월 1일부터 오늘까지`;

  v47SetMetric(
    'unreadCount',
    '이번달 총주문',
    monthly.length,
    `${monthLabel} 누적`
  );

  v47SetMetric(
    'allCount',
    '이번달 총매출',
    fmt(
      monthly.reduce(
        (sum,order)=>sum+Number(order.amount||0),
        0
      )
    ),
    `${monthLabel} 누적`
  );
}

function v47TodayMarketCount(market,key){
  const today=todayKey();

  return orders.filter(order=>
    order.market===market &&
    orderDay(order)===today &&
    statusKey(order)===key
  ).length;
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
  const today=todayKey();

  if(!tbody) return;

  tbody.innerHTML=markets.map(market=>{
    const counts={
      new:v47TodayMarketCount(market,'new'),
      wait:v47TodayMarketCount(market,'shipping_wait'),
      cancel:v47TodayMarketCount(market,'cancel'),
      return:v47TodayMarketCount(market,'return'),
      exchange:v47TodayMarketCount(market,'exchange'),
      total:orders.filter(order=>
        order.market===market &&
        orderDay(order)===today
      ).length
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

function v47ArrangeSections(){
  const integration=document.getElementById('integrationSection');
  const metrics=document.querySelector('.metrics');
  const statusSection=document
    .getElementById('statusGrid')
    ?.closest('section');
  const shop=ensureV46ShopSection();

  if(!integration||!shop) return;

  integration.insertAdjacentElement('afterend',metrics||shop);

  if(metrics){
    metrics.insertAdjacentElement(
      'afterend',
      statusSection||shop
    );
  }

  if(statusSection){
    statusSection.insertAdjacentElement('afterend',shop);
  }
}

const v47PreviousRender=render;

render=function(){
  v47PreviousRender();
  v47RenderMonthlyMetrics();
  v47ArrangeSections();
  renderV46ShopOverview();
};

setTimeout(()=>{
  v47RenderMonthlyMetrics();
  v47ArrangeSections();
  renderV46ShopOverview();
},500);
'@

$html = $html.Replace('</script>', $script + "`r`n</script>")
$html = [regex]::Replace($html,"order-alert-v\d+","order-alert-v47")

Set-Content -Path $indexPath -Value $html -Encoding UTF8

if(Test-Path $swPath){
  $sw=Get-Content -Raw -Encoding UTF8 $swPath
  $sw=[regex]::Replace($sw,"order-alert-v\d+","order-alert-v47")
  Set-Content -Path $swPath -Value $sw -Encoding UTF8
}

Write-Host ""
Write-Host "SUCCESS: v47 monthly dashboard and reliable alerts installed." -ForegroundColor Green
Write-Host ""
Write-Host "Next: Commit/Push and restart npm run agent." -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter"
