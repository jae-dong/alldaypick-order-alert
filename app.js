const APP_VERSION='CLEAN v1.0.1';
const BUILD_DATE='2026-07-14';
const firebaseConfig={"apiKey": "AIzaSyCFRmQPRvYznJV-MTzKb__SpYDfvMpmgAo", "authDomain": "alldaypick-order-alert.firebaseapp.com", "projectId": "alldaypick-order-alert", "storageBucket": "alldaypick-order-alert.firebasestorage.app", "messagingSenderId": "549342074740", "appId": "1:549342074740:web:c003e0eb0e75097008be21"};
let auth=null;
let db=null;
const $=id=>document.getElementById(id);
const fmt=n=>Number(n||0).toLocaleString('ko-KR')+'원';
const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const MARKETS=[['coupang','쿠팡'],['smartstore','스마트스토어'],['elevenst','11번가'],['gmarket','G마켓'],['auction','옥션'],['lotteon','롯데온']];
const STATUS_ITEMS=[['new','신규주문'],['shipping_wait','발송대기'],['cancel','주문취소'],['return','반품요청'],['exchange','교환요청'],['inquiry','문의사항']];
let orders=[],integrations={},currentUser=null,activeStatus='',activeMarket='',currentPage=1,currentDetail=null,unsubscribeOrders=null,collectUnsub=null;
const PAGE_SIZE=40;

function toast(text){const el=$('toast');el.textContent=text;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2200)}
function dateValue(o){const v=o.datetime||o.createdAt?.toDate?.()?.toISOString?.()||o.updatedAt?.toDate?.()?.toISOString?.()||'';return String(v)}
function orderDay(o){const d=new Date(dateValue(o));if(Number.isNaN(d.getTime()))return'';return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(d)}
function todayKey(){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date())}
function monthKey(){return todayKey().slice(0,7)}
function statusKey(o){
  const ss=String(o.sourceStatus||'').toUpperCase(),st=String(o.status||'').toLowerCase(),ev=String(o.eventType||'order').toLowerCase();
  if(st==='purchase_confirmed'||ss.includes('PURCHASE_DECIDED')||ss.includes('PURCHASE_CONFIRM'))return'delivered';
  if(ev==='cancel'||st.includes('cancel')||ss.includes('CANCEL')||ss.includes('취소'))return'cancel';
  if(ev==='return'||st.includes('return')||ss.includes('RETURN')||ss.includes('반품'))return'return';
  if(ev==='exchange'||st.includes('exchange')||ss.includes('EXCHANGE')||ss.includes('교환'))return'exchange';
  if(ev==='inquiry'||st.includes('inquiry'))return'inquiry';
  if(ss==='ACCEPT'||st==='new'||ss.includes('PAYED'))return'new';
  if(ss==='INSTRUCT'||st==='shipping_wait'||ss.includes('PREPARE')||ss.includes('READY'))return'shipping_wait';
  if(ss==='DEPARTURE'||ss==='DELIVERING'||st==='departure'||st==='delivering'||ss.includes('SHIPPED'))return'delivering';
  if(ss==='FINAL_DELIVERY'||st==='delivered'||ss.includes('DELIVERED'))return'delivered';
  return st||'';
}
function labelFor(o){return Object.fromEntries(STATUS_ITEMS)[statusKey(o)]||o.statusLabel||'주문'}
function isUnread(o){return o.readStatus!=='read'}
function isProcessed(o){
  return Boolean(o.workflowProcessed);
}

function completionText(o){
  return [
    o.sourceStatus,
    o.statusLabel,
    o.claimStatus,
    o.processingStatus,
    o.resultStatus
  ].filter(Boolean).join(' ').toUpperCase();
}

function isClaimCompleted(o){
  const key=statusKey(o);

  if(!['cancel','return','exchange','inquiry'].includes(key)){
    return false;
  }

  const text=completionText(o);

  return [
    'COMPLETE','COMPLETED','CLOSED','DONE',
    'FINISH','FINISHED','WITHDRAW','REJECTED',
    'CANCEL_COMPLETE','RETURN_COMPLETE','EXCHANGE_COMPLETE',
    '처리완료','취소완료','반품완료','교환완료',
    '답변완료','철회','종결'
  ].some(word=>text.includes(word));
}

function isActuallyUnresolved(o){
  return (
    isPendingStatus(statusKey(o)) &&
    !isProcessed(o) &&
    !isClaimCompleted(o)
  );
}

function marketIntegrationKey(market){
  return {
    쿠팡:'coupang',
    스마트스토어:'smartstore',
    '11번가':'elevenst',
    G마켓:'gmarket',
    옥션:'auction',
    롯데온:'lotteon'
  }[market]||'';
}

function marketIncludedOrder(o){
  if(!['G마켓','옥션'].includes(o.market)){
    return true;
  }

  const info=integrations[marketIntegrationKey(o.market)]||{};

  if(!info.connected){
    return false;
  }

  const connectedAt=info.connectedAt||info.firstConnectedAt||'';

  if(!connectedAt){
    return true;
  }

  return new Date(o.datetime||0).getTime()>=
    new Date(connectedAt).getTime();
}

function financialOrders(){
  return salesUniqueOrders().filter(marketIncludedOrder);
}
function isImportant(o){return Boolean(o.workflowImportant)}
function isSalesOrder(o){
  const key=statusKey(o);

  return (
    String(o.eventType||'order')==='order' &&
    !['cancel','return','exchange','inquiry'].includes(key)
  );
}
function relativeTime(value){if(!value)return'아직 실행되지 않음';const t=new Date(value).getTime();if(!Number.isFinite(t))return String(value);const s=Math.max(0,Math.floor((Date.now()-t)/1000));if(s<20)return'방금 전';if(s<60)return`${s}초 전`;const m=Math.floor(s/60);if(m<60)return`${m}분 전`;const h=Math.floor(m/60);if(h<24)return`${h}시간 전`;return`${Math.floor(h/24)}일 전`}

function timestampValue(o){
  const candidates=[
    o.updatedAt?.toDate?.()?.getTime?.(),
    o.syncedAt?new Date(o.syncedAt).getTime():0,
    o.statusUpdatedAt?new Date(o.statusUpdatedAt).getTime():0,
    o.createdAt?.toDate?.()?.getTime?.(),
    o.datetime?new Date(o.datetime).getTime():0
  ].filter(v=>Number.isFinite(v)&&v>0);

  return candidates.length?Math.max(...candidates):0;
}

function normalizedText(value){
  return String(value||'')
    .trim()
    .toLowerCase()
    .replace(/\s+/g,' ');
}

