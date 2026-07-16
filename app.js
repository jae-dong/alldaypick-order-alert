const APP_VERSION='FINAL v4.2.0';
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




function isOrderEvent(order){
  return String(order?.eventType||'order').toLowerCase()==='order';
}

function isClaimEvent(order){
  return ['cancel','return','exchange','inquiry']
    .includes(
      String(order?.eventType||'').toLowerCase()
    );
}

function orderGroupKey(order){
  return [
    normalizedText(order?.market||order?.source),
    normalizedText(
      order?.orderNo||
      order?.orderId||
      order?.shipmentBoxId||
      order?.deliveryNo||
      order?.id
    )
  ].join('|');
}

function latestOrderLines(){
  return uniqueLatestOrders(
    orders.filter(isOrderEvent)
  ).filter(marketIncludedOrder);
}

function latestClaimDocuments(){
  const claims=orders.filter(isClaimEvent);
  const groups=new Map();

  claims.forEach(claim=>{
    const key=[
      orderGroupKey(claim),
      statusKey(claim),
      normalizedText(
        claim.orderProductSequence||
        claim.orderItemId||
        claim.vendorItemId||
        claim.product||
        claim.id
      )
    ].join('|');

    const current=groups.get(key);

    if(
      !current ||
      timestampValue(claim)>timestampValue(current)
    ){
      groups.set(key,claim);
    }
  });

  return [...groups.values()]
    .filter(marketIncludedOrder);
}

function terminalStatusText(order){
  return [
    order?.sourceStatus,
    order?.status,
    order?.statusLabel,
    order?.claimStatus,
    order?.processingStatus,
    order?.resultStatus,
    order?.receiptStatus,
    order?.exchangeStatus
  ]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();
}

function isCompletedClaim(order){
  if(isProcessed(order)){
    return true;
  }

  const text=terminalStatusText(order);

  const completedWords=[
    'COMPLETE','COMPLETED','CLOSED',
    'FINISH','FINISHED','DONE',
    'WITHDRAW','WITHDRAWN',
    'REJECT','REJECTED',
    'CANCEL_COMPLETE',
    'RETURN_COMPLETE',
    'EXCHANGE_COMPLETE',
    'CANCELLED_COMPLETE',
    '처리완료','취소완료','반품완료',
    '교환완료','답변완료',
    '철회','거부','종결'
  ];

  return completedWords.some(word=>
    text.includes(word)
  );
}

function isActiveOrderWork(order){
  if(!isOrderEvent(order)||isProcessed(order)){
    return false;
  }

  return ['new','shipping_wait']
    .includes(statusKey(order));
}

function isActiveClaimWork(order){
  if(!isClaimEvent(order)){
    return false;
  }

  return !isCompletedClaim(order);
}

function activeOrderLines(){
  return latestOrderLines()
    .filter(isActiveOrderWork);
}

function activeClaims(){
  return latestClaimDocuments()
    .filter(isActiveClaimWork);
}

function orderAmountValue(order){
  const candidates=[
    order?.orderTotalAmount,
    order?.totalAmount,
    order?.paymentAmount,
    order?.salePrice,
    order?.amount
  ];

  for(const value of candidates){
    const number=Number(value);

    if(Number.isFinite(number)&&number>=0){
      return number;
    }
  }

  return 0;
}

function groupOrderLines(lines){
  const groups=new Map();

  lines.forEach(line=>{
    const key=orderGroupKey(line);

    if(!groups.has(key)){
      groups.set(key,{
        key,
        market:line.market||line.source||'기타',
        orderNo:line.orderNo||line.orderId||'',
        datetime:dateValue(line),
        day:orderDay(line),
        lines:[],
        amount:0,
        qty:0
      });
    }

    const group=groups.get(key);
    group.lines.push(line);
    group.qty+=Number(line.qty||1);

    const explicitTotal=Number(
      line.orderTotalAmount||
      line.totalAmount||
      line.paymentAmount
    );

    if(Number.isFinite(explicitTotal)&&explicitTotal>0){
      group.explicitTotal=Math.max(
        Number(group.explicitTotal||0),
        explicitTotal
      );
    }else{
      group.amount+=orderAmountValue(line);
    }

    if(
      new Date(dateValue(line)).getTime() <
      new Date(group.datetime).getTime()
    ){
      group.datetime=dateValue(line);
      group.day=orderDay(line);
    }
  });

  return [...groups.values()].map(group=>({
    ...group,
    amount:
      Number(group.explicitTotal||0)||
      Number(group.amount||0)
  }));
}

function activeOrderGroups(){
  return groupOrderLines(activeOrderLines());
}

function financialOrderGroups(){
  const validLines=latestOrderLines().filter(order=>{
    const key=statusKey(order);

    return ![
      'cancel',
      'return',
      'exchange',
      'inquiry'
    ].includes(key);
  });

  return groupOrderLines(validLines);
}

