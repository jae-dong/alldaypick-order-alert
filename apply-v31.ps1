
$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexPath = Join-Path $project "index.html"
$backendPath = Join-Path $project "backend"
$patchBackend = Join-Path $project "v31-files\backend"
$swPath = Join-Path $project "sw.js"

if (!(Test-Path $indexPath)) {
  Write-Host "ERROR: index.html not found." -ForegroundColor Red
  Read-Host "Press Enter"
  exit 1
}

Copy-Item (Join-Path $patchBackend "coupang.js") (Join-Path $backendPath "coupang.js") -Force
Copy-Item (Join-Path $patchBackend "coupang-claims.js") (Join-Path $backendPath "coupang-claims.js") -Force
Copy-Item (Join-Path $patchBackend "smartstore.js") (Join-Path $backendPath "smartstore.js") -Force
Copy-Item (Join-Path $patchBackend "local-agent.js") (Join-Path $backendPath "local-agent.js") -Force
Copy-Item (Join-Path $patchBackend "package.json") (Join-Path $backendPath "package.json") -Force
Copy-Item (Join-Path $patchBackend ".env.local.example") (Join-Path $backendPath ".env.local.example") -Force

$html = Get-Content -Raw -Encoding UTF8 $indexPath

if ($html -match 'V31_UX_MARKETS') {
  Write-Host "v31 is already installed." -ForegroundColor Yellow
  Read-Host "Press Enter"
  exit 0
}