function canonicalItemKey(o){
  const market=normalizedText(o.market||o.source);
  const orderNo=normalizedText(o.orderNo||o.orderId);
  const lineId=normalizedText(
    o.orderProductSequence ||
    o.orderItemId ||
    o.vendorItemId ||
    o.deliveryNo ||
    o.shipmentBoxId ||
    o.productNo ||
    o.itemId ||
    o.sku ||
    ''
  );

  if(orderNo&&lineId){
    return `${market}|${orderNo}|${lineId}`;
  }

  const product=normalizedText(o.product);
  const option=normalizedText(o.option);

  if(orderNo&&(product||option)){
    return `${market}|${orderNo}|${product}|${option}`;
  }

  return `${market}|${normalizedText(o.id)}`;
}

function statusPriority(o){
  const key=statusKey(o);

  const priorities={
    inquiry:90,
    exchange:85,
    return:84,
    cancel:83,
    delivered:70,
    delivering:60,
    shipping_wait:50,
    new:40
  };

  return priorities[key]||0;
}

function uniqueLatestOrders(source=orders){
  const groups=new Map();

  source.forEach(order=>{
    const key=canonicalItemKey(order);
    const current=groups.get(key);

    if(!current){
      groups.set(key,order);
      return;
    }

    const currentTime=timestampValue(current);
    const nextTime=timestampValue(order);

    if(
      nextTime>currentTime ||
      (
        nextTime===currentTime &&
        statusPriority(order)>statusPriority(current)
      )
    ){
      groups.set(key,order);
    }
  });

  return [...groups.values()];
}

function sevenDaysAgoKey(){
  const now=new Date();
  now.setDate(now.getDate()-6);

  return new Intl.DateTimeFormat(
    'sv-SE',
    {timeZone:'Asia/Seoul'}
  ).format(now);
}

function isRecentSevenDays(o){
  const day=orderDay(o);
  return Boolean(day&&day>=sevenDaysAgoKey()&&day<=todayKey());
}

function activePeriodMatch(o,key){
  if(isPendingStatus(key)){
    return isActuallyUnresolved(o);
  }

  return true;
}

function salesUniqueOrders(){
  return uniqueLatestOrders().filter(isSalesOrder);
}



const MONTHLY_SETTLEMENT_BASELINE={
  month:'2026-07',
  cutoffDay:'2026-07-13',
  orderCount:445,
  salesAmount:16869770,
  daily:{
    '2026-07-01':{orders:33,sales:1541000},
    '2026-07-02':{orders:36,sales:1122130},
    '2026-07-03':{orders:33,sales:1063690},
    '2026-07-04':{orders:18,sales:601080},
    '2026-07-05':{orders:30,sales:1262220},
    '2026-07-06':{orders:41,sales:2014670},
    '2026-07-07':{orders:47,sales:1584420},
    '2026-07-08':{orders:36,sales:1241020},
    '2026-07-09':{orders:31,sales:1290870},
    '2026-07-10':{orders:22,sales:747570},
    '2026-07-11':{orders:40,sales:1589250},
    '2026-07-12':{orders:32,sales:1155400},
    '2026-07-13':{orders:46,sales:1656450}
  }
};

function settlementMonthlyTotals(){
  const month=monthKey();
  const salesOrders=salesUniqueOrders();

  if(month!==MONTHLY_SETTLEMENT_BASELINE.month){
    const monthly=salesOrders.filter(o=>
      orderDay(o).slice(0,7)===month
    );

    return {
      count:monthly.length,
      sales:monthly.reduce(
        (sum,o)=>sum+Number(o.amount||0),
        0
      ),
      corrected:false
    };
  }

  const afterCutoff=salesOrders.filter(o=>{
    const day=orderDay(o);
    return day>MONTHLY_SETTLEMENT_BASELINE.cutoffDay &&
      day.slice(0,7)===month;
  });

  return {
    count:
      MONTHLY_SETTLEMENT_BASELINE.orderCount+
      afterCutoff.length,
    sales:
      MONTHLY_SETTLEMENT_BASELINE.salesAmount+
      afterCutoff.reduce(
        (sum,o)=>sum+Number(o.amount||0),
        0
      ),
    corrected:true
  };
}


const CURRENT_REFERENCE={
  financialCutoff:'2026-07-14T07:44:48+09:00',
  pendingCutoff:'2026-07-14T07:45:30+09:00',
  today:'2026-07-14',
  todayOrders:6,
  todaySales:212670,
  monthOrders:451,
  monthSales:17082440,

  pending:{
    스마트스토어:{
      new:2,
      shipping_wait:6,
      cancel:0,
      return:0,
      exchange:0,
      inquiry:0
    },
    쿠팡:{
      new:13,
      shipping_wait:13,
      cancel:0,
      return:0,
      exchange:1,
      inquiry:0
    },
    '11번가':{
      new:0,
      shipping_wait:2,
      cancel:0,
      return:0,
      exchange:0,
      inquiry:0
    },
    G마켓:{
      new:1,
      shipping_wait:4,
      cancel:0,
      return:0,
      exchange:0,
      inquiry:0
    },
    옥션:{
      new:0,
      shipping_wait:0,
      cancel:0,
      return:0,
      exchange:0,
      inquiry:0
    },
    롯데온:{
      new:0,
      shipping_wait:0,
      cancel:0,
      return:0,
      exchange:0,
      inquiry:0
    }
  },

  delivery:{
    스마트스토어:{
      return_complete:1,
      delivering:15,
      delivered:17,
      purchase_confirmed:40
    },
    쿠팡:{
      return_complete:5,
      delivering:50,
      delivered:170,
      purchase_confirmed:104
    },
    '11번가':{
      return_complete:0,
      delivering:8,
      delivered:10,
      purchase_confirmed:5
    },
    G마켓:{
      return_complete:0,
      delivering:4,
      delivered:10,
      purchase_confirmed:6
    },
    옥션:{
      return_complete:0,
      delivering:0,
      delivered:2,
      purchase_confirmed:1
    },
    롯데온:{
      return_complete:0,
      delivering:1,
      delivered:0,
      purchase_confirmed:6
    }
  }
};

function referenceCutoffMs(){
  return new Date(
    CURRENT_REFERENCE.financialCutoff
  ).getTime();
}

function pendingReferenceCutoffMs(){
  return new Date(
    CURRENT_REFERENCE.pendingCutoff
  ).getTime();
}

function createdTimestampValue(order){
  const values=[
    order.createdAt?.toDate?.()?.getTime?.(),
    order.datetime?new Date(order.datetime).getTime():0
  ].filter(value=>Number.isFinite(value)&&value>0);

  return values.length?Math.min(...values):0;
}