function todayFinancialGroups(){
  const today=todayKey();

  return financialOrderGroups().filter(group=>
    group.day===today
  );
}

function monthFinancialGroups(){
  const month=monthKey();

  return financialOrderGroups().filter(group=>
    String(group.day||'').slice(0,7)===month
  );
}


function unresolvedRows(){
  return [
    ...activeOrderLines(),
    ...activeClaims()
  ];
}

function unresolvedRowsForMarket(market=''){
  return unresolvedRows().filter(order=>
    !market || order.market===market
  );
}

function statsGroupsForPeriod(period){
  const all=engineNormalGroups();

  if(period==='all') return all;

  const days=Math.max(1,Number(period)||7);
  const cutoff=Date.now()-days*86400000;

  return all.filter(group=>group.date?.getTime?.()>=cutoff);
}




function canonicalOrderDate(order){
  const candidates=[
    order?.orderDate,
    order?.orderAt,
    order?.orderedAt,
    order?.paymentDate,
    order?.paymentAt,
    order?.datetime,
    order?.createdAt
  ];

  for(const value of candidates){
    if(!value) continue;

    const date=value?.toDate
      ?value.toDate()
      :new Date(value);

    if(!Number.isNaN(date.getTime())){
      return date;
    }
  }

  return new Date(0);
}

function canonicalOrderDay(order){
  const date=canonicalOrderDate(order);

  if(!date.getTime()){
    return '';
  }

  return new Intl.DateTimeFormat(
    'sv-SE',
    {
      timeZone:'Asia/Seoul',
      year:'numeric',
      month:'2-digit',
      day:'2-digit'
    }
  ).format(date);
}

function canonicalOrderKey(order){
  return [
    normalizedText(order?.market||order?.source),
    normalizedText(
      order?.orderNo||
      order?.orderId||
      order?.shipmentBoxId||
      order?.deliveryNo||
      order?.id
    )
  ].join('|');
}

function canonicalOrderAmount(order){
  const candidates=[
    order?.orderTotalAmount,
    order?.totalAmount,
    order?.paymentAmount,
    order?.salePrice,
    order?.amount
  ];

  for(const value of candidates){
    const number=Number(value);

    if(Number.isFinite(number)&&number>=0){
      return number;
    }
  }

  return 0;
}

function canonicalNormalOrders(){
  const latest=latestOrderLines();

  return latest.filter(order=>{
    const key=statusKey(order);

    return (
      isOrderEvent(order) &&
      !['cancel','return','exchange','inquiry'].includes(key)
    );
  });
}

function canonicalOrderGroups(){
  const groups=new Map();

  canonicalNormalOrders().forEach(order=>{
    const key=canonicalOrderKey(order);

    if(!groups.has(key)){
      groups.set(key,{
        key,
        market:order.market||order.source||'기타',
        orderNo:order.orderNo||order.orderId||'',
        date:canonicalOrderDate(order),
        day:canonicalOrderDay(order),
        lines:[],
        amount:0,
        qty:0,
        explicitTotal:0
      });
    }

    const group=groups.get(key);
    group.lines.push(order);
    group.qty+=Number(order.qty||1);

    const explicit=Number(
      order.orderTotalAmount||
      order.totalAmount||
      order.paymentAmount
    );

    if(Number.isFinite(explicit)&&explicit>0){
      group.explicitTotal=Math.max(
        group.explicitTotal,
        explicit
      );
    }else{
      group.amount+=canonicalOrderAmount(order);
    }

    const currentDate=canonicalOrderDate(order);

    if(
      currentDate.getTime() &&
      (
        !group.date?.getTime?.() ||
        currentDate.getTime()<group.date.getTime()
      )
    ){
      group.date=currentDate;
      group.day=canonicalOrderDay(order);
    }
  });

  return [...groups.values()].map(group=>({
    ...group,
    amount:
      Number(group.explicitTotal||0)||
      Number(group.amount||0)
  }));
}

function canonicalTodayGroups(){
  const today=todayKey();

  return canonicalOrderGroups().filter(group=>
    group.day===today
  );
}

function canonicalMonthGroups(){
  const month=monthKey();

  return canonicalOrderGroups().filter(group=>
    String(group.day||'').slice(0,7)===month
  );
}

function canonicalUnresolvedItems(){
  return [
    ...activeOrderLines().filter(order=>
      ['new','shipping_wait'].includes(statusKey(order))
    ),
    ...activeClaims().filter(claim=>
      ['cancel','return','exchange','inquiry']
        .includes(statusKey(claim))
    )
  ];
}

function canonicalUnresolvedCounts(){
  const counts={
    new:0,
    shipping_wait:0,
    cancel:0,
    return:0,
    exchange:0,
    inquiry:0
  };

  canonicalUnresolvedItems().forEach(item=>{
    const key=statusKey(item);

    if(Object.prototype.hasOwnProperty.call(counts,key)){
      counts[key]+=1;
    }
  });

  return counts;
}

