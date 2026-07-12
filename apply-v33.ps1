
$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexPath = Join-Path $project "index.html"
$backendPath = Join-Path $project "backend"
$patchBackend = Join-Path $project "v33-files\backend"
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

$html = Get-Content -Raw -Encoding UTF8 $indexPath

if ($html -match 'V33_MARKET_FILTER_PUSH') {
  Write-Host "v33 is already installed." -ForegroundColor Yellow
  Read-Host "Press Enter"
  exit 0
}

$style = @'
<style id="V33_MARKET_FILTER_PUSH">
  .market-box{
    cursor:pointer;
    transition:transform .15s ease,border-color .15s ease,box-shadow .15s ease;
  }

  .market-box:active{
    transform:scale(.98);
  }

  .market-box.selected{
    background:#111827 !important;
    color:#fff !important;
    border-color:#111827 !important;
    box-shadow:0 0 0 2px rgba(17,24,39,.12);
  }

  .market-box.selected strong,
  .market-box.selected b{
    color:#fff !important;
  }

  .pagination{
    display:flex;
    align-items:center;
    justify-content:center;
    gap:8px;
    margin-top:14px;
    flex-wrap:wrap;
  }

  .page-info{
    color:var(--muted);
    font-size:13px;
    min-width:90px;
    text-align:center;
  }

  .status-card[data-key="purchase_confirmed"].selected{
    background:#059669;
    border-color:#059669;
  }

  #detailGrid dd{
    white-space:pre-wrap;
  }
</style>
'@

$html = $html.Replace('</head>', $style + "`r`n</head>")

# Add pagination below table.
$html = $html.Replace(
  '</div>' + "`r`n" + '      </section>' + "`r`n" + '      <section class="card section market-summary-top">',
  '</div>' + "`r`n" +
  '        <div class="pagination" id="pagination">' + "`r`n" +
  '          <button class="btn" id="prevPageBtn">이전</button>' + "`r`n" +
  '          <span class="page-info" id="pageInfo">1 / 1</span>' + "`r`n" +
  '          <button class="btn" id="nextPageBtn">다음</button>' + "`r`n" +
  '        </div>' + "`r`n" +
  '      </section>' + "`r`n" +
  '      <section class="card section market-summary-top>'
)

$script = @'
const V33_MARKET_FILTER_PUSH=true;

let activeMarket='';
let currentPage=1;
const PAGE_SIZE=40;

if(!STATUS_ITEMS.some(item=>item[0]==='purchase_confirmed')){
  STATUS_ITEMS.splice(5,0,['purchase_confirmed','구매확정']);
}

const v33OriginalFilteredOrders=filteredOrders;

filteredOrders=function(){
  return v33OriginalFilteredOrders()
    .filter(order=>!activeMarket||order.market===activeMarket);
};

function v33FullFilteredOrders(){
  const q=$('searchInput').value.trim().toLowerCase();
  const market=$('marketFilter').value;
  const read=$('readFilter').value;

  return [...orders].filter(order=>{
    const hit=!q||[
      order.product,
      order.orderNo,
      order.buyer,
      order.phone,
      order.invoiceNumber
    ].some(value=>
      String(value||'').toLowerCase().includes(q)
    );

    return hit&&
      (!market||order.market===market)&&
      (!activeMarket||order.market===activeMarket)&&
      (!activeStatus||statusKey(order)===activeStatus)&&
      (!read||(read==='unread'?isUnread(order):!isUnread(order)));
  }).sort((a,b)=>dateValue(b).localeCompare(dateValue(a)));
}

function v33PagedOrders(){
  const all=v33FullFilteredOrders();
  const pages=Math.max(1,Math.ceil(all.length/PAGE_SIZE));

  if(currentPage>pages) currentPage=pages;
  if(currentPage<1) currentPage=1;

  return {
    all,
    pages,
    items:all.slice(
      (currentPage-1)*PAGE_SIZE,
      currentPage*PAGE_SIZE
    )
  };
}

const v33OriginalStatusKey=statusKey;

statusKey=function(order){
  const status=String(order.status||'').toLowerCase();
  const source=String(order.sourceStatus||'').toUpperCase();

  if(
    status==='purchase_confirmed'||
    source.includes('PURCHASE_DECIDED')
  ){
    return 'purchase_confirmed';
  }

  return v33OriginalStatusKey(order);
};

const v33OriginalRender=render;