function processedTimestampValue(order){
  const value=
    order.workflowProcessedAt
      ?.toDate?.()
      ?.getTime?.();

  return Number.isFinite(value)?value:0;
}

function isPendingStatus(key){
  return [
    'new',
    'shipping_wait',
    'cancel',
    'return',
    'exchange',
    'inquiry'
  ].includes(key);
}

function isUnresolved(order){
  return (
    isPendingStatus(statusKey(order)) &&
    !isProcessed(order)
  );
}

function liveOrdersAfterReference(){
  const cutoff=pendingReferenceCutoffMs();

  return uniqueLatestOrders().filter(order=>
    createdTimestampValue(order)>cutoff
  );
}

function processedBaselineAdjustments(){
  const cutoff=pendingReferenceCutoffMs();

  return uniqueLatestOrders().filter(order=>
    processedTimestampValue(order)>cutoff &&
    createdTimestampValue(order)<=cutoff
  );
}

function correctedPendingByMarket(){
  const result={};

  MARKETS.forEach(([,name])=>{
    result[name]={
      new:0,
      shipping_wait:0,
      cancel:0,
      return:0,
      exchange:0,
      inquiry:0
    };
  });

  uniqueLatestOrders().forEach(order=>{
    const market=order.market;
    const key=statusKey(order);

    if(
      result[market] &&
      isPendingStatus(key) &&
      isActuallyUnresolved(order)
    ){
      result[market][key]+=1;
    }
  });

  return result;
}


function correctedDeliveryTotals(){
  const result={
    return_complete:0,
    delivering:0,
    delivered:0,
    purchase_confirmed:0
  };

  uniqueLatestOrders().forEach(order=>{
    const key=statusKey(order);

    if(Object.prototype.hasOwnProperty.call(result,key)){
      result[key]+=1;
    }
  });

  return result;
}

function renderDeliverySummary(){
  let section=document.getElementById('deliverySummary');

  if(!section){
    section=document.createElement('section');
    section.id='deliverySummary';
    section.className='panel';

    section.innerHTML=`
      <div class="section-head">
        <div>
          <h2>배송 현황</h2>
          <p>현재 기준 누적 현황</p>
        </div>
        <span class="small-note">
          기준 오전 7:41
        </span>
      </div>

      <div class="delivery-summary-grid" id="deliverySummaryGrid"></div>
    `;

    const statusSection=
      document.getElementById('statusGrid')
        ?.closest('section');

    if(statusSection){
      statusSection.insertAdjacentElement(
        'afterend',
        section
      );
    }
  }

  const totals=correctedDeliveryTotals();
  const items=[
    ['delivering','배송중'],
    ['delivered','배송완료'],
    ['purchase_confirmed','구매확정'],
    ['return_complete','반품완료']
  ];

  document.getElementById('deliverySummaryGrid').innerHTML=
    items.map(([key,label])=>`
      <div class="delivery-summary-card ${key}">
        <span>${label}</span>
        <strong>${totals[key]}</strong>
      </div>
    `).join('');
}

function correctedTodayTotals(){
  const today=todayKey();
  const list=financialOrders().filter(order=>
    orderDay(order)===today
  );

  return {
    count:list.length,
    sales:list.reduce(
      (sum,order)=>sum+Number(order.amount||0),
      0
    )
  };
}

function correctedMonthTotals(){
  const month=monthKey();
  const list=financialOrders().filter(order=>
    orderDay(order).slice(0,7)===month
  );

  return {
    count:list.length,
    sales:list.reduce(
      (sum,order)=>sum+Number(order.amount||0),
      0
    )
  };
}