function canonicalUnresolvedByMarket(){
  const result={};

  MARKETS.forEach(([,name])=>{
    result[name]={
      new:0,
      shipping_wait:0,
      cancel:0,
      return:0,
      exchange:0,
      inquiry:0,
      orderAmount:0
    };
  });

  activeOrderGroups().forEach(group=>{
    if(!result[group.market]) return;

    const activeLines=group.lines.filter(isActiveOrderWork);
    const statuses=new Set(activeLines.map(statusKey));

    if(statuses.has('new')){
      result[group.market].new+=1;
    }

    if(statuses.has('shipping_wait')){
      result[group.market].shipping_wait+=1;
    }

    if(activeLines.length){
      result[group.market].orderAmount+=
        Number(group.amount||0);
    }
  });

  activeClaims().forEach(claim=>{
    const market=claim.market;
    const key=statusKey(claim);

    if(
      result[market] &&
      ['cancel','return','exchange','inquiry']
        .includes(key)
    ){
      result[market][key]+=1;
    }
  });

  return result;
}


function currentUnresolvedItems(){
  return canonicalUnresolvedItems();
}

function currentUnresolvedCounts(){
  return canonicalUnresolvedCounts();
}

function currentUnresolvedByMarket(){
  return canonicalUnresolvedByMarket();
}


