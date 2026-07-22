const APP_VERSION='FINAL v7.7.14';
const BUILD_DATE='2026-07-22';
const firebaseConfig={"apiKey": "AIzaSyCFRmQPRvYznJV-MTzKb__SpYDfvMpmgAo", "authDomain": "alldaypick-order-alert.firebaseapp.com", "projectId": "alldaypick-order-alert", "storageBucket": "alldaypick-order-alert.firebasestorage.app", "messagingSenderId": "549342074740", "appId": "1:549342074740:web:c003e0eb0e75097008be21"};
let auth=null;
let db=null;
const $=id=>document.getElementById(id);
const fmt=n=>Number(n||0).toLocaleString('ko-KR')+'원';
const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const MARKETS=[['coupang','쿠팡'],['smartstore','스마트스토어'],['elevenst','11번가'],['gmarket','G마켓'],['auction','옥션'],['lotteon','롯데온']];
const STATUS_ITEMS=[['new','신규주문'],['shipping_wait','발송대기'],['cancel','주문취소'],['return','반품요청'],['exchange','교환요청'],['inquiry','문의사항']];
let orders=[],integrations={},currentUser=null,activeStatus='',activeMarket='',currentPage=1,currentDetail=null,unsubscribeOrders=null,unsubscribeActiveOrders=null,collectUnsub=null;
let monthOrderMap=new Map(),activeOrderMap=new Map();
const PAGE_SIZE=40;

function toast(text){const el=$('toast');el.textContent=text;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2200)}
function dateValue(o){const v=o.datetime||o.createdAt?.toDate?.()?.toISOString?.()||o.updatedAt?.toDate?.()?.toISOString?.()||'';return String(v)}
function orderDay(o){const d=new Date(dateValue(o));if(Number.isNaN(d.getTime()))return'';return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(d)}
function todayKey(){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date())}
function monthKey(){return todayKey().slice(0,7)}

function hasShipmentEvidence(order){
  const invoice=String(
    order?.invoiceNumber||
    order?.trackingNumber||
    order?.waybillNumber||
    order?.deliveryInvoiceNo||
    order?.shipmentInvoiceNo||
    ''
  ).trim();

  const carrier=String(
    order?.deliveryCompany||
    order?.carrierName||
    order?.courierName||
    order?.logisticsCompany||
    ''
  ).trim();

  const shippedAt=
    order?.shippedAt||
    order?.departureAt||
    order?.deliveryStartAt||
    order?.shipmentDate||
    order?.dispatchDate||
    order?.sentAt;

  return Boolean(invoice||carrier||shippedAt);
}


function statusKey(o){
  const source=String(o?.sourceStatus||'').toUpperCase();
  const status=String(o?.status||'').toLowerCase();
  const eventType=String(o?.eventType||'order').toLowerCase();
  if(excludedFromOperationalMetrics(o)) return 'gift_wait';

  if(
    eventType==='cancel' ||
    status.includes('cancel') ||
    source.includes('CANCEL') ||
    source.includes('취소')
  ){
    return 'cancel';
  }

  if(
    eventType==='return' ||
    status.includes('return') ||
    source.includes('RETURN') ||
    source.includes('반품')
  ){
    return 'return';
  }

  if(
    eventType==='exchange' ||
    status.includes('exchange') ||
    source.includes('EXCHANGE') ||
    source.includes('교환')
  ){
    return 'exchange';
  }

  if(eventType==='inquiry'||status.includes('inquiry')){
    return 'inquiry';
  }

  // The current source state must win over a stale normalized status that may
  // still be stored on an older document.
  if(
    status==='purchase_confirmed' ||
    source.includes('PURCHASE_DECIDED') ||
    source.includes('PURCHASE_CONFIRM')
  ){
    return 'delivered';
  }

  if(
    source.includes('FINAL_DELIVERY') ||
    source.includes('DELIVERED') ||
    status==='delivered'
  ){
    return 'delivered';
  }

  if(
    source.includes('DELIVERING') ||
    source.includes('SHIPPED') ||
    source.includes('DISPATCHED') ||
    source.includes('DEPARTURE') ||
    status==='delivering' ||
    status==='departure'
  ){
    return hasShipmentEvidence(o)||!source.includes('DEPARTURE')
      ?'delivering'
      :'shipping_wait';
  }

  const placeOrderStatus=String(o?.placeOrderStatus||'').toUpperCase();
  const hasPlaceOrder=Boolean(
    o?.placeOrderDate||
    placeOrderStatus==='OK'||
    source.includes('PLACE_ORDER')||
    source.includes('ORDER_CONFIRM')
  );

  if(
    hasPlaceOrder||
    source.includes('INSTRUCT') ||
    status==='shipping_wait' ||
    source.includes('PREPARE') ||
    source.includes('READY') ||
    source.includes('PACKAGING') ||
    source.includes('발송대기') ||
    source.includes('발주확인')
  ){
    return 'shipping_wait';
  }

  if(
    source.includes('ACCEPT') ||
    source.includes('PAYED') ||
    source.includes('PAYMENT_WAITING') ||
    status==='new'
  ){
    return 'new';
  }

  return status||'';
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
    'CANCEL_REJECT','RETURN_REJECT','EXCHANGE_REJECT',
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

function excludedFromOperationalMetrics(o){
  const giftStatus=String(o?.giftReceivingStatus||'').toUpperCase();
  return o?.excludedFromMetrics===true||o?.giftPending===true||giftStatus==='WAIT_FOR_RECEIVING';
}

function marketIncludedOrder(o){
  if(excludedFromOperationalMetrics(o)) return false;
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
    '철회','거부','종결','요청철회','반품철회','교환철회'
  ];

  return completedWords.some(word=>
    text.includes(word)
  );
}