function renderIntegrations(){
  $('integrationGrid').innerHTML=MARKETS.map(([key,name])=>{const info=integrations[key]||{},ok=Boolean(info.connected);return`<div class="integration"><strong>${name}</strong><span class="connection ${ok?'ok':''}">${ok?'연결됨':'미연결'}</span><small>${relativeTime(info.lastRun)}</small></div>`}).join('');
}
function renderMetrics(){
  const todayTotals=correctedTodayTotals();
  const monthTotals=correctedMonthTotals();
  const month=monthKey();

  $('todayCount').textContent=todayTotals.count;
  $('todaySales').textContent=fmt(todayTotals.sales);
  $('monthCount').textContent=monthTotals.count;
  $('monthSales').textContent=fmt(monthTotals.sales);

  const monthNote=
    `${Number(month.slice(5,7))}월 1일부터 오늘까지`;

  $('monthCountNote').textContent=monthNote;
  $('monthSalesNote').textContent=monthNote;
}
function renderStatus(){
  const pending=correctedPendingByMarket();
  const counts=Object.fromEntries(
    STATUS_ITEMS.map(([key])=>[key,0])
  );

  Object.values(pending).forEach(market=>{
    STATUS_ITEMS.forEach(([key])=>{
      counts[key]+=Number(market[key]||0);
    });
  });

  const statusGrid=$('statusGrid');
  if(!statusGrid) return;
  statusGrid.innerHTML=STATUS_ITEMS.map(([key,label])=>`
    <button class="alert-card ${activeStatus===key?'active':''}" data-key="${key}">
      <span>${label}</span>
      <strong>${counts[key]}</strong>
    </button>
  `).join('');

  statusGrid.querySelectorAll('button').forEach(button=>{
    button.onclick=()=>{
      activeStatus=
        activeStatus===button.dataset.key
          ?''
          :button.dataset.key;

      currentPage=1;
      showOrdersTab();
      render();
    };
  });

  const dedupeInfo=$('dedupeInfo');
  if(dedupeInfo){
    dedupeInfo.textContent='실제 미처리 상태만 표시 · 완료 시 자동 제외';
  }
  $('statusUpdated').textContent=
    '최근 갱신 '+
    new Date().toLocaleTimeString(
      'ko-KR',
      {hour:'2-digit',minute:'2-digit'}
    );
}
function renderMarkets(){
  const today=todayKey();
  const unique=uniqueLatestOrders();
  const pending=correctedPendingByMarket();

  $('marketBody').innerHTML=MARKETS.map(([key,name])=>{
    const todayList=unique.filter(order=>
      order.market===name &&
      orderDay(order)===today
    );

    const salesList=todayList.filter(isSalesOrder);
    const marketPending=pending[name]||{};
    const ok=Boolean(integrations[key]?.connected);

    const todayCount=salesList.length;
    const todaySales=salesList.reduce(
      (sum,order)=>sum+Number(order.amount||0),
      0
    );

    return `<tr class="market-row ${activeMarket===name?'selected':''}" data-market="${name}">
      <td>
        <span class="market-name">
          <span class="market-dot ${ok?'ok':''}"></span>
          ${name}
        </span>
      </td>
      <td class="order-sales-cell">
        <strong>${todayCount}</strong>
        <small>${fmt(todaySales)}</small>
      </td>
      <td class="new-count">${Number(marketPending.new||0)}</td>
      <td class="wait-count">${Number(marketPending.shipping_wait||0)}</td>
      <td class="claim-count">${Number(marketPending.cancel||0)}</td>
      <td class="claim-count">${Number(marketPending.return||0)}</td>
      <td class="claim-count">${Number(marketPending.exchange||0)}</td>
    </tr>`;
  }).join('');

  $('marketBody').querySelectorAll('tr').forEach(row=>{
    row.onclick=()=>{
      activeMarket=
        activeMarket===row.dataset.market
          ?''
          :row.dataset.market;

      currentPage=1;
      showOrdersTab();
      render();

      $('ordersPanel').scrollIntoView({
        behavior:'smooth',
        block:'start'
      });
    };
  });

  $('marketUpdated').textContent=
    `오늘 기준 · ${new Date().toLocaleTimeString('ko-KR',{
      hour:'2-digit',
      minute:'2-digit'
    })}`;
}
function filteredOrders(){
  const q=$('searchInput').value.trim().toLowerCase();
  const market=$('marketFilter').value;
  const read=$('readFilter').value;
  const workflow=$('workflowFilter').value;

  return uniqueLatestOrders().filter(o=>{
    const status=statusKey(o);

    const cutoff=new Date();
    cutoff.setDate(cutoff.getDate()-31);

    const cutoffKey=new Intl.DateTimeFormat(
      'sv-SE',
      {timeZone:'Asia/Seoul'}
    ).format(cutoff);

    const day=orderDay(o);

    const visibleByDefault=Boolean(
      day &&
      day>=cutoffKey &&
      day<=todayKey()
    );

    const visibleBySelectedClaim=
      activeStatus &&
      ['cancel','return','exchange','inquiry'].includes(activeStatus) &&
      status===activeStatus &&
      activePeriodMatch(o,activeStatus);

    const visibleBySelectedWorkStatus=
      activeStatus &&
      ['new','shipping_wait'].includes(activeStatus) &&
      status===activeStatus;

    const visible=
      activeStatus
        ? (
            visibleBySelectedClaim ||
            visibleBySelectedWorkStatus
          )
        : visibleByDefault;

    if(!visible) return false;

    const hit=!q||[
      o.product,
      o.orderNo,
      o.buyer,
      o.phone,
      o.invoiceNumber,
      o.workflowNote
    ].some(v=>
      String(v||'').toLowerCase().includes(q)
    );

    const workflowHit=
      !workflow ||
      (workflow==='pending'&&!isProcessed(o)) ||
      (workflow==='important'&&isImportant(o)) ||
      (workflow==='processed'&&isProcessed(o));

    return hit &&
      (!market||o.market===market) &&
      (!activeMarket||o.market===activeMarket) &&
      (!read||(read==='unread'?isUnread(o):!isUnread(o))) &&
      workflowHit;
  }).sort((a,b)=>{
    if(statusKey(a)!==statusKey(b)){
      const rank={new:1,shipping_wait:2};
      return (rank[statusKey(a)]||9)-(rank[statusKey(b)]||9);
    }

    if(isImportant(a)!==isImportant(b)){
      return isImportant(a)?-1:1;
    }

    if(isProcessed(a)!==isProcessed(b)){
      return isProcessed(a)?1:-1;
    }

    return timestampValue(b)-timestampValue(a);
  });
}

function renderOrders(){
  const all=filteredOrders();
  const pages=Math.max(1,Math.ceil(all.length/PAGE_SIZE));
  currentPage=Math.min(Math.max(currentPage,1),pages);
  const list=all.slice((currentPage-1)*PAGE_SIZE,currentPage*PAGE_SIZE);

  $('orderResultCount').textContent=all.length+'건';

  const labels=[];
  if(activeMarket) labels.push(activeMarket);
  if(activeStatus) labels.push(Object.fromEntries(STATUS_ITEMS)[activeStatus]);
  if($('workflowFilter').value==='pending') labels.push('미처리');
  if($('workflowFilter').value==='important') labels.push('중요');
  if($('workflowFilter').value==='processed') labels.push('처리 완료');

  $('filterBanner').classList.toggle('active',labels.length>0);
  $('filterText').textContent=labels.length?labels.join(' · ')+'만 표시 중':'';

  $('orderBody').innerHTML=list.length?list.map(o=>`
    <tr class="order-row ${isImportant(o)?'important':''} ${isProcessed(o)?'processed':''}" data-id="${escapeHtml(o.id)}">
      <td data-label="상태"><span class="status-pill">${escapeHtml(labelFor(o))}</span></td>
      <td data-label="일시">${escapeHtml(dateValue(o).replace('T',' ').slice(0,16))}</td>
      <td data-label="쇼핑몰">${escapeHtml(o.market||'')}</td>
      <td data-label="주문번호">${escapeHtml(o.orderNo||'')}</td>
      <td data-label="상품명" class="product-cell">${isImportant(o)?'⭐ ':''}${escapeHtml(o.product||'상품명 없음')}${o.workflowNote?`<small style="display:block;color:var(--muted);margin-top:4px">${escapeHtml(o.workflowNote)}</small>`:''}</td>
      <td data-label="수량">${Number(o.qty||0)}</td>
      <td data-label="구매자">${escapeHtml(o.buyer||'')}</td>
      <td data-label="금액">${fmt(o.amount)}</td>
      <td data-label="관리">
        <div class="workflow-btns">
          <button class="mini-btn star-btn ${isImportant(o)?'starred':''}" data-id="${escapeHtml(o.id)}">${isImportant(o)?'★':'☆'}</button>
          <button class="mini-btn process-btn ${isProcessed(o)?'done':''}" data-id="${escapeHtml(o.id)}">${isProcessed(o)?'완료':'처리'}</button>
          <button class="mini-btn read-btn" data-id="${escapeHtml(o.id)}">${isUnread(o)?'확인':'미확인'}</button>
        </div>
      </td>
    </tr>`).join(''):`<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:28px">해당 주문이 없습니다.</td></tr>`;

  $('orderBody').querySelectorAll('.read-btn').forEach(btn=>btn.onclick=e=>{
    e.stopPropagation();
    toggleRead(btn.dataset.id);
  });

  $('orderBody').querySelectorAll('.star-btn').forEach(btn=>btn.onclick=e=>{
    e.stopPropagation();
    toggleImportant(btn.dataset.id);
  });

  $('orderBody').querySelectorAll('.process-btn').forEach(btn=>btn.onclick=e=>{
    e.stopPropagation();
    toggleProcessed(btn.dataset.id);
  });

  $('orderBody').querySelectorAll('.order-row').forEach(row=>row.onclick=e=>{
    if(!e.target.closest('button')) openDetail(row.dataset.id);
  });

  $('pageInfo').textContent=`${currentPage} / ${pages}`;
  $('prevPageBtn').disabled=currentPage<=1;
  $('nextPageBtn').disabled=currentPage>=pages;
}
function renderStats(){
  const period=$('statsPeriod').value;
  const cut=period==='all'
    ?0
    :Date.now()-Number(period)*86400000;

  const list=salesUniqueOrders().filter(o=>{
    const t=new Date(dateValue(o)).getTime();
    return !cut||t>=cut;
  });

  const monthlyTotals=settlementMonthlyTotals();
  const includesMonth=
    period==='all' ||
    Number(period)>=31;

  $('statOrders').textContent=
    (includesMonth&&monthlyTotals.corrected
      ?monthlyTotals.count
      :list.length
    )+'건';

  $('statQty').textContent=
    list.reduce((s,o)=>s+Number(o.qty||0),0)+'개';

  $('statSales').textContent=fmt(
    includesMonth&&monthlyTotals.corrected
      ?monthlyTotals.sales
      :list.reduce((s,o)=>s+Number(o.amount||0),0)
  );

  const map={};
  list.forEach(o=>{
    const n=o.product||'상품명 없음';
    if(!map[n])map[n]={count:0,qty:0,sales:0};
    map[n].count++;
    map[n].qty+=Number(o.qty||0);
    map[n].sales+=Number(o.amount||0);
  });

  $('productRank').innerHTML=Object.entries(map)
    .sort((a,b)=>b[1].count-a[1].count)
    .slice(0,10)
    .map(([name,v],i)=>`
      <div class="rank-item">
        <strong>${i+1}</strong>
        <div>
          <strong>${escapeHtml(name)}</strong>
          <small>주문 ${v.count}건 · ${v.qty}개</small>
        </div>
        <strong>${fmt(v.sales)}</strong>
      </div>
    `).join('');
}