$style = @'
<style id="V31_UX_MARKETS">
  .status-card[data-key="new"].selected{background:#2563eb;border-color:#2563eb}
  .status-card[data-key="shipping_wait"].selected{background:#d97706;border-color:#d97706}
  .status-card[data-key="cancel"].selected,
  .status-card[data-key="return"].selected,
  .status-card[data-key="exchange"].selected{background:#dc2626;border-color:#dc2626}
  .order-row{cursor:pointer}
  .order-row:hover{background:#f8fafc}
  .copy-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  .detail-grid{display:grid;grid-template-columns:120px 1fr;gap:9px 12px}
  .detail-grid dt{color:var(--muted);font-weight:700}
  .detail-grid dd{margin:0;overflow-wrap:anywhere}
  .market-summary-top{margin-top:12px}
  @media(max-width:800px){
    .detail-grid{grid-template-columns:90px 1fr}
    .copy-grid{grid-template-columns:1fr}
  }
</style>
'@

$html = $html.Replace('</head>', $style + "`r`n</head>")

# Move market summary section immediately after integration section.
$marketPattern = '(?s)<section class="card section">\s*<div class="section-head"><h2>쇼핑몰별 주문</h2>.*?</section>'
$marketMatch = [regex]::Match($html, $marketPattern)

if ($marketMatch.Success) {
  $marketSection = $marketMatch.Value.Replace(
    '<section class="card section">',
    '<section class="card section market-summary-top">'
  )
  $html = $html.Remove($marketMatch.Index, $marketMatch.Length)

  $integrationEndPattern = '(?s)(<section class="card section" id="integrationSection">.*?</section>)'
  $html = [regex]::Replace(
    $html,
    $integrationEndPattern,
    '$1' + "`r`n" + $marketSection,
    1
  )
}

# Add detail dialog before toast.
$detailDialog = @'
<dialog id="detailDialog">
  <div class="modal">
    <h3>주문 상세정보</h3>
    <dl class="detail-grid" id="detailGrid"></dl>
    <div class="copy-grid">
      <button class="btn" id="copyOrderNoBtn">주문번호 복사</button>
      <button class="btn" id="copyBuyerBtn">구매자 복사</button>
      <button class="btn" id="copyProductBtn">상품명 복사</button>
      <button class="btn" id="copyInvoiceBtn">운송장번호 복사</button>
    </div>
    <div class="modal-actions">
      <button class="btn primary" id="closeDetailBtn">닫기</button>
    </div>
  </div>
</dialog>
'@

$html = $html.Replace(
  '<div class="toast" id="toast"></div>',
  $detailDialog + "`r`n<div class=""toast"" id=""toast""></div>"
)

$script = @'
const V31_UX_MARKETS=true;
let v31DetailOrder=null;

function relativeTime(value){
  if(!value) return '아직 실행되지 않음';
  const time=new Date(value).getTime();
  if(!Number.isFinite(time)) return String(value);

  const seconds=Math.max(0,Math.floor((Date.now()-time)/1000));
  if(seconds<15) return '방금 전';
  if(seconds<60) return `${seconds}초 전`;
  const minutes=Math.floor(seconds/60);
  if(minutes<60) return `${minutes}분 전`;
  const hours=Math.floor(minutes/60);
  if(hours<24) return `${hours}시간 전`;
  const days=Math.floor(hours/24);
  return `${days}일 전`;
}

const originalRenderIntegrations=renderIntegrations;
renderIntegrations=function(data={}){
  $('integrationGrid').innerHTML=MARKET_KEYS.map(([key,name])=>{
    const info=data[key]||{};
    const connected=Boolean(info.connected);
    return `<div class="integration-card">
      <div class="integration-head">
        <strong>${name}</strong>
        <span class="badge-connect ${connected?'ready':''}">
          ${connected?'연결됨':'미연결'}
        </span>
      </div>
      <small>최근 확인: ${relativeTime(info.lastRun)}</small>
      <small>${escapeHtml(info.message||'')}</small>
    </div>`;
  }).join('');
};

function copyText(text,label){
  if(!text) return toast(`${label} 정보가 없습니다.`);
  navigator.clipboard.writeText(String(text))
    .then(()=>toast(`${label} 복사 완료`))
    .catch(()=>toast(`${label} 복사 실패`));
}

function openOrderDetail(id){
  const order=orders.find(item=>item.id===id);
  if(!order) return;

  v31DetailOrder=order;
  const fields=[
    ['상태',labelFor(order)],
    ['쇼핑몰',order.market||''],
    ['주문번호',order.orderNo||''],
    ['상품명',order.product||''],
    ['옵션',order.option||''],
    ['수량',Number(order.qty||0)],
    ['구매자',order.buyer||''],
    ['금액',fmt(order.amount)],
    ['주문시간',dateValue(order).replace('T',' ').slice(0,19)],
    ['택배사',order.deliveryCompanyName||''],
    ['운송장번호',order.invoiceNumber||'']
  ];

  $('detailGrid').innerHTML=fields.map(([label,value])=>
    `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`
  ).join('');

  $('detailDialog').showModal();
}

const originalRender=render;
render=function(){
  originalRender();

  document.querySelectorAll('#orderBody tr').forEach(row=>{
    const button=row.querySelector('button[onclick*="toggleRead"]');
    const match=button?.getAttribute('onclick')?.match(/'([^']+)'/);
    if(!match) return;

    row.classList.add('order-row');
    row.onclick=event=>{
      if(event.target.closest('button')) return;
      openOrderDetail(match[1]);
    };
  });
};

$('closeDetailBtn').onclick=()=>$('detailDialog').close();
$('copyOrderNoBtn').onclick=()=>copyText(v31DetailOrder?.orderNo,'주문번호');
$('copyBuyerBtn').onclick=()=>copyText(v31DetailOrder?.buyer,'구매자');
$('copyProductBtn').onclick=()=>copyText(v31DetailOrder?.product,'상품명');
$('copyInvoiceBtn').onclick=()=>copyText(v31DetailOrder?.invoiceNumber,'운송장번호');

setInterval(()=>{
  document.querySelectorAll('.integration-card small:first-of-type')
    .forEach(()=>{});
},30000);
'@

$html = $html.Replace('</script>', $script + "`r`n</script>")
$html = $html.Replace('order-alert-v30','order-alert-v31')

Set-Content -Path $indexPath -Value $html -Encoding UTF8

if (Test-Path $swPath) {
  $sw = Get-Content -Raw -Encoding UTF8 $swPath
  $sw = $sw.Replace("order-alert-v30","order-alert-v31")
  Set-Content -Path $swPath -Value $sw -Encoding UTF8
}

Write-Host ""
Write-Host "SUCCESS: v31 UX and Smartstore starter installed." -ForegroundColor Green
Write-Host ""
Write-Host "Next: npm install, Commit, Push, restart agent." -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter"