function isActiveOrderWork(order){
  if(
    !isOrderEvent(order) ||
    isProcessed(order) ||
    order?.activeState===false
  ){
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

function activeOrderGroups(){
  const groups=new Map();

  activeOrderLines().forEach(line=>{
    const key=orderGroupKey(line);
    const current=groups.get(key);

    if(
      !current ||
      timestampValue(line)>timestampValue(current) ||
      (
        timestampValue(line)===timestampValue(current) &&
        statusPriority(line)>statusPriority(current)
      )
    ){
      groups.set(key,line);
    }
  });

  return [...groups.values()];
}

function activeClaims(){
  return latestClaimDocuments()
    .filter(isActiveClaimWork);
}

function moneyNumber(value){
  if(value==null||value==='') return 0;
  if(typeof value==='object'){
    const number=Number(value.units||0)+Number(value.nanos||0)/1e9;
    return Number.isFinite(number)&&number>0?number:0;
  }
  const number=Number(String(value).replace(/[^0-9.-]/g,''));
  return Number.isFinite(number)&&number>0?number:0;
}

function firstPositiveAmount(values=[]){
  for(const value of values){
    const number=moneyNumber(value);
    if(number>0) return number;
  }
  return 0;
}

function lineAmountValue(order){
  const direct=firstPositiveAmount([
    order?.amount,order?.lineAmount,order?.lineTotalAmount,
    order?.itemAmount,order?.productAmount,order?.salePrice,
    order?.totalProductAmount,order?.orderItemAmount,
    order?.ordAmt,order?.prdAmt,order?.saleAmt
  ]);
  if(direct>0) return direct;

  const unit=firstPositiveAmount([
    order?.unitPrice,order?.itemPrice,order?.orderItemUnitPrice,
    order?.salePrc,order?.sellPrc,order?.selPrc,order?.price
  ]);
  const qty=Math.max(1,Number(order?.qty||order?.quantity||order?.ordQty||1));
  return unit>0?unit*qty:0;
}

function explicitOrderTotalValue(order){
  return firstPositiveAmount([
    order?.orderTotalAmount,order?.totalAmount,order?.paymentAmount,
    order?.totalPaymentAmount,order?.realPayAmt,order?.ordPayAmt,
    order?.payAmt,order?.settlementAmount
  ]);
}

function orderAmountValue(order){
  return lineAmountValue(order)||explicitOrderTotalValue(order)||0;
}

function allocatedGroupLineAmounts(group){
  const lines=Array.isArray(group?.lines)?group.lines:[];
  const known=lines.map(line=>lineAmountValue(line));
  const knownTotal=known.reduce((sum,value)=>sum+value,0);
  const groupTotal=Math.max(0,Number(group?.amount||0));
  const remaining=Math.max(0,groupTotal-knownTotal);
  const missingQty=lines.reduce((sum,line,index)=>
    sum+(known[index]>0?0:Math.max(1,Number(line?.qty||1))),0
  );

  return lines.map((line,index)=>{
    if(known[index]>0) return known[index];
    if(remaining>0&&missingQty>0){
      return Math.round(remaining*Math.max(1,Number(line?.qty||1))/missingQty);
    }
    return lines.length===1?groupTotal:0;
  });
}

function relatedOrderLine(order){
  const event=String(order?.eventType||'order').toLowerCase();
  if(event==='order') return order;
  const source=String(order?.source||'').toLowerCase();
  const market=String(order?.market||'');
  const orderNo=String(order?.orderNo||order?.orderId||'').trim();
  const ids=new Set([
    order?.productOrderId,order?.vendorItemId,order?.orderItemId,
    order?.orderProductSequence,order?.productNo,order?.productId,
    order?.channelProductNo,order?.spdNo,order?.sitmNo,order?.itemNo,
    order?.sellerProductId,order?.sellerProductCode
  ].map(value=>String(value||'').trim()).filter(Boolean));
  const product=String(order?.product||'').replace(/\s+/g,' ').trim().toLowerCase();

  return latestOrderLines()
    .map(candidate=>{
      if(source&&String(candidate?.source||'').toLowerCase()!==source) return null;
      if(!source&&market&&String(candidate?.market||'')!==market) return null;
      const candidateOrderNo=String(candidate?.orderNo||candidate?.orderId||'').trim();
      if(orderNo&&candidateOrderNo!==orderNo) return null;
      let score=orderNo?1000:0;
      for(const value of [
        candidate?.productOrderId,candidate?.vendorItemId,candidate?.orderItemId,
        candidate?.orderProductSequence,candidate?.productNo,candidate?.productId,
        candidate?.channelProductNo,candidate?.spdNo,candidate?.sitmNo,candidate?.itemNo,
        candidate?.sellerProductId,candidate?.sellerProductCode
      ]){
        if(ids.has(String(value||'').trim())) score+=150;
      }
      const candidateProduct=String(candidate?.product||'').replace(/\s+/g,' ').trim().toLowerCase();
      if(product&&candidateProduct){
        if(product===candidateProduct) score+=80;
        else if(product.includes(candidateProduct)||candidateProduct.includes(product)) score+=25;
      }
      return {candidate,score};
    })
    .filter(item=>item&&item.score>0)
    .sort((a,b)=>b.score-a.score)[0]?.candidate||null;
}

function allocatedAmountForOrderLine(line){
  if(!line) return 0;
  const key=orderGroupKey(line);
  const group=groupOrderLines(
    latestOrderLines().filter(candidate=>orderGroupKey(candidate)===key)
  )[0];
  if(!group) return explicitOrderTotalValue(line);
  const amounts=allocatedGroupLineAmounts(group);
  const index=group.lines.findIndex(candidate=>candidate.id===line.id);
  if(index>=0&&Number(amounts[index]||0)>0) return Number(amounts[index]||0);
  return group.lines.length===1?Number(group.amount||0):0;
}

function displayOrderAmount(order){
  const direct=lineAmountValue(order);
  if(direct>0) return direct;

  if(String(order?.eventType||'order').toLowerCase()==='order'){
    return allocatedAmountForOrderLine(order)||explicitOrderTotalValue(order)||0;
  }

  const related=relatedOrderLine(order);
  if(related){
    return lineAmountValue(related)||allocatedAmountForOrderLine(related)||explicitOrderTotalValue(related)||0;
  }

  return explicitOrderTotalValue(order)||0;
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

    const explicitTotal=explicitOrderTotalValue(line);

    if(explicitTotal>0){
      group.explicitTotal=Math.max(
        Number(group.explicitTotal||0),
        explicitTotal
      );
    }else{
      group.amount+=lineAmountValue(line);
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
    ...activeOrderGroups(),
    ...activeClaims()
  ];
}

function unresolvedRowsForMarket(market=''){
  return unresolvedRows().filter(order=>
    !market || order.market===market
  );
}

function statsGroupsForPeriod(period){
  const all=historicalNormalGroups();

  if(period==='all'){
    return all;
  }

  const days=Math.max(1,Number(period)||7);
  const cutoff=Date.now()-days*86400000;

  return all.filter(group=>
    group.date?.getTime?.()>=cutoff
  );
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
  return lineAmountValue(order)||explicitOrderTotalValue(order)||0;
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

    const explicit=explicitOrderTotalValue(order);

    if(explicit>0){
      group.explicitTotal=Math.max(
        group.explicitTotal,
        explicit
      );
    }else{
      group.amount+=lineAmountValue(order);
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



function allLifecycleLatestLines(){
  const histories=new Map();

  orders
    .filter(marketIncludedOrder)
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
      originalActiveState:
        original.activeState!==false,
      orderDate:
        originalDate.getTime()
          ?originalDate.toISOString()
          :(
            original.orderDate||
            latest.orderDate
          ),
      orderAt:
        original.orderAt||
        latest.orderAt,
      orderedAt:
        original.orderedAt||
        latest.orderedAt,
      paymentDate:
        original.paymentDate||
        latest.paymentDate,
      paymentAt:
        original.paymentAt||
        latest.paymentAt,
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


function authoritativeStatusRank(order){
  const key=statusKey(order);

  const rank={
    delivered:100,
    delivering:90,
    inquiry:80,
    exchange:70,
    return:60,
    cancel:50,
    shipping_wait:40,
    new:30
  };

  return rank[key]||0;
}

function authoritativeBusinessTime(order){
  const values=[
    order?.claimRequestedAt,
    order?.requestDate,
    order?.requestAt,
    order?.inquiryDate,
    order?.inquiryAt,
    order?.statusChangedAt,
    order?.sourceUpdatedAt,
    order?.lastChangedAt,
    order?.datetime,
    order?.orderDate,
    order?.orderAt,
    order?.orderedAt,
    order?.paymentDate,
    order?.paymentAt,
    order?.updatedAt,
    order?.syncedAt,
    order?.createdAt
  ];

  for(const value of values){
    if(!value){
      continue;
    }

    if(typeof value?.toDate==='function'){
      const time=value.toDate().getTime();

      if(Number.isFinite(time)){
        return time;
      }
    }

    const time=new Date(value).getTime();

    if(Number.isFinite(time)){
      return time;
    }
  }

  return 0;
}

function authoritativeCurrentStatusPerOrder(){
  if(!window.OrderStateEngine){
    return [];
  }
  return window.OrderStateEngine.pendingItems(orders,integrations);
}


function currentStatusPerOrder(){
  return authoritativeCurrentStatusPerOrder();
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
    'COMPLETE',
    'COMPLETED',
    'CLOSED',
    'DONE',
    'FINISH',
    'FINISHED',
    'WITHDRAW',
    'WITHDRAWN',
    'REJECT',
    'REJECTED',
    'DELIVERED',
    'FINAL_DELIVERY',
    'PURCHASE_CONFIRMED',
    'PURCHASE_DECIDED',
    'CANCEL_COMPLETE',
    'RETURN_COMPLETE',
    'EXCHANGE_COMPLETE',
    'ANSWERED',
    'ANSWER_COMPLETE',
    'REPLIED',
    'RESOLVED',
    'CLAIM_COMPLETE',
    'CLAIM_CLOSED',
    '처리완료',
    '배송완료',
    '구매확정',
    '취소완료',
    '반품완료',
    '교환완료',
    '답변완료',
    '철회',
    '거부',
    '종결'
  ].some(word=>text.includes(word));
}

function oneCurrentStatusPerOrder(){
  return authoritativeCurrentStatusPerOrder();
}


function lifecycleUnresolvedGroups(){
  return authoritativeCurrentStatusPerOrder();
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
  return lineAmountValue(order)||explicitOrderTotalValue(order)||0;
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


function historicalNormalGroups(){
  const groups=new Map();

  allLifecycleLatestLines()
    .filter(line=>
      String(line?.eventType||'order').toLowerCase()==='order'
    )
    .forEach(line=>{
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

      const explicit=explicitOrderTotalValue(line);

      if(explicit>0){
        group.explicitTotal=Math.max(
          group.explicitTotal,
          explicit
        );
      }else{
        group.lineAmount+=lineAmountValue(line);
      }
    });

  return [...groups.values()].map(group=>({
    ...group,
    amount:
      Number(group.explicitTotal||0)||
      Number(group.lineAmount||0)
  }));
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

    const explicit=explicitOrderTotalValue(line);

    if(explicit>0){
      group.explicitTotal=Math.max(group.explicitTotal,explicit);
    }else{
      group.lineAmount+=lineAmountValue(line);
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
  if(!window.OrderStateEngine){
    return [];
  }
  const month=monthKey();
  return window.OrderStateEngine.salesGroups(orders,integrations)
    .filter(group=>String(group.day||'').slice(0,7)===month);
}

function currentPendingItems(){
  if(!window.OrderStateEngine){
    return [];
  }
  return window.OrderStateEngine.pendingItems(orders,integrations);
}

function engineUnresolvedItems(){
  return currentPendingItems();
}

function engineUnresolvedCounts(){
  const counts={
    new:0,
    shipping_wait:0,
    cancel:0,
    return:0,
    exchange:0,
    inquiry:0
  };

  currentPendingItems().forEach(item=>{
    const key=statusKey(item);

    if(Object.prototype.hasOwnProperty.call(counts,key)){
      counts[key]+=1;
    }
  });

  return counts;
}

function engineUnresolvedByMarket(){
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

  currentPendingItems().forEach(item=>{
    const market=item.market;
    const status=statusKey(item);

    if(!result[market]||!(status in result[market])){
      return;
    }

    result[market][status]+=1;

    if(['new','shipping_wait'].includes(status)){
      result[market].orderAmount+=engineAmount(item);
    }
  });

  return result;
}



function todayOrderSourceLines(){
  return allLifecycleLatestLines().filter(order=>
    String(order?.eventType||'order').toLowerCase()==='order' &&
    engineOrderDay(order)===todayKey()
  );
}

function todayOrderGroups(){
  if(!window.OrderStateEngine){
    return [];
  }
  const today=todayKey();
  return window.OrderStateEngine.salesGroups(orders,integrations)
    .filter(group=>group.day===today);
}

function todayOrderUnits(){
  if(!window.OrderStateEngine?.salesUnits){
    return todayOrderGroups();
  }
  const today=todayKey();
  return window.OrderStateEngine.salesUnits(orders,integrations)
    .filter(unit=>unit.day===today);
}

function monthOrderUnits(){
  if(!window.OrderStateEngine?.salesUnits){
    return engineMonthGroups();
  }
  const month=monthKey();
  return window.OrderStateEngine.salesUnits(orders,integrations)
    .filter(unit=>String(unit.day||'').slice(0,7)===month);
}

function todayMarketSummary(){
  const result={};

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
  });

  todayOrderUnits().forEach(unit=>{
    if(result[unit.market]) result[unit.market].orders+=1;
  });

  todayOrderGroups().forEach(group=>{
    if(result[group.market]){
      result[group.market].sales+=Number(group.amount||0);
    }
  });

  // 상태 칸은 오늘 생성된 주문만이 아니라 현재 미처리 전체를 표시합니다.
  // 따라서 어제 접수된 반품/교환/문의도 완료 전까지 계속 남습니다.
  currentPendingItems().forEach(item=>{
    const market=item.market;
    const status=statusKey(item);

    if(result[market]&&status in result[market]){
      result[market][status]+=1;
    }
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
  const units=todayOrderUnits();

  return {
    count:units.length,
    sales:groups.reduce(
      (sum,group)=>sum+Number(group.amount||0),
      0
    )
  };
}

function correctedMonthTotals(){
  const groups=engineMonthGroups();
  const units=monthOrderUnits();

  return {
    count:units.length,
    sales:groups.reduce(
      (sum,group)=>sum+Number(group.amount||0),
      0
    )
  };
}


function connectedMarketNames(){
  return MARKETS
    .filter(([key])=>Boolean(integrations[key]?.connected))
    .map(([,name])=>name);
}

function disconnectedMarketNames(){
  return MARKETS
    .filter(([key])=>!Boolean(integrations[key]?.connected))
    .map(([,name])=>name);
}

function renderCoverageNote(){
  const target=document.getElementById('marketUpdated');
  if(!target) return;

  const excluded=disconnectedMarketNames();

  if(excluded.length){
    target.title=
      `미연결 제외: ${excluded.join(', ')}`;
  }else{
    target.removeAttribute('title');
  }
}


function renderIntegrations(){
  $('integrationGrid').innerHTML=MARKETS.map(([key,name])=>{const info=integrations[key]||{},ok=Boolean(info.connected);return`<div class="integration"><strong>${name}</strong><span class="connection ${ok?'ok':''}">${ok?'연결됨':'미연결'}</span><small>${relativeTime(info.lastRun)}</small></div>`}).join('');
  renderCoverageNote();
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
  const statusGrid=$('statusGrid');

  if(!statusGrid){
    return;
  }

  statusGrid.innerHTML=STATUS_ITEMS.map(
    ([key,label])=>`
      <button
        class="alert-card ${activeStatus===key?'active':''}"
        data-key="${key}"
      >
        <span>${label}</span>
        <strong>${Number(counts[key]||0)}</strong>
      </button>
    `
  ).join('');

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

  const info=$('dedupeInfo');

  if(info){
    info.textContent=
      '각 쇼핑몰 공식 API 직접검증 기준 · 실제 처리할 상품주문만 표시';
  }

  $('statusUpdated').textContent=
    '최근 갱신 '+
    new Date().toLocaleTimeString(
      'ko-KR',
      {hour:'2-digit',minute:'2-digit'}
    );
}
function renderMarkets(){
  const today=todayMarketSummary();

  $('marketBody').innerHTML=MARKETS.map(([key,name])=>{
    const data=today[name]||{};
    const connected=Boolean(integrations[key]?.connected);

    const metric=value=>connected?Number(value||0):'<span class="market-unlinked">-</span>';
    return `
      <tr
        class="market-row ${activeMarket===name?'selected':''} ${connected?'':'market-row-unlinked'}"
        data-market="${name}"
      >
        <td>
          <span class="market-name">
            <span class="market-dot ${connected?'ok':''}"></span>
            ${name}
            ${connected?'':'<small class="market-unlinked-label">미연동</small>'}
          </span>
        </td>
        <td class="order-sales-cell">
          ${connected
            ?`<strong>${Number(data.orders||0)}</strong><small>${fmt(data.sales||0)}</small>`
            :'<strong class="market-unlinked">-</strong><small>집계 제외</small>'}
        </td>
        <td>${metric(data.new)}</td>
        <td>${metric(data.shipping_wait)}</td>
        <td>${metric(data.cancel)}</td>
        <td>${metric(data.return)}</td>
        <td>${metric(data.exchange)}</td>
        <td>${metric(data.inquiry)}</td>
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

  const excluded=disconnectedMarketNames();
  $('marketUpdated').textContent=
    `오늘 ${todayKey()} 00:00부터 · `+
    new Date().toLocaleTimeString(
      'ko-KR',
      {hour:'2-digit',minute:'2-digit'}
    )+
    (excluded.length?` · 미연동 집계 제외 ${excluded.join(', ')}`:'');
}
function filteredOrders(){
  const q=$('searchInput').value.trim().toLowerCase();
  const market=$('marketFilter').value;
  const read=$('readFilter').value;

  return authoritativeCurrentStatusPerOrder().filter(order=>{
    const status=statusKey(order);

    if(activeStatus&&status!==activeStatus){
      return false;
    }

    if(activeMarket&&order.market!==activeMarket){
      return false;
    }

    if(market&&order.market!==market){
      return false;
    }

    const hit=!q||[
      order.product,
      order.orderNo,
      order.buyer,
      order.phone,
      order.invoiceNumber,
      order.workflowNote
    ].some(value=>
      String(value||'').toLowerCase().includes(q)
    );

    if(!hit){
      return false;
    }

    if(read==='unread'&&!isUnread(order)){
      return false;
    }

    if(read==='read'&&isUnread(order)){
      return false;
    }

    return true;
  }).sort((a,b)=>{
    const rank={
      cancel:1,
      return:2,
      exchange:3,
      inquiry:4,
      new:5,
      shipping_wait:6
    };

    if(statusKey(a)!==statusKey(b)){
      return (
        (rank[statusKey(a)]||9)-
        (rank[statusKey(b)]||9)
      );
    }

    return (
      authoritativeBusinessTime(b)-
      authoritativeBusinessTime(a)
    );
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
      <td data-label="금액">${fmt(displayOrderAmount(o))}</td>
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
    const allocated=allocatedGroupLineAmounts(group);
    group.lines.forEach((line,index)=>{
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
      products[name].sales+=Number(allocated[index]||0);
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


const ANALYTICS_MARKET_COLORS={
  '쿠팡':'#f97373',
  '스마트스토어':'#22c98b',
  '11번가':'#ff9f43',
  '롯데온':'#8b7cf6',
  'G마켓':'#31b46d',
  '옥션':'#ef5b72'
};

function hourlySvg(hourly){
  const width=760;
  const height=230;
  const pad={left:34,right:18,top:24,bottom:32};
  const chartW=width-pad.left-pad.right;
  const chartH=height-pad.top-pad.bottom;
  const max=Math.max(1,...hourly);
  const points=hourly.map((count,hour)=>({
    count,
    hour,
    x:pad.left+(chartW/23)*hour,
    y:pad.top+chartH-(count/max)*chartH
  }));
  const line=points.map((point,index)=>
    `${index?'L':'M'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`
  ).join(' ');
  const area=`M ${points[0].x.toFixed(1)} ${(pad.top+chartH).toFixed(1)} ${line.replace(/^M /,'L ')} L ${points.at(-1).x.toFixed(1)} ${(pad.top+chartH).toFixed(1)} Z`;
  const grid=[0,.25,.5,.75,1].map(rate=>{
    const y=pad.top+chartH-chartH*rate;
    return `<line x1="${pad.left}" y1="${y}" x2="${width-pad.right}" y2="${y}" class="chart-grid-line"/>`;
  }).join('');
  const labels=points.filter(point=>point.hour%3===0).map(point=>
    `<text x="${point.x}" y="${height-9}" text-anchor="middle" class="chart-axis-label">${point.hour}시</text>`
  ).join('');
  const dots=points.map(point=>
    `<circle cx="${point.x}" cy="${point.y}" r="${point.count?4:2.2}" class="chart-point ${point.count?'has-value':''}"><title>${point.hour}시 · ${point.count}건</title></circle>`
  ).join('');

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="시간대별 주문 그래프">
    <defs>
      <linearGradient id="orderAreaGradient" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="#2588e8" stop-opacity=".28"/>
        <stop offset="100%" stop-color="#2588e8" stop-opacity=".02"/>
      </linearGradient>
      <linearGradient id="orderLineGradient" x1="0" x2="1">
        <stop offset="0%" stop-color="#0f6fbd"/>
        <stop offset="100%" stop-color="#26b5a0"/>
      </linearGradient>
    </defs>
    ${grid}
    <path d="${area}" fill="url(#orderAreaGradient)"/>
    <path d="${line}" class="chart-line"/>
    ${dots}
    ${labels}
  </svg>`;
}

function renderTodayAnalytics(){
  const groups=todayOrderGroups();
  const hourly=Array.from({length:24},()=>0);
  groups.forEach(group=>{
    const date=group.date;
    if(!date?.getTime?.()) return;
    const hour=Number(new Intl.DateTimeFormat('en-GB',{
      timeZone:'Asia/Seoul',hour:'2-digit',hour12:false
    }).format(date));
    if(hour>=0&&hour<24) hourly[hour]+=1;
  });

  const totalSales=groups.reduce((sum,group)=>sum+Number(group.amount||0),0);
  const units=todayOrderUnits();
  const averageOrder=units.length?Math.round(totalSales/units.length):0;
  const peakCount=Math.max(0,...hourly);
  const peakHour=peakCount?hourly.indexOf(peakCount):null;
  const pending=engineUnresolvedCounts();
  const pendingTotal=Object.values(pending).reduce((sum,value)=>sum+Number(value||0),0);

  const marketSales={};
  groups.forEach(group=>{
    marketSales[group.market]=Number(marketSales[group.market]||0)+Number(group.amount||0);
  });
  const marketEntries=Object.entries(marketSales).sort((a,b)=>b[1]-a[1]);
  const topMarket=marketEntries[0]?.[0]||'-';
  const topMarketSales=Number(marketEntries[0]?.[1]||0);

  const kpis=$('analysisKpis');
  if(kpis){
    kpis.innerHTML=[
      ['피크 시간',peakHour==null?'-':`${peakHour}시`,peakCount?`${peakCount}건 집중`:'주문 대기','kpi-blue'],
      ['평균 주문금액',fmt(averageOrder),`${units.length}건 기준`,'kpi-mint'],
      ['매출 1위',topMarket,fmt(topMarketSales),'kpi-violet'],
      ['현재 처리중',`${pendingTotal}건`,`신규 ${pending.new} · 발송 ${pending.shipping_wait}`,'kpi-orange']
    ].map(([label,value,note,tone])=>`<div class="analysis-kpi ${tone}"><span>${label}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div>`).join('');
  }

  $('hourChart').innerHTML=hourlySvg(hourly);
  const summary=$('hourChartSummary');
  if(summary){
    summary.textContent=peakHour==null
      ?'오늘 주문이 들어오면 시간대별 흐름이 표시됩니다.'
      :`${peakHour}시대에 ${peakCount}건으로 가장 주문이 많았습니다.`;
  }

  const donut=$('marketDonut');
  const denominator=totalSales||1;
  let cursor=0;
  const segments=marketEntries.map(([market,sales])=>{
    const start=cursor;
    const end=cursor+(Number(sales)/denominator*100);
    cursor=end;
    return `${ANALYTICS_MARKET_COLORS[market]||'#7b8ca5'} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
  });
  if(donut){
    donut.style.background=segments.length
      ?`conic-gradient(${segments.join(',')})`
      :'conic-gradient(#e7edf4 0 100%)';
    const share=topMarketSales/denominator*100;
    donut.innerHTML=`<div><strong>${marketEntries.length?Math.round(share):0}%</strong><span>${escapeHtml(topMarket)}</span></div>`;
  }

  $('marketShare').innerHTML=marketEntries.map(([market,sales])=>{
    const share=Number(sales)/denominator*100;
    const color=ANALYTICS_MARKET_COLORS[market]||'#7b8ca5';
    return `<div class="share-row">
      <span class="share-market"><i style="background:${color}"></i>${escapeHtml(market)}</span>
      <strong>${fmt(sales)}</strong>
      <span class="share-value">${Math.round(share)}%</span>
    </div>`;
  }).join('')||'<span class="analytics-empty">오늘 주문이 없습니다.</span>';

  const products={};
  groups.forEach(group=>{
    const allocated=allocatedGroupLineAmounts(group);
    group.lines.forEach((line,index)=>{
      const name=line.product||'상품명 없음';
      if(!products[name]) products[name]={orders:new Set(),qty:0,sales:0};
      products[name].orders.add(group.key);
      products[name].qty+=Number(line.qty||1);
      products[name].sales+=Number(allocated[index]||0);
    });
  });
  const productRows=Object.entries(products)
    .map(([name,value])=>[name,{orders:value.orders.size,qty:value.qty,sales:value.sales}])
    .sort((a,b)=>b[1].orders-a[1].orders||b[1].sales-a[1].sales)
    .slice(0,20);
  const maxProductScore=Math.max(1,...productRows.map(([,value])=>value.orders*1000000+value.sales));
  $('todayTopProducts').innerHTML=productRows.map(([name,value],index)=>{
    const score=value.orders*1000000+value.sales;
    const width=Math.max(5,Math.round(score/maxProductScore*100));
    return `<div class="top-row">
      <span class="top-no">${index+1}</span>
      <div class="top-product-main"><strong>${escapeHtml(name)}</strong><small>${value.orders}건 · ${value.qty}개</small><i style="width:${width}%"></i></div>
      <strong class="top-sales">${fmt(value.sales)}</strong>
    </div>`;
  }).join('')||'<span class="analytics-empty">오늘 판매 상품이 없습니다.</span>';
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
    ['배송메모',o.deliveryMemo||''],['금액',fmt(displayOrderAmount(o))],
    ['주문시간',dateValue(o).replace('T',' ').slice(0,19)],
    ['택배사',o.deliveryCompanyName||''],['운송장번호',o.invoiceNumber||''],
    ['사유',o.reason||''],['상세사유',o.reasonDetail||'']
  ];

  $('detailGrid').innerHTML=fields.map(([k,v])=>`<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
  $('detailNote').value=o.workflowNote||'';
  $('detailDialog').showModal();
}

function clampCollectPercent(value){
  const number=Number(value);
  if(!Number.isFinite(number)) return 0;
  return Math.max(0,Math.min(100,Math.round(number)));
}

function renderCollectProgress(data={}){
  const status=String(data.status||'idle');
  const running=status==='requested'||status==='running';
  const success=status==='success';
  const failed=status==='error';
  const percent=success?100:clampCollectPercent(data.progressPercent);
  const remaining=Math.max(0,100-percent);
  const step=String(data.progressStep||'').trim();
  const button=$('collectNowBtn');
  const note=$('collectStatus');
  const track=$('collectProgress');
  const bar=$('collectProgressBar');

  if(!button||!note||!track||!bar) return;

  track.classList.toggle('active',running);
  track.classList.toggle('done',success);
  track.classList.toggle('error',failed);
  bar.style.width=`${percent}%`;
  track.setAttribute('aria-valuenow',String(percent));
  track.setAttribute('aria-label',`주문 수집 진행률 ${percent}%`);

  if(running){
    button.disabled=true;
    button.textContent=`수집 ${percent}%`;
    note.textContent=`${percent}% 완료 · ${remaining}% 남음${step?` · ${step}`:''}`;
    return;
  }

  button.disabled=false;
  button.textContent='지금 수집';

  if(success){
    note.textContent=`수집 완료 · 100%${step?` · ${step}`:''}`;
  }else if(failed){
    note.textContent=`수집 오류 · PC 확인${step?` · ${step}`:''}`;
  }else{
    note.textContent='자동 확인 중';
    bar.style.width='0%';
  }
}

async function requestCollect(){
  if(!db||!currentUser){
    toast('클라우드 자동 연결을 다시 시도합니다.');
    initCloud(true);
    return;
  }

  renderCollectProgress({
    status:'requested',
    progressPercent:0,
    progressStep:'PC 수집기 응답 대기'
  });

  try{
    await db.collection('system')
      .doc('commands')
      .collection('requests')
      .doc('coupang')
      .set({
        requestId:
          `${currentUser.uid}-${Date.now()}`,
        market:'coupang',
        action:'collect',
        reason:'manual-fast-current-sync',
        requestedBy:currentUser.uid,
        requestedAt:
          firebase.firestore.FieldValue.serverTimestamp(),
        status:'requested',
        progressPercent:0,
        remainingPercent:100,
        progressStep:'PC 수집기 응답 대기',
        progressUpdatedAt:
          firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt:
          firebase.firestore.FieldValue.serverTimestamp()
      },{merge:true});
  }catch(error){
    renderCollectProgress({
      status:'error',
      progressStep:readableCloudError(error)
    });
    initCloud(true);
  }
}

function watchCollect(){
  if(collectUnsub) collectUnsub();
  collectUnsub=db.collection('system')
    .doc('commands')
    .collection('requests')
    .doc('coupang')
    .onSnapshot(doc=>{
      if(!doc.exists){
        renderCollectProgress();
        return;
      }
      renderCollectProgress(doc.data()||{});
    },()=>renderCollectProgress({status:'error',progressStep:'클라우드 연결 확인'}));
}


const ORDER_CACHE_KEY='alldaypick-orders-cache-v770';
const INTEGRATION_CACHE_KEY='alldaypick-integrations-cache-v770';

for(const legacyKey of [
  'alldaypick-orders-cache-v764',
  'alldaypick-integrations-cache-v764',
  'alldaypick-orders-cache-v760',
  'alldaypick-integrations-cache-v760',
  'alldaypick-orders-cache-v740',
  'alldaypick-integrations-cache-v740',
  'alldaypick-orders-cache-v72',
  'alldaypick-integrations-cache-v71'
]){
  try{localStorage.removeItem(legacyKey);}catch{}
}

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

      if(age<=6*60*1000){
        indicator.textContent=
          `PC 수집기 정상 · ${relativeTime(new Date(Date.now()-age).toISOString())}`;
        indicator.classList.add('ok');
      }else if(age<=12*60*1000){
        indicator.textContent=
          `PC 수집기 지연 · ${relativeTime(new Date(Date.now()-age).toISOString())}`;
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

      if(age<25*60*1000){
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

  if(unsubscribeActiveOrders){
    unsubscribeActiveOrders();
    unsubscribeActiveOrders=null;
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

function monthStartIso(){
  return `${monthKey()}-01T00:00:00+09:00`;
}

function refreshOrdersFromCloudMaps(){
  const merged=new Map(monthOrderMap);
  for(const [id,item] of activeOrderMap){
    merged.set(id,item);
  }
  orders=[...merged.values()]
    .sort((a,b)=>timestampValue(b)-timestampValue(a));
  saveCloudCache();
  render();
}

function replaceSnapshotMap(target,snapshot){
  target.clear();
  snapshot.docs.forEach(doc=>{
    target.set(doc.id,{id:doc.id,...doc.data()});
  });
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

  // 무료 한도 보호: 월 통계에 필요한 이번 달 문서만 구독합니다.
  // 오래된 미완료 주문/클레임은 아래 activeState 구독으로 보완합니다.
  unsubscribeOrders=db.collection('orders')
    .where('datetime','>=',monthStartIso())
    .orderBy('datetime','desc')
    .limit(1300)
    .onSnapshot(
      snapshot=>{
        replaceSnapshotMap(monthOrderMap,snapshot);
        refreshOrdersFromCloudMaps();
        cloudMessage(
          snapshot.metadata.fromCache
            ?'클라우드 연결됨 · 캐시 동기화 중'
            :'클라우드 연결됨 · 무료한도 모드',
          true
        );
      },
      error=>{
        console.error('Monthly order listener error:',error);
        cloudMessage(
          orders.length
            ?'월 주문 재연결 중 · 저장된 데이터 표시'
            :'월 주문 연결 오류 · '+readableCloudError(error),
          false
        );
        retryCloud(60000);
      }
    );

  unsubscribeActiveOrders=db.collection('orders')
    .where('activeState','==',true)
    .limit(300)
    .onSnapshot(
      snapshot=>{
        replaceSnapshotMap(activeOrderMap,snapshot);
        refreshOrdersFromCloudMaps();
      },
      error=>{
        console.error('Active order listener error:',error);
        cloudMessage(
          orders.length
            ?'미완료 주문 재연결 중 · 저장된 데이터 표시'
            :'미완료 주문 연결 오류 · '+readableCloudError(error),
          false
        );
        retryCloud(60000);
      }
    );

  integrationUnsubscribe=db.collection('system')
    .doc('integrations')
    .onSnapshot(
      snapshot=>{
        integrations=snapshot.exists?snapshot.data():{};
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
    .finally(()=>navigator.serviceWorker.register('./sw.js?v=final-v7.7.14-final',{updateViaCache:'none'}))
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
let renderedKoreaMonth=monthKey();

setInterval(()=>{
  const currentDay=todayKey();

  if(currentDay!==renderedKoreaDay){
    renderedKoreaDay=currentDay;
    currentPage=1;
    activeStatus='';
    activeMarket='';
    render();
    if(monthKey()!==renderedKoreaMonth){
      renderedKoreaMonth=monthKey();
      if(db) startCloudListeners();
    }
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
  maxLoadedOrders:1600,
  listenerReconnectMs:60000,
  mode:'무료 한도 보호'
};

function renderFreeModeBadge(){
  const badge=document.getElementById('versionBadge');

  if(
    badge &&
    !badge.textContent.includes('무료한도')
  ){
    badge.textContent+=' · 무료한도 최적화';
  }
}


document.addEventListener('DOMContentLoaded',renderFreeModeBadge);