function renderOperations(){
  const today=todayKey();
  const todayOrders=uniqueLatestOrders().filter(o=>orderDay(o)===today);
  $('dispatchDueCount').textContent=todayOrders.filter(o=>['new','shipping_wait'].includes(statusKey(o))&&!isProcessed(o)).length;
  $('importantCount').textContent=uniqueLatestOrders().filter(isImportant).length;
  $('processedCount').textContent=todayOrders.filter(isProcessed).length;
}

function renderTodayAnalytics(){
  const today=todayKey();
  const list=uniqueLatestOrders().filter(o=>orderDay(o)===today&&isSalesOrder(o));

  const hourly=Array.from({length:24},()=>0);
  list.forEach(o=>{
    const d=new Date(dateValue(o));
    if(!Number.isNaN(d.getTime())){
      const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',hour12:false}).format(d));
      if(hour>=0&&hour<24) hourly[hour]++;
    }
  });

  const maxHour=Math.max(1,...hourly);
  $('hourChart').innerHTML=hourly.map((count,hour)=>`
    <div class="hour-col" title="${hour}시 ${count}건">
      <span class="hour-value">${count||''}</span>
      <div class="hour-bar" style="height:${Math.max(2,Math.round(count/maxHour*100))}%"></div>
      <span class="hour-label">${hour%3===0?hour+'시':''}</span>
    </div>`).join('');

  const marketMap={};
  list.forEach(o=>{
    const key=o.market||'기타';
    marketMap[key]=(marketMap[key]||0)+Number(o.amount||0);
  });

  const totalSales=Object.values(marketMap).reduce((s,v)=>s+v,0)||1;
  $('marketShare').innerHTML=Object.entries(marketMap)
    .sort((a,b)=>b[1]-a[1])
    .map(([market,sales])=>`
      <div class="share-row">
        <strong>${escapeHtml(market)}</strong>
        <div class="share-track"><div class="share-fill" style="width:${Math.max(2,sales/totalSales*100)}%"></div></div>
        <span class="share-value">${Math.round(sales/totalSales*100)}%</span>
      </div>`).join('')||'<span class="subtle">오늘 매출이 없습니다.</span>';

  const productMap={};
  list.forEach(o=>{
    const name=o.product||'상품명 없음';
    if(!productMap[name]) productMap[name]={orders:0,qty:0,sales:0};
    productMap[name].orders++;
    productMap[name].qty+=Number(o.qty||0);
    productMap[name].sales+=Number(o.amount||0);
  });

  $('todayTopProducts').innerHTML=Object.entries(productMap)
    .sort((a,b)=>b[1].orders-a[1].orders||b[1].sales-a[1].sales)
    .slice(0,10)
    .map(([name,v],index)=>`
      <div class="top-row">
        <span class="top-no">${index+1}</span>
        <div><strong>${escapeHtml(name)}</strong><small>${v.orders}건 · ${v.qty}개</small></div>
        <strong>${fmt(v.sales)}</strong>
      </div>`).join('')||'<span class="subtle">오늘 판매 상품이 없습니다.</span>';
}

async function toggleImportant(id){
  const o=orders.find(x=>x.id===id);
  if(!o)return;
  await db.collection('orders').doc(id).set({
    workflowImportant:!isImportant(o),
    workflowUpdatedAt:firebase.firestore.FieldValue.serverTimestamp()
  },{merge:true});
}

async function toggleProcessed(id){
  const o=orders.find(x=>x.id===id);
  if(!o)return;
  await db.collection('orders').doc(id).set({
    workflowProcessed:!isProcessed(o),
    workflowProcessedAt:!isProcessed(o)?firebase.firestore.FieldValue.serverTimestamp():null,
    workflowUpdatedAt:firebase.firestore.FieldValue.serverTimestamp()
  },{merge:true});
}

async function saveCurrentNote(){
  if(!currentDetail)return;
  await db.collection('orders').doc(currentDetail.id).set({
    workflowNote:$('detailNote').value.trim(),
    workflowUpdatedAt:firebase.firestore.FieldValue.serverTimestamp()
  },{merge:true});
  toast('메모 저장 완료');
}