function unresolvedByMarket(){
  const result={};

  MARKETS.forEach(([,name])=>{
    result[name]={
      new:0,
      shipping_wait:0,
      cancel:0,
      return:0,
      exchange:0,
      inquiry:0,
      orderAmount:0
    };
  });

  activeOrderGroups().forEach(group=>{
    if(!result[group.market]) return;

    const statuses=new Set(
      group.lines.map(statusKey)
    );

    if(statuses.has('new')){
      result[group.market].new+=1;
    }

    if(statuses.has('shipping_wait')){
      result[group.market].shipping_wait+=1;
    }

    result[group.market].orderAmount+=
      Number(group.amount||0);
  });

  activeClaims().forEach(claim=>{
    const market=claim.market;
    const key=statusKey(claim);

    if(
      result[market] &&
      ['cancel','return','exchange','inquiry']
        .includes(key)
    ){
      result[market][key]+=1;
    }
  });

  return result;
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


function engineTimestamp(order){
  const candidates=[
    order?.sourceUpdatedAt,
    order?.lastChangedAt,
    order?.statusChangedAt,
    order?.updatedAt,
    order?.syncedAt,
    order?.createdAt,
    order?.datetime
  ];

  for(const value of candidates){
    if(!value) continue;

    if(value?.toDate){
      const time=value.toDate().getTime();
      if(Number.isFinite(time)) return time;
    }

    const time=new Date(value).getTime();
    if(Number.isFinite(time)) return time;
  }

  return 0;
}

function engineLineKey(order){
  const market=normalizedText(order?.market||order?.source);
  const orderNo=normalizedText(order?.orderNo||order?.orderId);
  const lineId=normalizedText(
    order?.productOrderId||
    order?.orderProductSequence||
    order?.orderItemId||
    order?.vendorItemId||
    order?.deliveryNo||
    order?.shipmentBoxId||
    order?.productNo||
    order?.itemId||
    order?.sku||
    order?.product||
    order?.id
  );

  return `${market}|${orderNo}|${lineId}`;
}

function engineOrderKey(order){
  return [
    normalizedText(order?.market||order?.source),
    normalizedText(
      order?.orderNo||
      order?.orderId||
      order?.shipmentBoxId||
      order?.deliveryNo||
      order?.id
    )
  ].join('|');
}


function lifecycleOriginalDate(history){
  const candidates=[];

  history.forEach(item=>{
    for(const value of [
      item?.orderDate,
      item?.orderAt,
      item?.orderedAt,
      item?.paymentDate,
      item?.paymentAt,
      item?.datetime
    ]){
      if(!value) continue;
      const date=value?.toDate?value.toDate():new Date(value);

      if(!Number.isNaN(date.getTime())){
        candidates.push(date);
      }
    }
  });

  if(!candidates.length){
    return new Date(0);
  }

  return new Date(
    Math.min(...candidates.map(date=>date.getTime()))
  );
}

function lifecycleLatestLines(){
  const histories=new Map();

  orders
    .filter(order=>marketIncludedOrder(order)&&order.activeState!==false)
    .forEach(order=>{
      const key=engineLineKey(order);

      if(!histories.has(key)){
        histories.set(key,[]);
      }

      histories.get(key).push(order);
    });

  return [...histories.values()].map(history=>{
    history.sort(
      (a,b)=>engineTimestamp(a)-engineTimestamp(b)
    );

    const original=history[0];
    const latest=history[history.length-1];
    const originalDate=lifecycleOriginalDate(history);

    const amountSource=history.find(item=>
      Number(
        item?.orderTotalAmount||
        item?.totalAmount||
        item?.paymentAmount||
        item?.amount||
        item?.salePrice
      )>0
    )||original;

    return {
      ...original,
      ...latest,
      orderDate:
        originalDate.getTime()
          ?originalDate.toISOString()
          :latest.orderDate,
      orderAt:
        original.orderAt||latest.orderAt,
      orderedAt:
        original.orderedAt||latest.orderedAt,
      paymentDate:
        original.paymentDate||latest.paymentDate,
      paymentAt:
        original.paymentAt||latest.paymentAt,
      orderTotalAmount:
        amountSource.orderTotalAmount,
      totalAmount:
        amountSource.totalAmount,
      paymentAmount:
        amountSource.paymentAmount,
      amount:
        amountSource.amount,
      salePrice:
        amountSource.salePrice,
      lifecycleHistoryCount:history.length
    };
  });
}


function oneStatusPriority(order){
  const key=statusKey(order);
  const priority={
    inquiry:60,
    exchange:50,
    return:40,
    cancel:30,
    shipping_wait:20,
    new:10
  };
  return priority[key]||0;
}

function oneStatusCompleted(order){
  if(engineCompleted(order)||isProcessed(order)){
    return true;
  }

  const text=[
    order?.sourceStatus,
    order?.status,
    order?.statusLabel,
    order?.claimStatus,
    order?.processingStatus,
    order?.resultStatus,
    order?.receiptStatus,
    order?.exchangeStatus,
    order?.answerStatus,
    order?.inquiryStatus
  ].filter(Boolean).join(' ').toUpperCase();

  return [
    'COMPLETE','COMPLETED','CLOSED','DONE',
    'FINISH','FINISHED','WITHDRAW','WITHDRAWN',
    'REJECT','REJECTED','DELIVERED','PURCHASE_CONFIRMED',
    'ANSWERED','ANSWER_COMPLETE','REPLIED','RESOLVED',
    'CANCEL_COMPLETE','RETURN_COMPLETE','EXCHANGE_COMPLETE',
    '처리완료','취소완료','반품완료','교환완료',
    '답변완료','배송완료','구매확정','철회','거부','종결'
  ].some(word=>text.includes(word));
}

function oneCurrentStatusPerOrder(){
  return lifecycleLatestLines().filter(item=>{
    const status=statusKey(item);

    return (
      [
        'new','shipping_wait','cancel',
        'return','exchange','inquiry'
      ].includes(status) &&
      item.activeState!==false &&
      !oneStatusCompleted(item)
    );
  });
}


function lifecycleUnresolvedGroups(){
  return oneCurrentStatusPerOrder();
}


function engineLatestLines(){
  return lifecycleLatestLines();
}

function engineOrderDate(order){
  for(const value of [
    order?.orderDate,
    order?.orderAt,
    order?.orderedAt,
    order?.paymentDate,
    order?.paymentAt,
    order?.datetime,
    order?.createdAt
  ]){
    if(!value) continue;
    const date=value?.toDate?value.toDate():new Date(value);
    if(!Number.isNaN(date.getTime())) return date;
  }

  return new Date(0);
}

function engineOrderDay(order){
  const date=engineOrderDate(order);
  if(!date.getTime()) return '';

  return new Intl.DateTimeFormat(
    'sv-SE',
    {
      timeZone:'Asia/Seoul',
      year:'numeric',
      month:'2-digit',
      day:'2-digit'
    }
  ).format(date);
}

function engineAmount(order){
  for(const value of [
    order?.orderTotalAmount,
    order?.totalAmount,
    order?.paymentAmount,
    order?.amount,
    order?.salePrice
  ]){
    const number=Number(value);
    if(Number.isFinite(number)&&number>=0) return number;
  }

  return 0;
}

function engineCompleted(order){
  if(isProcessed(order)) return true;

  const text=[
    order?.sourceStatus,
    order?.status,
    order?.statusLabel,
    order?.claimStatus,
    order?.processingStatus,
    order?.resultStatus,
    order?.receiptStatus,
    order?.exchangeStatus
  ].filter(Boolean).join(' ').toUpperCase();

  return [
    'COMPLETE','COMPLETED','CLOSED','DONE',
    'FINISH','FINISHED','WITHDRAW','WITHDRAWN',
    'REJECT','REJECTED','DELIVERED','PURCHASE_CONFIRMED',
    '처리완료','취소완료','반품완료','교환완료',
    '답변완료','배송완료','구매확정','철회','거부','종결'
  ].some(word=>text.includes(word));
}

function engineNormalLines(){
  const latest=engineLatestLines();
  const excludedOrders=new Set();

  latest.forEach(item=>{
    const event=String(item?.eventType||'order').toLowerCase();
    const key=statusKey(item);
    if(event!=='order'&&['cancel','return','exchange'].includes(key)){
      excludedOrders.add(engineOrderKey(item));
    }
  });

  return latest.filter(order=>
    String(order?.eventType||'order').toLowerCase()==='order' &&
    !excludedOrders.has(engineOrderKey(order)) &&
    !['cancel','return','exchange','inquiry'].includes(statusKey(order))
  );
}

function engineNormalGroups(){
  const groups=new Map();

  engineNormalLines().forEach(line=>{
    const key=engineOrderKey(line);

    if(!groups.has(key)){
      groups.set(key,{
        key,
        market:line.market||line.source||'기타',
        orderNo:line.orderNo||line.orderId||'',
        day:engineOrderDay(line),
        date:engineOrderDate(line),
        lines:[],
        qty:0,
        lineAmount:0,
        explicitTotal:0
      });
    }

    const group=groups.get(key);
    group.lines.push(line);
    group.qty+=Number(line.qty||1);

    const explicit=Number(
      line.orderTotalAmount||
      line.totalAmount||
      line.paymentAmount
    );

    if(Number.isFinite(explicit)&&explicit>0){
      group.explicitTotal=Math.max(group.explicitTotal,explicit);
    }else{
      group.lineAmount+=engineAmount(line);
    }
  });

  return [...groups.values()].map(group=>({
    ...group,
    amount:Number(group.explicitTotal||0)||Number(group.lineAmount||0)
  }));
}

function engineTodayGroups(){
  const today=todayKey();
  return engineNormalGroups().filter(group=>group.day===today);
}

function engineMonthGroups(){
  const month=monthKey();
  return engineNormalGroups().filter(
    group=>String(group.day||'').slice(0,7)===month
  );
}

function engineUnresolvedItems(){
  return oneCurrentStatusPerOrder();
}

function engineUnresolvedCounts(){
  const sets={
    new:new Set(),shipping_wait:new Set(),cancel:new Set(),
    return:new Set(),exchange:new Set(),inquiry:new Set()
  };

  engineUnresolvedItems().forEach(item=>{
    const status=statusKey(item);
    if(sets[status]) sets[status].add(engineLineKey(item));
  });

  return Object.fromEntries(
    Object.entries(sets).map(([key,set])=>[key,set.size])
  );
}

function engineUnresolvedByMarket(){
  const result={};

  MARKETS.forEach(([,name])=>{
    result[name]={new:0,shipping_wait:0,cancel:0,return:0,exchange:0,inquiry:0,orderAmount:0};
  });

  oneCurrentStatusPerOrder().forEach(item=>{
    const market=item.market;
    const status=statusKey(item);

    if(!result[market]||!(status in result[market])) return;

    result[market][status]+=1;

    if(['new','shipping_wait'].includes(status)){
      result[market].orderAmount+=engineAmount(item);
    }
  });

  return result;
}



function todayOrderSourceLines(){
  return lifecycleLatestLines().filter(order=>
    String(order?.eventType||'order').toLowerCase()==='order' &&
    engineOrderDay(order)===todayKey()
  );
}

function todayOrderGroups(){
  const groups=new Map();

  todayOrderSourceLines().forEach(line=>{
    const key=engineOrderKey(line);

    if(!groups.has(key)){
      groups.set(key,{
        key,
        market:line.market||line.source||'기타',
        orderNo:line.orderNo||line.orderId||'',
        day:engineOrderDay(line),
        date:engineOrderDate(line),
        lines:[],
        qty:0,
        lineAmount:0,
        explicitTotal:0
      });
    }

    const group=groups.get(key);
    group.lines.push(line);
    group.qty+=Number(line.qty||1);

    const explicit=Number(
      line.orderTotalAmount||
      line.totalAmount||
      line.paymentAmount
    );

    if(Number.isFinite(explicit)&&explicit>0){
      group.explicitTotal=Math.max(
        group.explicitTotal,
        explicit
      );
    }else{
      group.lineAmount+=engineAmount(line);
    }
  });

  return [...groups.values()].map(group=>({
    ...group,
    amount:
      Number(group.explicitTotal||0)||
      Number(group.lineAmount||0)
  }));
}

function todayMarketSummary(){
  const result={};
  const statusSets={};

  MARKETS.forEach(([,name])=>{
    result[name]={
      orders:0,
      sales:0,
      new:0,
      shipping_wait:0,
      cancel:0,
      return:0,
      exchange:0,
      inquiry:0
    };

    statusSets[name]={
      new:new Set(),
      shipping_wait:new Set(),
      cancel:new Set(),
      return:new Set(),
      exchange:new Set(),
      inquiry:new Set()
    };
  });

  todayOrderGroups().forEach(group=>{
    if(!result[group.market]) return;

    result[group.market].orders+=1;
    result[group.market].sales+=Number(group.amount||0);
  });

  lifecycleUnresolvedGroups()
    .filter(item=>engineOrderDay(item)===todayKey())
    .forEach(item=>{
      const market=item.market;
      const status=statusKey(item);

      if(statusSets[market]?.[status]){
        statusSets[market][status].add(
          engineOrderKey(item)
        );
      }
    });

  Object.keys(result).forEach(market=>{
    Object.keys(statusSets[market]).forEach(status=>{
      result[market][status]=
        statusSets[market][status].size;
    });
  });

  return result;
}


function correctedPendingByMarket(){
  return engineUnresolvedByMarket();
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
  const groups=todayOrderGroups();

  return {
    count:groups.length,
    sales:groups.reduce(
      (sum,group)=>sum+Number(group.amount||0),
      0
    )
  };
}

function correctedMonthTotals(){
  const groups=engineMonthGroups();

  return {
    count:groups.length,
    sales:groups.reduce(
      (sum,group)=>sum+Number(group.amount||0),
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
  const counts=engineUnresolvedCounts();
  const grid=$('statusGrid');
  if(!grid) return;

  grid.innerHTML=STATUS_ITEMS.map(([key,label])=>`
    <button class="alert-card ${activeStatus===key?'active':''}" data-key="${key}">
      <span>${label}</span><strong>${Number(counts[key]||0)}</strong>
    </button>`).join('');

  grid.querySelectorAll('button').forEach(button=>{
    button.onclick=()=>{
      activeStatus=activeStatus===button.dataset.key?'':button.dataset.key;
      currentPage=1;
      showOrdersTab();
      render();
    };
  });

  const info=$('dedupeInfo');
  if(info) info.textContent='주문번호별 현재 처리상태 하나만 표시 · 완료 시 자동 제외';

  $('statusUpdated').textContent='최근 갱신 '+new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});
}
function renderMarkets(){
  const today=todayMarketSummary();

  $('marketBody').innerHTML=MARKETS.map(([key,name])=>{
    const data=today[name]||{};
    const connected=Boolean(integrations[key]?.connected);

    return `
      <tr
        class="market-row ${activeMarket===name?'selected':''}"
        data-market="${name}"
      >
        <td>
          <span class="market-name">
            <span class="market-dot ${connected?'ok':''}"></span>
            ${name}
          </span>
        </td>
        <td class="order-sales-cell">
          <strong>${Number(data.orders||0)}</strong>
          <small>${fmt(data.sales||0)}</small>
        </td>
        <td>${Number(data.new||0)}</td>
        <td>${Number(data.shipping_wait||0)}</td>
        <td>${Number(data.cancel||0)}</td>
        <td>${Number(data.return||0)}</td>
        <td>${Number(data.exchange||0)}</td>
      </tr>
    `;
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
    `오늘 ${todayKey()} 00:00부터 · `+
    new Date().toLocaleTimeString(
      'ko-KR',
      {hour:'2-digit',minute:'2-digit'}
    );
}
function filteredOrders(){
  const q=$('searchInput').value.trim().toLowerCase();
  const market=$('marketFilter').value;
  const read=$('readFilter').value;

  return oneCurrentStatusPerOrder().filter(order=>{
    const status=statusKey(order);

    if(activeStatus&&status!==activeStatus) return false;
    if(activeMarket&&order.market!==activeMarket) return false;
    if(market&&order.market!==market) return false;

    const hit=!q||[
      order.product,order.orderNo,order.buyer,order.phone,
      order.invoiceNumber,order.workflowNote
    ].some(value=>String(value||'').toLowerCase().includes(q));

    if(!hit) return false;
    if(read==='unread'&&!isUnread(order)) return false;
    if(read==='read'&&isUnread(order)) return false;
    return true;
  }).sort((a,b)=>{
    const priority={new:1,shipping_wait:2,cancel:3,return:4,exchange:5,inquiry:6};
    const diff=(priority[statusKey(a)]||9)-(priority[statusKey(b)]||9);
    return diff||engineTimestamp(b)-engineTimestamp(a);
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
    <tr class="order-row" data-id="${escapeHtml(o.id)}">
      <td data-label="상태"><span class="status-pill">${escapeHtml(labelFor(o))}</span></td>
      <td data-label="일시">${escapeHtml(dateValue(o).replace('T',' ').slice(0,16))}</td>
      <td data-label="쇼핑몰">${escapeHtml(o.market||'')}</td>
      <td data-label="주문번호">${escapeHtml(o.orderNo||'')}</td>
      <td data-label="상품명" class="product-cell">${isImportant(o)?'⭐ ':''}${escapeHtml(o.product||'상품명 없음')}${o.workflowNote?`<small style="display:block;color:var(--muted);margin-top:4px">${escapeHtml(o.workflowNote)}</small>`:''}</td>
      <td data-label="수량">${Number(o.qty||0)}</td>
      <td data-label="구매자">${escapeHtml(o.buyer||'')}</td>
      <td data-label="금액">${fmt(o.amount)}</td>
      <td data-label="관리"><button class="mini-btn read-btn" data-id="${escapeHtml(o.id)}">${isUnread(o)?'확인':'미확인'}</button></td>
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
  const groups=statsGroupsForPeriod(period);

  $('statOrders').textContent=
    groups.length+'건';

  $('statQty').textContent=
    groups.reduce(
      (sum,group)=>sum+Number(group.qty||0),
      0
    )+'개';

  $('statSales').textContent=fmt(
    groups.reduce(
      (sum,group)=>sum+Number(group.amount||0),
      0
    )
  );

  const products={};

  groups.forEach(group=>{
    group.lines.forEach(line=>{
      const name=line.product||'상품명 없음';

      if(!products[name]){
        products[name]={
          orders:new Set(),
          qty:0,
          sales:0
        };
      }

      products[name].orders.add(group.key);
      products[name].qty+=Number(line.qty||1);
      products[name].sales+=orderAmountValue(line);
    });
  });

  $('productRank').innerHTML=
    Object.entries(products)
      .map(([name,value])=>[
        name,
        {
          count:value.orders.size,
          qty:value.qty,
          sales:value.sales
        }
      ])
      .sort(
        (a,b)=>
          b[1].count-a[1].count||
          b[1].sales-a[1].sales
      )
      .slice(0,10)
      .map(([name,value],index)=>`
        <div class="rank-row">
          <span class="rank-no">${index+1}</span>
          <div class="rank-name">
            <strong>${escapeHtml(name)}</strong>
            <small>
              ${value.count}건 · ${value.qty}개
            </small>
          </div>
          <strong>${fmt(value.sales)}</strong>
        </div>
      `).join('')||
    '<div class="subtle">해당 기간의 주문이 없습니다.</div>';
}


function renderTodayAnalytics(){
  const groups=todayOrderGroups();
  const hourly=Array.from({length:24},()=>0);
  groups.forEach(group=>{
    const date=group.date;
    if(!date?.getTime?.()) return;
    const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',hour12:false}).format(date));
    if(hour>=0&&hour<24) hourly[hour]+=1;
  });
  const maxHour=Math.max(1,...hourly);
  $('hourChart').innerHTML=hourly.map((count,hour)=>`<div class="hour-col" title="${hour}시 ${count}건"><span class="hour-value">${count||''}</span><div class="hour-bar" style="height:${Math.max(2,Math.round(count/maxHour*100))}%"></div><span class="hour-label">${hour%3===0?hour+'시':''}</span></div>`).join('');

  const marketSales={};
  groups.forEach(group=>marketSales[group.market]=Number(marketSales[group.market]||0)+Number(group.amount||0));
  const totalSales=Object.values(marketSales).reduce((s,v)=>s+v,0)||1;
  $('marketShare').innerHTML=Object.entries(marketSales).sort((a,b)=>b[1]-a[1]).map(([market,sales])=>`<div class="share-row"><strong>${escapeHtml(market)}</strong><div class="share-track"><div class="share-fill" style="width:${Math.max(2,sales/totalSales*100)}%"></div></div><span class="share-value">${Math.round(sales/totalSales*100)}%</span></div>`).join('')||'<span class="subtle">오늘 주문이 없습니다.</span>';

  const products={};
  groups.forEach(group=>group.lines.forEach(line=>{
    const name=line.product||'상품명 없음';
    if(!products[name]) products[name]={orders:new Set(),qty:0,sales:0};
    products[name].orders.add(group.key); products[name].qty+=Number(line.qty||1); products[name].sales+=engineAmount(line);
  }));
  $('todayTopProducts').innerHTML=Object.entries(products).map(([name,v])=>[name,{orders:v.orders.size,qty:v.qty,sales:v.sales}]).sort((a,b)=>b[1].orders-a[1].orders||b[1].sales-a[1].sales).slice(0,10).map(([name,v],i)=>`<div class="top-row"><span class="top-no">${i+1}</span><div><strong>${escapeHtml(name)}</strong><small>${v.orders}건 · ${v.qty}개</small></div><strong>${fmt(v.sales)}</strong></div>`).join('')||'<span class="subtle">오늘 판매 상품이 없습니다.</span>';
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
  const dialog=$('detailDialog');
  if(dialog?.open){
    dialog.close();
  }
}

function render(){saveCloudCache();renderMetrics();renderStatus();renderMarkets();renderOrders();renderStats();renderIntegrations();renderTodayAnalytics()}

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

  const indicator=$('agentStatus');
  const telegram=$('telegramState');

  function parseHeartbeat(data={}){
    const candidates=[
      data.lastSeenEpoch,
      data.lastSeenIso,
      data.lastSeen?.toDate?.()?.getTime?.()
    ];

    for(const value of candidates){
      if(typeof value==='number'&&Number.isFinite(value)){
        return value;
      }

      if(typeof value==='string'){
        const parsed=new Date(value).getTime();
        if(Number.isFinite(parsed)){
          return parsed;
        }
      }
    }

    return 0;
  }

  function showAgentState(data={}){
    const heartbeat=parseHeartbeat(data);
    const age=heartbeat
      ?Math.max(0,Date.now()-heartbeat)
      :Infinity;

    if(indicator){
      indicator.classList.remove('ok','error','warning');

      if(age<=75*1000){
        indicator.textContent=
          `PC 수집기 정상 · ${Math.floor(age/1000)}초 전`;
        indicator.classList.add('ok');
      }else if(age<=180*1000){
        indicator.textContent=
          `PC 수집기 지연 · ${Math.floor(age/1000)}초 전`;
        indicator.classList.add('warning');
      }else{
        indicator.textContent='PC 수집기 응답 없음';
        indicator.classList.add('error');
      }
    }

    if(telegram){
      telegram.classList.remove('ok','error','warning');

      if(data.telegramLastError){
        telegram.textContent=
          '텔레그램 오류 · '+
          String(data.telegramLastError).slice(0,40);
        telegram.classList.add('error');
      }else if(data.telegramConfigured){
        telegram.textContent='텔레그램 연결됨';
        telegram.classList.add('ok');
      }else{
        telegram.textContent='텔레그램 설정 확인';
        telegram.classList.add('warning');
      }
    }
  }

  function showIntegrationFallback(){
    const timestamps=Object.values(integrations||{})
      .flatMap(info=>[
        info?.lastRun,
        info?.lastSuccess,
        info?.updatedAt
      ])
      .filter(Boolean)
      .map(value=>{
        if(value?.toDate){
          return value.toDate().getTime();
        }

        return new Date(value).getTime();
      })
      .filter(Number.isFinite);

    if(!timestamps.length){
      if(indicator){
        indicator.textContent='PC 수집기 상태 확인 중';
        indicator.classList.remove('ok','error','warning');
      }
      return;
    }

    const latest=Math.max(...timestamps);
    const age=Date.now()-latest;

    if(indicator){
      indicator.classList.remove('ok','error','warning');

      if(age<15*60*1000){
        indicator.textContent=
          `PC 수집기 수집 확인 · ${relativeTime(
            new Date(latest).toISOString()
          )}`;
        indicator.classList.add('ok');
      }else{
        indicator.textContent='PC 수집기 응답 없음';
        indicator.classList.add('error');
      }
    }
  }

  showIntegrationFallback();

  agentUnsubscribe=db.collection('system')
    .doc('agent')
    .onSnapshot(
      {includeMetadataChanges:true},
      snapshot=>{
        if(snapshot.exists){
          showAgentState(snapshot.data()||{});
        }else{
          showIntegrationFallback();
        }
      },
      error=>{
        console.warn(
          'PC 수집기 생존신호 읽기 실패:',
          error
        );

        showIntegrationFallback();
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

  unsubscribeOrders=db.collection('orders')
    .orderBy('createdAt','desc')
    .limit(600)
    .onSnapshot(
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

      retryCloud(60000);
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
        retryCloud(60000);
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

    retryCloud(60000);
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
$('saveNoteBtn').onclick=saveCurrentNote;
if('serviceWorker' in navigator){
  navigator.serviceWorker.getRegistrations()
    .then(regs=>Promise.all(regs.map(reg=>reg.update().catch(()=>{}))))
    .finally(()=>navigator.serviceWorker.register('./sw.js?v=final-v4.2.0',{updateViaCache:'none'}))
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




document.addEventListener('DOMContentLoaded',()=>{
  for(const id of ['orderDialog','detailDialog']){
    const dialog=document.getElementById(id);

    if(dialog?.open){
      dialog.close();
    }
  }
});


let renderedKoreaDay=todayKey();

setInterval(()=>{
  const currentDay=todayKey();

  if(currentDay!==renderedKoreaDay){
    renderedKoreaDay=currentDay;
    currentPage=1;
    activeStatus='';
    activeMarket='';
    render();
    toast('날짜가 변경되어 오늘 주문 현황을 초기화했습니다.');
  }
},120000);


let activeOrdersUnsubscribe=null;
let activeSystemUnsubscribe=null;

function replaceSubscription(slot,unsubscribe){
  if(typeof window[slot]==='function'){
    try{
      window[slot]();
    }catch{}
  }

  window[slot]=unsubscribe;
}


const FREE_MODE_LIMITS={
  maxLoadedOrders:600,
  listenerReconnectMs:60000,
  mode:'무료 한도 보호'
};

function renderFreeModeBadge(){
  const badge=document.getElementById('versionBadge');

  if(
    badge &&
    !badge.textContent.includes('무료 보호')
  ){
    badge.textContent+=' · 무료 보호';
  }
}


document.addEventListener('DOMContentLoaded',renderFreeModeBadge);
