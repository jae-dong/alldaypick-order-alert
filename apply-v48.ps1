
$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexPath = Join-Path $project "index.html"
$backendPath = Join-Path $project "backend"
$patchBackend = Join-Path $project "v48-files\backend"
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

if ($html -notmatch 'V48_TELEGRAM_ONLY') {
$style = @'
<style id="V48_TELEGRAM_ONLY">
  .v48-month-note{
    display:block;
    margin-top:5px;
    color:var(--muted);
    font-size:11px;
    font-weight:700;
  }

  .v48-telegram-badge{
    display:inline-flex;
    align-items:center;
    gap:6px;
    padding:6px 10px;
    border-radius:999px;
    background:#e8f7ff;
    color:#087ea4;
    font-size:12px;
    font-weight:900;
  }
</style>
'@

$html = $html.Replace('</head>', $style + "`r`n</head>")

$script = @'
const V48_TELEGRAM_ONLY=true;

function v48MonthOrders(){
  const now=new Date();
  const month=[
    now.getFullYear(),
    String(now.getMonth()+1).padStart(2,'0')
  ].join('-');

  return orders.filter(order=>
    String(orderDay(order)||'').slice(0,7)===month
  );
}

function v48TodayOrdersByMarket(market){
  const today=todayKey();

  return orders.filter(order=>
    order.market===market &&
    orderDay(order)===today
  );
}

function v48SetMetric(id,label,value,note){
  const valueElement=document.getElementById(id);

  if(!valueElement) return;

  valueElement.textContent=value;

  const metric=valueElement.closest('.metric');
  const labelElement=metric?.querySelector('span');

  if(labelElement){
    labelElement.textContent=label;
  }

  let noteElement=metric?.querySelector('.v48-month-note');

  if(metric&&!noteElement){
    noteElement=document.createElement('small');
    noteElement.className='v48-month-note';
    metric.appendChild(noteElement);
  }

  if(noteElement){
    noteElement.textContent=note;
  }
}

function v48RenderMonthMetrics(){
  const monthly=v48MonthOrders();
  const note=`${new Date().getMonth()+1}월 1일부터 오늘까지`;

  v48SetMetric(
    'unreadCount',
    '이번달 총주문',
    monthly.length,
    note
  );

  v48SetMetric(
    'allCount',
    '이번달 총매출',
    fmt(
      monthly.reduce(
        (sum,order)=>sum+Number(order.amount||0),
        0
      )
    ),
    note
  );
}

function v48Arrange(){
  const integration=document.getElementById('integrationSection');
  const metrics=document.querySelector('.metrics');
  const status=document
    .getElementById('statusGrid')
    ?.closest('section');

  const shop=
    document.getElementById('v46ShopSection') ||
    document.querySelector('.market-summary-top');

  if(integration&&metrics){
    integration.insertAdjacentElement('afterend',metrics);
  }

  if(metrics&&status){
    metrics.insertAdjacentElement('afterend',status);
  }

  if(status&&shop){
    status.insertAdjacentElement('afterend',shop);
  }
}

function v48RemoveWebPushUI(){
  document.querySelectorAll('button').forEach(button=>{
    const text=button.textContent.trim();

    if(
      text.includes('알림 권한') ||
      text.includes('알림 테스트') ||
      text.includes('푸시 등록') ||
      text.includes('휴대폰 등록')
    ){
      button.remove();
    }
  });

  document.querySelectorAll('section,.card').forEach(section=>{
    const heading=section.querySelector('h2,h3,strong');
    const text=heading?.textContent?.trim()||'';

    if(
      text.includes('백그라운드 푸시') ||
      text.includes('휴대폰 푸시 등록')
    ){
      section.remove();
    }
  });

  const topbar=document.querySelector('.topbar');

  if(topbar&&!document.getElementById('v48TelegramBadge')){
    const badge=document.createElement('span');
    badge.id='v48TelegramBadge';
    badge.className='v48-telegram-badge';
    badge.textContent='✈ 텔레그램 알림 사용 중';

    const actions=topbar.querySelector('.actions');
    actions?.prepend(badge);
  }
}

function v48FixShopTodayCounts(){
  const body=document.getElementById('v46ShopBody');

  if(!body) return;

  body.querySelectorAll('tr[data-market]').forEach(row=>{
    const market=row.dataset.market;
    const todayOrders=v48TodayOrdersByMarket(market);
    const cells=row.querySelectorAll('td');

    if(cells.length<7) return;

    const count=key=>todayOrders.filter(order=>
      statusKey(order)===key
    ).length;

    cells[1].textContent=count('new');
    cells[2].textContent=count('shipping_wait');
    cells[3].textContent=count('cancel');
    cells[4].textContent=count('return');
    cells[5].textContent=count('exchange');
    cells[6].textContent=todayOrders.length;
  });
}

const v48OldRender=render;

render=function(){
  v48OldRender();
  v48RenderMonthMetrics();
  v48Arrange();
  v48RemoveWebPushUI();
  setTimeout(v48FixShopTodayCounts,0);
};

setTimeout(()=>{
  v48RenderMonthMetrics();
  v48Arrange();
  v48RemoveWebPushUI();
  v48FixShopTodayCounts();
},500);
'@

$html = $html.Replace('</script>', $script + "`r`n</script>")
$html = [regex]::Replace($html,"order-alert-v\d+","order-alert-v48")

Set-Content -Path $indexPath -Value $html -Encoding UTF8

if(Test-Path $swPath){
  $sw=Get-Content -Raw -Encoding UTF8 $swPath
  $sw=[regex]::Replace($sw,"order-alert-v\d+","order-alert-v48")
  Set-Content -Path $swPath -Value $sw -Encoding UTF8
}
}

Write-Host ""
Write-Host "SUCCESS: v48 Telegram-only dashboard installed." -ForegroundColor Green
Write-Host ""
Write-Host "Next: Commit/Push and restart npm run agent." -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter"
