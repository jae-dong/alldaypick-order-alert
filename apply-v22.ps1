
$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexPath = Join-Path $project "index.html"
$swPath = Join-Path $project "sw.js"

if (!(Test-Path $indexPath)) {
  Write-Host "ERROR: index.html not found." -ForegroundColor Red
  Write-Host "Copy this patch into the alldaypick-order-alert folder first."
  Read-Host "Press Enter"
  exit 1
}

$html = Get-Content -Raw -Encoding UTF8 $indexPath

if ($html -match 'V22_STATUS_BOARD') {
  Write-Host "v22 status board is already installed." -ForegroundColor Yellow
  Read-Host "Press Enter"
  exit 0
}

$style = @'
  <style id="V22_STATUS_BOARD">
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

    #v22ProcessGrid{
      display:grid !important;
      grid-template-columns:repeat(5,minmax(0,1fr)) !important;
      gap:12px !important;
      width:100% !important;
      min-width:0 !important;
    }

    .v22-status-card{
      min-width:0 !important;
      padding:18px 12px !important;
      border:1px solid var(--line,#e5e7eb) !important;
      border-radius:16px !important;
      background:var(--card,#fff) !important;
      text-align:center !important;
    }

    .v22-status-card span{
      display:block;
      color:var(--muted,#6b7280);
      font-size:13px;
      margin-bottom:7px;
      white-space:normal;
      word-break:keep-all;
    }

    .v22-status-card strong{
      display:block;
      font-size:28px;
      line-height:1.1;
    }

    .v22-status-card[data-key="new"] strong,
    .v22-status-card[data-key="shipping_wait"] strong{
      color:var(--ink,#111827);
    }

    #v22StatusUpdated{
      color:var(--muted,#6b7280);
      font-size:12px;
      white-space:nowrap;
    }

    @media(max-width:800px){
      .app{
        width:100% !important;
        max-width:100% !important;
        padding-left:10px !important;
        padding-right:10px !important;
        margin-left:0 !important;
        margin-right:0 !important;
      }

      #v22ProcessGrid{
        grid-template-columns:repeat(2,minmax(0,1fr)) !important;
        gap:9px !important;
      }

      .v22-status-card{
        padding:15px 8px !important;
      }

      .v22-status-card strong{
        font-size:25px;
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
const V22_STATUS_BOARD=true;

const V22_STATUS_ITEMS=[
  ['new','신규주문'],
  ['shipping_wait','발송대기'],
  ['departure','배송지시'],
  ['delivering','배송중'],
  ['delivered','배송완료'],
  ['none_tracking','직접배송'],
  ['cancel','주문취소'],
  ['exchange','교환요청'],
  ['return','반품요청'],
  ['inquiry','문의사항']
];

function v22FindProcessSection(){
  return [...document.querySelectorAll('section,.card')]
    .find(section=>{
      const title=section.querySelector('h2');
      return title&&title.textContent.trim()==='처리 알림';
    })||null;
}

function v22BuildBoard(){
  const section=v22FindProcessSection();
  if(!section) return false;

  const oldGrid=
    section.querySelector('.event-grid')||
    section.querySelector('.grid');

  if(!oldGrid) return false;

  oldGrid.id='v22ProcessGrid';
  oldGrid.className='event-grid';
  oldGrid.innerHTML=V22_STATUS_ITEMS.map(([key,label])=>`
    <div class="v22-status-card" data-key="${key}">
      <span>${label}</span>
      <strong id="v22Count_${key}">0</strong>
    </div>
  `).join('');

  const head=section.querySelector('.section-head');
  if(head&&!document.getElementById('v22StatusUpdated')){
    const old=head.querySelector('span');
    if(old) old.remove();

    const updated=document.createElement('span');
    updated.id='v22StatusUpdated';
    updated.textContent='실시간 동기화';
    head.appendChild(updated);
  }

  return true;
}

function v22StatusKey(order){
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

function v22UpdateCounts(orders){
  v22BuildBoard();

  const counts=Object.fromEntries(
    V22_STATUS_ITEMS.map(([key])=>[key,0])
  );

  for(const order of orders){
    const key=v22StatusKey(order);
    if(key&&Object.prototype.hasOwnProperty.call(counts,key)){
      counts[key]+=1;
    }
  }

  for(const [key] of V22_STATUS_ITEMS){
    const el=document.getElementById(`v22Count_${key}`);
    if(el) el.textContent=String(counts[key]||0);
  }

  const updated=document.getElementById('v22StatusUpdated');
  if(updated){
    updated.textContent=
      '최근 갱신 '+new Date().toLocaleTimeString('ko-KR',{
        hour:'2-digit',
        minute:'2-digit'
      });
  }
}

function v22StartRealtimeBoard(){
  const started=Date.now();

  const timer=setInterval(()=>{
    v22BuildBoard();

    if(
      typeof db!=='undefined'&&
      db&&
      typeof currentUser!=='undefined'&&
      currentUser
    ){
      clearInterval(timer);

      db.collection('orders').onSnapshot(snapshot=>{
        v22UpdateCounts(
          snapshot.docs.map(doc=>({
            id:doc.id,
            ...doc.data()
          }))
        );
      },error=>{
        console.error('v22 상태판 동기화 오류:',error);
      });
    }else if(Date.now()-started>15000){
      clearInterval(timer);
    }
  },300);
}

window.addEventListener('load',()=>{
  setTimeout(v22StartRealtimeBoard,900);
});

document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){
    setTimeout(v22BuildBoard,300);
  }
});
'@

$html = $html.Replace('</script>', $script + "`r`n</script>")
$html = $html.Replace('order-alert-v21','order-alert-v22')
$html = $html.Replace('order-alert-v20','order-alert-v22')
$html = $html.Replace('order-alert-v19','order-alert-v22')

Set-Content -Path $indexPath -Value $html -Encoding UTF8

if (Test-Path $swPath) {
  $sw = Get-Content -Raw -Encoding UTF8 $swPath
  $sw = [regex]::Replace(
    $sw,
    "order-alert-v\d+",
    "order-alert-v22"
  )
  Set-Content -Path $swPath -Value $sw -Encoding UTF8
}

Write-Host ""
Write-Host "SUCCESS: v22 realtime status board installed." -ForegroundColor Green
Write-Host "Firebase configuration and collector were preserved." -ForegroundColor Green
Write-Host ""
Write-Host "Next: Commit and Push with GitHub Desktop." -ForegroundColor Cyan
Write-Host ""

Read-Host "Press Enter"