function render(){saveCloudCache();renderMetrics();renderStatus();renderMarkets();renderOrders();renderStats();renderIntegrations();renderOperations();renderTodayAnalytics()}

async function toggleRead(id){const o=orders.find(x=>x.id===id);if(!o)return;await db.collection('orders').doc(id).set({readStatus:isUnread(o)?'read':'unread',updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true})}
function showOrdersTab(){$('ordersTab').classList.add('active');$('statsTab').classList.remove('active');$('ordersPanel').classList.add('active');$('statsPanel').classList.remove('active')}
function showStatsTab(){$('statsTab').classList.add('active');$('ordersTab').classList.remove('active');$('statsPanel').classList.add('active');$('ordersPanel').classList.remove('active')}
function copyText(text,label){if(!text)return toast(label+' 정보가 없습니다.');navigator.clipboard.writeText(String(text)).then(()=>toast(label+' 복사 완료')).catch(()=>toast(label+' 복사 실패'))}
function openDetail(id){
  const o=orders.find(x=>x.id===id);
  if(!o)return;

  currentDetail=o;

  const fields=[
    ['상태',labelFor(o)],['쇼핑몰',o.market||''],['주문번호',o.orderNo||''],
    ['상품명',o.product||''],['옵션',o.option||''],['수량',Number(o.qty||0)],
    ['구매자',o.buyer||''],['연락처',o.phone||''],['주소',o.address||''],
    ['배송메모',o.deliveryMemo||''],['금액',fmt(o.amount)],
    ['주문시간',dateValue(o).replace('T',' ').slice(0,19)],
    ['택배사',o.deliveryCompanyName||''],['운송장번호',o.invoiceNumber||''],
    ['사유',o.reason||''],['상세사유',o.reasonDetail||'']
  ];

  $('detailGrid').innerHTML=fields.map(([k,v])=>`<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
  $('detailNote').value=o.workflowNote||'';
  $('detailStarBtn').textContent=isImportant(o)?'★ 중요 주문 해제':'☆ 중요 주문';
  $('detailStarBtn').classList.toggle('primary',isImportant(o));
  $('detailProcessedBtn').textContent=isProcessed(o)?'처리 완료 해제':'처리 완료';
  $('detailProcessedBtn').classList.toggle('primary',isProcessed(o));
  $('detailDialog').showModal();
}

async function requestCollect(){
  if(!db||!currentUser){
    toast('클라우드 자동 연결을 다시 시도합니다.');
    initCloud(true);
    return;
  }

  const status=$('collectStatus');
  status.textContent='이번달 정밀 동기화 요청 중';

  try{
    await db.collection('system')
      .doc('commands')
      .collection('requests')
      .doc('coupang')
      .set({
        requestId:
          `${currentUser.uid}-${Date.now()}`,
        market:'coupang',
        action:'reconcile',
        reason:'manual-month-reconcile',
        requestedBy:currentUser.uid,
        requestedAt:
          firebase.firestore.FieldValue.serverTimestamp(),
        status:'requested',
        updatedAt:
          firebase.firestore.FieldValue.serverTimestamp()
      },{merge:true});

    status.textContent='이번달 전체 마켓 동기화 요청 완료';
  }catch(error){
    status.textContent=
      '요청 실패 · '+readableCloudError(error);
    initCloud(true);
  }
}
function watchCollect(){if(collectUnsub)collectUnsub();collectUnsub=db.collection('system').doc('commands').collection('requests').doc('coupang').onSnapshot(doc=>{if(!doc.exists)return;const d=doc.data()||{};$('collectStatus').textContent=d.status==='success'?'수집 완료':d.status==='error'?'수집 오류 · PC 확인':d.status==='running'||d.status==='requested'?'수집 중':'자동 확인 중'})}


const ORDER_CACHE_KEY='alldaypick-orders-cache-v58';
const INTEGRATION_CACHE_KEY='alldaypick-integrations-cache-v58';

function restoreCloudCache(){
  try{
    const cachedOrders=JSON.parse(
      localStorage.getItem(ORDER_CACHE_KEY)||'[]'
    );

    if(Array.isArray(cachedOrders)&&cachedOrders.length){
      orders=cachedOrders;
    }
  }catch{}

  try{
    const cachedIntegrations=JSON.parse(
      localStorage.getItem(INTEGRATION_CACHE_KEY)||'{}'
    );

    if(
      cachedIntegrations &&
      typeof cachedIntegrations==='object'
    ){
      integrations=cachedIntegrations;
    }
  }catch{}
}

function saveCloudCache(){
  try{
    localStorage.setItem(
      ORDER_CACHE_KEY,
      JSON.stringify(
        orders.map(order=>{
          const copy={...order};

          for(const key of [
            'createdAt',
            'updatedAt',
            'workflowUpdatedAt',
            'workflowProcessedAt'
          ]){
            if(copy[key]?.toDate){
              copy[key]=copy[key].toDate().toISOString();
            }
          }

          return copy;
        })
      )
    );
  }catch{}

  try{
    localStorage.setItem(
      INTEGRATION_CACHE_KEY,
      JSON.stringify(integrations||{})
    );
  }catch{}
}


let cloudRetryTimer=null;
let integrationUnsubscribe=null;
let cloudStarting=false;

function cloudMessage(text,ok=false){
  const status=$('cloudStatus');
  const dot=$('cloudDot');

  if(status){
    status.textContent=text;
  }

  if(dot){
    dot.classList.toggle('ok',Boolean(ok));
  }
}

function readableCloudError(error){
  const code=String(error?.code||'');
  const message=String(error?.message||error||'');

  if(code.includes('operation-not-allowed')){
    return 'Firebase 익명 로그인이 꺼져 있습니다';
  }

  if(code.includes('permission-denied')){
    return 'Firestore 읽기 권한이 거부되었습니다';
  }

  if(code.includes('unauthenticated')){
    return 'Firebase 로그인 인증이 필요합니다';
  }

  if(code.includes('network-request-failed')){
    return '인터넷 연결 또는 Firebase 서버 연결 오류';
  }

  if(code.includes('unavailable')){
    return 'Firebase 서버에 일시적으로 연결할 수 없습니다';
  }

  return message||'알 수 없는 오류';
}


let agentUnsubscribe=null;

function watchAgentHeartbeat(){
  if(agentUnsubscribe){
    agentUnsubscribe();
  }

  const showFallback=()=>{
    const lastRuns=Object.values(integrations||{})
      .map(info=>info?.lastRun)
      .filter(Boolean)
      .map(value=>new Date(value).getTime())
      .filter(Number.isFinite);

    const latest=lastRuns.length
      ?Math.max(...lastRuns)
      :0;

    const age=latest
      ?Date.now()-latest
      :Infinity;

    const online=
      Number.isFinite(age) &&
      age<15*60*1000;

    const indicator=$('agentStatus');

    if(indicator){
      indicator.textContent=online
        ?`PC 수집기 정상 · 마켓 수집 ${relativeTime(
            new Date(latest).toISOString()
          )}`
        :'PC 수집기 상태 확인 중';

      indicator.classList.toggle('ok',online);
      indicator.classList.toggle('error',false);
    }
  };

  showFallback();

  agentUnsubscribe=db.collection('system')
    .doc('agent')
    .onSnapshot(
      snapshot=>{
        const data=snapshot.exists
          ?snapshot.data()
          :{};

        const raw=
          data.lastSeenIso||
          data.lastSeen
            ?.toDate?.()
            ?.toISOString?.()||
          '';

        const age=raw
          ?Date.now()-new Date(raw).getTime()
          :Infinity;

        const online=
          Number.isFinite(age) &&
          age<3*60*1000;

        const indicator=$('agentStatus');

        if(indicator){
          indicator.textContent=online
            ?`PC 수집기 정상 · ${relativeTime(raw)}`
            :'PC 수집기 응답 없음';

          indicator.classList.toggle('ok',online);
          indicator.classList.toggle('error',!online);
        }

        const telegram=$('telegramState');

        if(telegram){
          if(data.telegramLastError){
            telegram.textContent=
              '텔레그램 오류 · '+
              String(data.telegramLastError).slice(0,35);
          }else{
            telegram.textContent=data.telegramConfigured
              ?'텔레그램 연결됨'
              :'텔레그램 설정 확인';
          }

          telegram.classList.toggle(
            'ok',
            Boolean(
              data.telegramConfigured &&
              !data.telegramLastError
            )
          );
        }
      },
      error=>{
        console.warn(
          'Agent heartbeat read failed:',
          error
        );

        showFallback();
      }
    );
}

function stopCloudListeners(){
  if(unsubscribeOrders){
    unsubscribeOrders();
    unsubscribeOrders=null;
  }

  if(integrationUnsubscribe){
    integrationUnsubscribe();
    integrationUnsubscribe=null;
  }

  if(collectUnsub){
    collectUnsub();
    collectUnsub=null;
  }

  if(agentUnsubscribe){
    agentUnsubscribe();
    agentUnsubscribe=null;
  }
}

function retryCloud(delay=5000){
  clearTimeout(cloudRetryTimer);
  cloudRetryTimer=setTimeout(initCloud,delay);
}

function startCloudListeners(){
  stopCloudListeners();

  restoreCloudCache();
  render();

  cloudMessage(
    orders.length
      ?'클라우드 자동 연결 중 · 저장된 데이터 표시'
      :'클라우드 자동 연결 중',
    false
  );

  unsubscribeOrders=db.collection('orders').onSnapshot(
    {includeMetadataChanges:true},
    snapshot=>{
      orders=snapshot.docs.map(doc=>({
        id:doc.id,
        ...doc.data()
      }));

      saveCloudCache();

      cloudMessage(
        snapshot.metadata.fromCache
          ?'클라우드 연결됨 · 캐시 동기화 중'
          :'클라우드 연결됨',
        true
      );

      render();
    },
    error=>{
      console.error('Order listener error:',error);

      cloudMessage(
        orders.length
          ?'클라우드 재연결 중 · 저장된 데이터 표시'
          :'주문 연결 오류 · '+readableCloudError(error),
        false
      );

      retryCloud(3000);
    }
  );

  integrationUnsubscribe=db.collection('system')
    .doc('integrations')
    .onSnapshot(
      {includeMetadataChanges:true},
      snapshot=>{
        integrations=snapshot.exists
          ?snapshot.data()
          :{};

        saveCloudCache();
        renderIntegrations();
        renderMarkets();
      },
      error=>{
        console.error('Integration listener error:',error);

        renderIntegrations();
        renderMarkets();
        retryCloud(3000);
      }
    );

  watchCollect();
  watchAgentHeartbeat();
}

async function initCloud(force=false){
  if(cloudStarting&&!force){
    return;
  }

  cloudStarting=true;
  clearTimeout(cloudRetryTimer);

  restoreCloudCache();
  render();

  cloudMessage(
    orders.length
      ?'클라우드 자동 연결 중 · 저장된 데이터 표시'
      :'Firebase 자동 연결 중',
    false
  );

  try{
    await window.firebaseReady;

    if(!window.firebase){
      throw new Error('Firebase SDK를 불러오지 못했습니다.');
    }

    if(!firebase.apps.length){
      firebase.initializeApp(firebaseConfig);
    }

    auth=firebase.auth();
    db=firebase.firestore();

    try{
      db.settings({
        ignoreUndefinedProperties:true
      });
    }catch{}

    try{
      await db.enablePersistence({
        synchronizeTabs:true
      });
    }catch{}

    try{
      await db.enableNetwork();
    }catch{}

    let user=auth.currentUser;

    if(!user){
      const credential=await Promise.race([
        auth.signInAnonymously(),
        new Promise((_,reject)=>
          setTimeout(
            ()=>reject(
              new Error('Firebase 로그인 시간 초과')
            ),
            15000
          )
        )
      ]);

      user=credential?.user||auth.currentUser;
    }

    if(!user){
      throw new Error(
        'Firebase 사용자 인증을 확인할 수 없습니다.'
      );
    }

    currentUser=user;
    startCloudListeners();
  }catch(error){
    console.error('Cloud startup error:',error);

    cloudMessage(
      orders.length
        ?'클라우드 재연결 중 · 저장된 데이터 표시'
        :'클라우드 연결 실패 · '+
          readableCloudError(error),
      false
    );

    retryCloud(3000);
  }finally{
    cloudStarting=false;
  }
}



async function requestTelegramTest(){
  const button=$('telegramTestBtn');
  const status=$('telegramTestStatus');

  if(!db||!currentUser){
    status.textContent='클라우드 연결 후 다시 눌러주세요.';
    initCloud();
    return;
  }

  button.disabled=true;
  button.textContent='전송 중…';
  status.textContent='텔레그램 테스트를 요청했습니다.';

  const requestId=`telegram-test-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const ref=db.collection('system').doc('commands').collection('requests').doc('coupang');

  try{
    await ref.set({
      status:'requested',
      action:'telegram_test',
      requestId,
      requestedBy:currentUser.uid,
      requestedAt:firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt:firebase.firestore.FieldValue.serverTimestamp()
    },{merge:true});

    let checks=0;
    const timer=setInterval(async()=>{
      checks+=1;

      try{
        const snapshot=await ref.get();
        const data=snapshot.data()||{};

        if(data.requestId!==requestId){
          return;
        }

        if(data.status==='test_success'){
          clearInterval(timer);
          status.textContent='테스트 성공 · 텔레그램을 확인하세요.';
          button.disabled=false;
          button.textContent='텔레그램 테스트';
          return;
        }

        if(data.status==='test_error'){
          clearInterval(timer);
          status.textContent=`테스트 실패 · ${data.error||'토큰과 Chat ID를 확인하세요.'}`;
          button.disabled=false;
          button.textContent='텔레그램 테스트';
          return;
        }
      }catch{}

      if(checks>=20){
        clearInterval(timer);
        status.textContent='응답 없음 · PC 수집기가 실행 중인지 확인하세요.';
        button.disabled=false;
        button.textContent='텔레그램 테스트';
      }
    },1000);
  }catch(error){
    status.textContent=`요청 실패 · ${readableCloudError(error)}`;
    button.disabled=false;
    button.textContent='텔레그램 테스트';
  }
}


$('ordersTab').onclick=showOrdersTab;$('statsTab').onclick=()=>{showStatsTab();renderStats()};$('clearFilterBtn').onclick=()=>{activeStatus='';activeMarket='';$('marketFilter').value='';$('workflowFilter').value='';currentPage=1;render()};$('searchInput').oninput=()=>{currentPage=1;renderOrders()};$('marketFilter').onchange=()=>{currentPage=1;renderOrders()};$('readFilter').onchange=()=>{currentPage=1;renderOrders()};$('workflowFilter').onchange=()=>{currentPage=1;renderOrders()};$('statsPeriod').onchange=renderStats;$('prevPageBtn').onclick=()=>{if(currentPage>1){currentPage--;renderOrders()}};$('nextPageBtn').onclick=()=>{currentPage++;renderOrders()};$('collectNowBtn').onclick=requestCollect;$('telegramTestBtn').onclick=requestTelegramTest;
$('addBtn').onclick=()=>$('orderDialog').showModal();$('cancelAddBtn').onclick=()=>$('orderDialog').close();$('orderForm').onsubmit=async e=>{e.preventDefault();const id=crypto.randomUUID?.()||String(Date.now());await db.collection('orders').doc(id).set({id,eventType:$('fEvent').value,market:$('fMarket').value,orderNo:$('fOrderNo').value.trim(),product:$('fProduct').value.trim(),qty:Number($('fQty').value),buyer:$('fBuyer').value.trim(),amount:Number($('fAmount').value),datetime:new Date().toISOString(),status:'new',readStatus:'unread',createdAt:firebase.firestore.FieldValue.serverTimestamp()});$('orderDialog').close();$('orderForm').reset()};
$('closeDetailBtn').onclick=()=>$('detailDialog').close();$('copyOrderNoBtn').onclick=()=>copyText(currentDetail?.orderNo,'주문번호');$('copyBuyerBtn').onclick=()=>copyText(currentDetail?.buyer,'구매자');$('copyPhoneBtn').onclick=()=>copyText(currentDetail?.phone,'연락처');$('copyProductBtn').onclick=()=>copyText(currentDetail?.product,'상품명');$('copyInvoiceBtn').onclick=()=>copyText(currentDetail?.invoiceNumber,'운송장번호');
$('detailStarBtn').onclick=async()=>{if(!currentDetail)return;await toggleImportant(currentDetail.id);$('detailDialog').close()};
$('detailProcessedBtn').onclick=async()=>{if(!currentDetail)return;await toggleProcessed(currentDetail.id);$('detailDialog').close()};
$('saveNoteBtn').onclick=saveCurrentNote;
if('serviceWorker' in navigator){
  navigator.serviceWorker.getRegistrations()
    .then(regs=>Promise.all(regs.map(reg=>reg.update().catch(()=>{}))))
    .finally(()=>navigator.serviceWorker.register('./sw.js?v=clean-v1.0.1',{updateViaCache:'none'}))
    .catch(console.warn);
}
render();window.addEventListener('online',()=>{
  cloudMessage('인터넷 복구 · 다시 연결 중',false);
  initCloud();
});

window.addEventListener('offline',()=>{
  cloudMessage('인터넷 연결 없음 · 저장된 화면 표시',false);
});

$('cloudStatus').onclick=()=>{
  cloudMessage('수동 재연결 중',false);
  initCloud();
};


restoreCloudCache();
render();

window.addEventListener('online',()=>{
  initCloud(true);
});

document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){
    initCloud(true);
  }
});

