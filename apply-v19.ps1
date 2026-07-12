
$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexPath = Join-Path $project "index.html"
$backendPath = Join-Path $project "backend"
$patchBackend = Join-Path $project "v19-files\backend"

if (!(Test-Path $indexPath)) {
  Write-Host "ERROR: index.html not found." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}

if (!(Test-Path $backendPath)) {
  Write-Host "ERROR: backend folder not found." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}

if (!(Test-Path $patchBackend)) {
  Write-Host "ERROR: v19-files folder not found." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}

Copy-Item (Join-Path $patchBackend "coupang.js") (Join-Path $backendPath "coupang.js") -Force
Copy-Item (Join-Path $patchBackend "local-agent.js") (Join-Path $backendPath "local-agent.js") -Force

$html = Get-Content -Raw -Encoding UTF8 $indexPath

if ($html -notmatch 'V19_STATUS_SYNC') {
  # Hide the duplicate legacy background-push section when present.
  $legacyPattern = '(<section\b[^>]*)(>\s*<div class="section-head"><h2>백그라운드 푸시</h2>)'
  $legacyRegex = New-Object System.Text.RegularExpressions.Regex(
    $legacyPattern,
    [System.Text.RegularExpressions.RegexOptions]::Singleline
  )

  if ($legacyRegex.IsMatch($html) -and $html -notmatch 'id="legacyBackgroundPush"') {
    $html = $legacyRegex.Replace($html, '$1 id="legacyBackgroundPush"$2', 1)
  }

  $style = @'
  <style id="V19_STATUS_SYNC">
    #legacyBackgroundPush{
      display:none !important;
    }

    html,
    body{
      width:100% !important;
      max-width:100% !important;
      min-width:0 !important;
      overflow-x:hidden !important;
    }

    body,
    .app{
      min-width:0 !important;
      max-width:100% !important;
      overflow-x:hidden !important;
    }

    .app > *,
    .card,
    .section,
    .section-head,
    .grid,
    .market-list,
    .home-two,
    .event-grid,
    .integration-grid,
    .form,
    .form label{
      min-width:0 !important;
      max-width:100% !important;
    }

    img,
    svg,
    video,
    canvas,
    iframe,
    input,
    select,
    textarea,
    button{
      max-width:100% !important;
    }

    .event-grid{
      grid-template-columns:repeat(6,minmax(0,1fr)) !important;
    }

    @media(max-width:800px){
      .app{
        width:100% !important;
        max-width:100% !important;
        padding-left:10px !important;
        padding-right:10px !important;
        margin:0 !important;
      }

      .event-grid{
        grid-template-columns:repeat(2,minmax(0,1fr)) !important;
      }

      .grid,
      .market-list,
      .home-two,
      .integration-grid{
        width:100% !important;
        min-width:0 !important;
        max-width:100% !important;
      }

      td,
      th,
      .compact-item strong,
      .rank-item b{
        overflow-wrap:anywhere;
        word-break:break-word;
      }
    }
  </style>
'@

  $html = $html.Replace('</head>', $style + "`r`n</head>")

  $script = @'
const V19_STATUS_SYNC=true;

function findProcessCardByLabel(label){
  const candidates=[
    ...document.querySelectorAll('.event-card,.metric,.mini-card,.alert-row')
  ];

  return candidates.find(card=>{
    const text=(card.textContent||'').replace(/\s+/g,' ').trim();
    return text.startsWith(label+' ')||text===label||text.includes(label);
  })||null;
}

function ensureShippingWaitCard(){
  if(document.getElementById('shippingWaitCount')) return;

  const newCard=findProcessCardByLabel('신규주문');
  if(!newCard||!newCard.parentElement) return;

  const card=document.createElement(newCard.tagName.toLowerCase());
  card.className=newCard.className;
  card.innerHTML='<span>발송대기</span><strong id="shippingWaitCount">0</strong>';
  newCard.insertAdjacentElement('afterend',card);
}

function updateStatusCards(orders){
  const newCount=orders.filter(order=>
    order.market==='쿠팡'&&
    (order.sourceStatus==='ACCEPT'||order.status==='new')
  ).length;

  const shippingWaitCount=orders.filter(order=>
    order.market==='쿠팡'&&
    (order.sourceStatus==='INSTRUCT'||order.status==='shipping_wait')
  ).length;

  ensureShippingWaitCard();

  const newCard=findProcessCardByLabel('신규주문');
  if(newCard){
    const number=newCard.querySelector('strong');
    if(number) number.textContent=String(newCount);
  }

  const wait=document.getElementById('shippingWaitCount');
  if(wait) wait.textContent=String(shippingWaitCount);
}

function startV19StatusCounter(){
  ensureShippingWaitCard();

  const started=Date.now();
  const timer=setInterval(()=>{
    ensureShippingWaitCard();

    if(typeof db!=='undefined'&&db&&typeof currentUser!=='undefined'&&currentUser){
      clearInterval(timer);

      db.collection('orders').onSnapshot(snapshot=>{
        updateStatusCards(snapshot.docs.map(doc=>({id:doc.id,...doc.data()})));
      },error=>console.error('상태카드 동기화 오류:',error));
    }else if(Date.now()-started>15000){
      clearInterval(timer);
    }
  },300);
}

window.addEventListener('load',()=>{
  setTimeout(startV19StatusCounter,800);
});
'@

  $html = $html.Replace('</script>', $script + "`r`n</script>")
}

$html = $html.Replace('order-alert-v18','order-alert-v19')
$html = $html.Replace('order-alert-v17','order-alert-v19')
$html = $html.Replace('order-alert-v16','order-alert-v19')

Set-Content -Path $indexPath -Value $html -Encoding UTF8

Write-Host ""
Write-Host "SUCCESS: v19 Coupang status sync installed." -ForegroundColor Green
Write-Host "Mobile horizontal overflow fix included." -ForegroundColor Green
Write-Host ""
Write-Host "Next: Commit and Push with GitHub Desktop." -ForegroundColor Cyan
Write-Host ""

Read-Host "Press Enter"