render=function(){
  const today=todayKey();
  const todayOrders=orders.filter(order=>orderDay(order)===today);

  $('todayCount').textContent=todayOrders.length;
  $('unreadCount').textContent=orders.filter(isUnread).length;
  $('todaySales').textContent=fmt(
    todayOrders.reduce((sum,order)=>sum+Number(order.amount||0),0)
  );
  $('allCount').textContent=orders.length;

  renderStatus();

  const page=v33PagedOrders();
  $('orderResultCount').textContent=page.all.length+'건';

  $('filterBanner').classList.toggle(
    'active',
    Boolean(activeStatus||activeMarket)
  );

  const statusText=activeStatus
    ? Object.fromEntries(STATUS_ITEMS)[activeStatus]
    : '';

  const parts=[
    activeMarket,
    statusText
  ].filter(Boolean);

  $('filterText').textContent=parts.length
    ? `${parts.join(' · ')}만 표시 중`
    : '';

  $('orderBody').innerHTML=page.items.length
    ? page.items.map(order=>`<tr>
      <td data-label="상태">
        <span class="status-pill">${escapeHtml(labelFor(order))}</span>
      </td>
      <td data-label="일시">
        ${escapeHtml(dateValue(order).replace('T',' ').slice(0,16))}
      </td>
      <td data-label="쇼핑몰">${escapeHtml(order.market||'')}</td>
      <td data-label="주문번호">${escapeHtml(order.orderNo||'')}</td>
      <td class="product-cell">${escapeHtml(order.product||'상품명 없음')}</td>
      <td data-label="수량">${Number(order.qty||0)}</td>
      <td data-label="구매자">${escapeHtml(order.buyer||'')}</td>
      <td data-label="금액">${fmt(order.amount)}</td>
      <td data-label="관리">
        <button class="btn" onclick="toggleRead('${order.id}')">
          ${isUnread(order)?'확인':'미확인'}
        </button>
      </td>
    </tr>`).join('')
    : `<tr>
        <td colspan="9" style="text-align:center;color:var(--muted);padding:28px">
          해당 주문이 없습니다.
        </td>
      </tr>`;

  const markets=[
    '쿠팡',
    '스마트스토어',
    '11번가',
    'G마켓',
    '옥션',
    '롯데온'
  ];

  $('marketGrid').innerHTML=markets.map(market=>`
    <div class="market-box ${activeMarket===market?'selected':''}"
         data-market="${market}">
      <strong>${market}</strong>
      <b>${orders.filter(order=>order.market===market).length}</b>건
    </div>
  `).join('');

  $('marketGrid').querySelectorAll('.market-box').forEach(card=>{
    card.onclick=()=>{
      activeMarket=activeMarket===card.dataset.market
        ? ''
        : card.dataset.market;

      currentPage=1;
      showOrdersTab();
      render();
    };
  });

  $('pageInfo').textContent=`${currentPage} / ${page.pages}`;
  $('prevPageBtn').disabled=currentPage<=1;
  $('nextPageBtn').disabled=currentPage>=page.pages;

  renderStats();

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

$('prevPageBtn').onclick=()=>{
  if(currentPage>1){
    currentPage--;
    render();
    $('ordersPanel').scrollIntoView({behavior:'smooth',block:'start'});
  }
};

$('nextPageBtn').onclick=()=>{
  const pages=Math.max(
    1,
    Math.ceil(v33FullFilteredOrders().length/PAGE_SIZE)
  );

  if(currentPage<pages){
    currentPage++;
    render();
    $('ordersPanel').scrollIntoView({behavior:'smooth',block:'start'});
  }
};

const v33OldClear=$('clearFilterBtn').onclick;
$('clearFilterBtn').onclick=()=>{
  activeStatus='';
  activeMarket='';
  currentPage=1;
  $('marketFilter').value='';
  render();
};

['searchInput','marketFilter','readFilter'].forEach(id=>{
  const element=$(id);
  const oldHandler=element.oninput||element.onchange;

  if(id==='searchInput'){
    element.oninput=()=>{
      currentPage=1;
      render();
    };
  }else{
    element.onchange=()=>{
      currentPage=1;
      render();
    };
  }
});

const v33OldOpenOrderDetail=openOrderDetail;

openOrderDetail=function(id){
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
    ['연락처',order.phone||''],
    ['주소',order.address||''],
    ['배송메모',order.deliveryMemo||''],
    ['금액',fmt(order.amount)],
    ['주문시간',dateValue(order).replace('T',' ').slice(0,19)],
    ['택배사',order.deliveryCompanyName||''],
    ['운송장번호',order.invoiceNumber||'']
  ];

  $('detailGrid').innerHTML=fields.map(([label,value])=>
    `<dt>${escapeHtml(label)}</dt>
     <dd>${escapeHtml(value)}</dd>`
  ).join('');

  $('detailDialog').showModal();
};

const copyGrid=$('detailDialog').querySelector('.copy-grid');

if(copyGrid&&!$('copyPhoneBtn')){
  const button=document.createElement('button');
  button.className='btn';
  button.id='copyPhoneBtn';
  button.textContent='연락처 복사';
  button.onclick=()=>copyText(
    v31DetailOrder?.phone,
    '연락처'
  );
  copyGrid.appendChild(button);
}

setTimeout(render,500);
'@

$html = $html.Replace('</script>', $script + "`r`n</script>")
$html = $html.Replace('order-alert-v31','order-alert-v33')
$html = $html.Replace('order-alert-v32','order-alert-v33')

Set-Content -Path $indexPath -Value $html -Encoding UTF8

if (Test-Path $swPath) {
  $sw = Get-Content -Raw -Encoding UTF8 $swPath
  $sw = [regex]::Replace(
    $sw,
    "order-alert-v\d+",
    "order-alert-v33"
  )
  Set-Content -Path $swPath -Value $sw -Encoding UTF8
}

Write-Host ""
Write-Host "SUCCESS: v33 market filters and Smartstore push installed." -ForegroundColor Green
Write-Host ""
Write-Host "Next: npm install, Commit, Push, restart agent." -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter"