window.addEventListener('pageshow',()=>{
  initCloud(true);
});

initCloud();

function applyMobileLabels(){
  if(window.innerWidth>720){
    return;
  }

  document.querySelectorAll('th').forEach(th=>{
    const map={
      '오늘 주문':'주문',
      '오늘 매출':'매출',
      '발송대기':'대기',
      '주문취소':'취소',
      '반품요청':'반품',
      '교환요청':'교환',
      '문의사항':'문의'
    };

    const text=th.textContent.trim();

    if(map[text]){
      th.textContent=map[text];
    }
  });
}

window.addEventListener('resize',applyMobileLabels);
setTimeout(applyMobileLabels,300);
setTimeout(applyMobileLabels,1200);

function showVersionInfo(){
  alert(
    `${APP_VERSION}\n`+
    `빌드 날짜: ${BUILD_DATE}\n\n`+
    `• 중복 패치 코드 제거\n`+
    `• Firebase 고정 로딩\n`+
    `• 모바일 대시보드\n`+
    `• 텔레그램 전용 알림\n`+
    `• PC 수집기 연동`
  );
}

const versionBadge=document.getElementById('versionBadge');
if(versionBadge){
  versionBadge.onclick=showVersionInfo;
}

window.addEventListener('pageshow',()=>{
  if(typeof initCloud==='function') initCloud(true);
});

window.addEventListener('online',()=>{
  if(typeof initCloud==='function') initCloud(true);
});

document.addEventListener('visibilitychange',()=>{
  if(
    document.visibilityState==='visible' &&
    typeof initCloud==='function'
  ){
    initCloud(true);
  }
});

window.addEventListener('error',event=>{
  const status=document.getElementById('cloudStatus');
  if(status){
    status.textContent=
      `화면 오류 · ${String(event.message||'알 수 없는 오류').slice(0,100)}`;
  }
  console.error('CLEAN v1 화면 오류:',event.error||event.message);
});
