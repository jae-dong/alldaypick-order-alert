
$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexPath = Join-Path $project "index.html"
$backendPath = Join-Path $project "backend"
$patchBackend = Join-Path $project "v20-files\backend"

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
  Write-Host "ERROR: v20-files folder not found." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}

Copy-Item (Join-Path $patchBackend "coupang.js") (Join-Path $backendPath "coupang.js") -Force
Copy-Item (Join-Path $patchBackend "local-agent.js") (Join-Path $backendPath "local-agent.js") -Force

$html = Get-Content -Raw -Encoding UTF8 $indexPath

if ($html -notmatch 'V20_FULL_STATUS_SYNC') {
  $style = @'
  <style id="V20_FULL_STATUS_SYNC">
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
    .grid,
    .market-list,
    .home-two,
    .event-grid,
    .integration-grid,
    .form{
      min-width:0 !important;
      max-width:100% !important;
    }

    .event-grid{
      grid-template-columns:repeat(5,minmax(0,1fr)) !important;
    }

    .v20-status-card{
      min-width:0 !important;
      text-align:center;
    }

    .v20-status-card span{
      display:block;
      font-size:13px;
      color:var(--muted);
      margin-bottom:6px;
    }

    .v20-status-card strong{
      display:block;
      font-size:28px;
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

      input,
      select,
      textarea,
      button,
      img,
      svg{
        max-width:100% !important;
      }
    }
  </style>
'@

  $html = $html.Replace('</head>', $style + "`r`n</head>")

  $script = @'
const V20_FULL_STATUS_SYNC=true;

const V20_STATUS_CARDS=[
  ['new','신규주문'],
  ['shipping_wait','발송대기'],
  ['departure','배송지시'],
  ['delivering','배송중'],
  ['delivered','배송완료'],
  ['cancel','주문취소'],
  ['exchange','교환요청'],
  ['return','반품요청'],
  ['inquiry','문의사항'],
  ['none_tracking','직접배송']
];

function findProcessSection(){
  return [...document.querySelectorAll('section,.card')]
    .find(section=>{
      const h2=section.querySelector('h2');
      return h2&&h2.textContent.trim()==='처리 알림';
    })||null;
}

function buildV20StatusCards(){
  const section=findProcessSection();
  if(!section) return false;

  const grid=section.querySelector('.event-grid')||
    section.querySelector('.grid');

  if(!grid) return false;

  if(grid.dataset.v20Ready==='1') return true;

  grid.dataset.v20Ready='1';
  grid.innerHTML=V20_STATUS_CARDS.map(([key,label])=>`
    <div class="event-card v20-status-card">
      <span>${label}</span>
      <strong id="v20Status_${key}">0</strong>
    </div>
  `).join('');

  return true;
}

function statusKeyForOrder(order){
  const sourceStatus=String(order.sourceStatus||'').toUpperCase();
  const status=String(order.status||'').toLowerCase();
  const eventType=String(order.eventType||'').toLowerCase();

  if(sourceStatus==='ACCEPT'||status==='new') return 'new';
  if(sourceStatus==='INSTRUCT'||status==='shipping_wait') return 'shipping_wait';
  if(sourceStatus==='DEPARTURE'||status==='departure') return 'departure';
  if(sourceStatus==='DELIVERING'||status==='delivering') return 'delivering';
  if(sourceStatus==='FINAL_DELIVERY'||status==='delivered') return 'delivered';
  if(sourceStatus==='NONE_TRACKING'||status==='none_tracking') return 'none_tracking';

  if(eventType==='cancel'||status.includes('cancel')) return 'cancel';
  if(eventType==='exchange'||status.includes('exchange')) return 'exchange';
  if(eventType==='return'||status.includes('return')) return 'return';
  if(eventType==='inquiry'||status.includes('inquiry')) return 'inquiry';

  return '';
}

function updateV20StatusCards(orders){
  buildV20StatusCards();

  const counts=Object.fromEntries(
    V20_STATUS_CARDS.map(([key])=>[key,0])
  );

  for(const order of orders){
    const key=statusKeyForOrder(order);
    if(key&&key in counts) counts[key]+=1;
  }

  for(const [key] of V20_STATUS_CARDS){
    const el=document.getElementById(`v20Status_${key}`);
    if(el) el.textContent=String(counts[key]||0);
  }
}

function startV20StatusSync(){
  const started=Date.now();

  const timer=setInterval(()=>{
    buildV20StatusCards();

    if(
      typeof db!=='undefined'&&
      db&&
      typeof currentUser!=='undefined'&&
      currentUser
    ){
      clearInterval(timer);

      db.collection('orders').onSnapshot(snapshot=>{
        updateV20StatusCards(
          snapshot.docs.map(doc=>({id:doc.id,...doc.data()}))
        );
      },error=>{
        console.error('v20 상태카드 동기화 오류:',error);
      });
    }else if(Date.now()-started>15000){
      clearInterval(timer);
    }
  },300);
}

window.addEventListener('load',()=>{
  setTimeout(startV20StatusSync,900);
});
'@

  $html = $html.Replace('</script>', $script + "`r`n</script>")
}

$html = $html.Replace('order-alert-v19','order-alert-v20')
$html = $html.Replace('order-alert-v18','order-alert-v20')
$html = $html.Replace('order-alert-v17','order-alert-v20')

Set-Content -Path $indexPath -Value $html -Encoding UTF8

Write-Host ""
Write-Host "SUCCESS: v20 full Coupang status sync installed." -ForegroundColor Green
Write-Host "Firebase configuration was preserved." -ForegroundColor Green
Write-Host ""
Write-Host "Next: Commit and Push with GitHub Desktop." -ForegroundColor Cyan
Write-Host ""

Read-Host "Press Enter"
