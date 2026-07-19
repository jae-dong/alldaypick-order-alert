(function(root){
  'use strict';

  const CLAIM_TYPES=new Set(['cancel','return','exchange','inquiry']);
  const PENDING_ORDER_STATUSES=new Set(['new','shipping_wait']);

  function text(value){return String(value??'').trim();}
  function normalized(value){return text(value).toLowerCase().replace(/\s+/g,' ');}
  function time(value){
    if(!value)return 0;
    if(typeof value?.toDate==='function'){
      const n=value.toDate().getTime();
      return Number.isFinite(n)?n:0;
    }
    if(typeof value?.toMillis==='function'){
      const n=value.toMillis();
      return Number.isFinite(n)?n:0;
    }
    const n=new Date(value).getTime();
    return Number.isFinite(n)?n:0;
  }
  function timestamp(item){
    const candidates=[
      item?.sourceUpdatedAt,item?.lastChangedAt,item?.statusChangedAt,
      item?.modifiedAt,item?.updatedAt,item?.syncedAt,item?.createdAt,
      item?.datetime,item?.orderDate,item?.paymentDate
    ].map(time).filter(Boolean);
    return candidates.length?Math.max(...candidates):0;
  }
  function market(item){return text(item?.market||item?.source||'기타');}
  function orderNo(item){return text(item?.orderNo||item?.orderId||item?.shipmentBoxId||item?.deliveryNo||item?.id);}
  function orderKey(item){return text(item?.orderKey)||`${normalized(market(item))}|${normalized(orderNo(item))}`;}
  function lineKey(item){
    if(item?.lineKey)return text(item.lineKey);
    const line=text(
      item?.productOrderId||item?.orderProductSequence||item?.orderItemId||
      item?.vendorItemId||item?.deliveryNo||item?.shipmentBoxId||
      item?.productNo||item?.itemId||item?.sku||item?.product||item?.id
    );
    return `${orderKey(item)}|${normalized(line)||'item'}`;
  }
  function eventType(item){
    const workflow=text(item?.workflowType).toLowerCase();
    if(workflow==='order')return 'order';
    if(workflow==='inquiry')return 'inquiry';
    const event=text(item?.eventType||'order').toLowerCase();
    return CLAIM_TYPES.has(event)?event:'order';
  }
  function claimKey(item){
    const explicit=normalized(
      item?.claimId||item?.receiptId||item?.exchangeId||
      item?.inquiryId||item?.questionId
    );
    if(explicit){
      return [normalized(market(item)),eventType(item),explicit].join('|');
    }
    const stored=text(item?.claimKey);
    if(stored){
      const parts=stored.split('|');
      return parts.length>=3?parts.slice(0,3).join('|'):stored;
    }
    return [normalized(market(item)),eventType(item),normalized(item?.id)].join('|');
  }
  function sourceText(item){
    return [
      item?.sourceStatus,item?.status,item?.statusLabel,item?.claimStatus,
      item?.processingStatus,item?.resultStatus,item?.receiptStatus,
      item?.exchangeStatus,item?.inquiryStatus,item?.partnerCounselingStatus,
      item?.csPartnerCounselingStatus,
      item?.placeOrderStatus,item?.lastChangedType,
      item?.deliveryStatus,item?.deliveryStatusName
    ].filter(Boolean).join(' ').toUpperCase();
  }
  function status(item){
    const event=eventType(item);
    if(CLAIM_TYPES.has(event))return event;

    const raw=sourceText(item);
    const current=text(item?.status).toLowerCase();
    const placeOrderStatus=text(item?.placeOrderStatus).toUpperCase();
    const hasPlaceOrder=Boolean(
      item?.placeOrderDate||
      placeOrderStatus==='OK'||
      raw.includes('PLACE_ORDER')||
      raw.includes('ORDER_CONFIRM')
    );

    // The market's current source status wins over an older normalized status.
    if(raw.includes('PURCHASE_DECIDED')||raw.includes('PURCHASE_CONFIRM'))return 'purchase_confirmed';
    if(raw.includes('FINAL_DELIVERY')||raw.includes('DELIVERED')||raw.includes('배송완료'))return 'delivered';
    if(
      raw.includes('DELIVERING')||raw.includes('SHIPPED')||
      raw.includes('DISPATCHED')||raw.includes('DEPARTURE')||
      raw.includes('배송중')||raw.includes('발송처리')
    )return 'delivering';
    if(raw.includes('CANCELED')||raw.includes('CANCELLED')||raw.includes('취소완료'))return 'cancelled';
    if(raw.includes('RETURNED')||raw.includes('RETURN_DONE')||raw.includes('반품완료'))return 'returned';
    if(
      hasPlaceOrder||raw.includes('INSTRUCT')||raw.includes('PRODUCT_PREPARE')||
      raw.includes('PREPARE_DELIVERY')||raw.includes('DISPATCH_WAITING')||
      raw.includes('PACKAGING')||raw.includes('READY_FOR_SHIPPING')||
      raw.includes('배송준비')||raw.includes('발송대기')||raw.includes('발주확인')
    )return 'shipping_wait';
    if(raw.includes('ACCEPT')||raw.includes('PAYED')||raw.includes('PAYMENT_WAITING')||raw.includes('ORDER_RECEIVED'))return 'new';

    if(current==='departure')return (item?.invoiceNumber||item?.trackingNumber)?'delivering':'shipping_wait';
    if(['new','shipping_wait','delivering','delivered','purchase_confirmed','cancelled','canceled','returned'].includes(current)){
      return current==='canceled'?'cancelled':current;
    }
    return current||'unknown';
  }
  function terminalClaim(item){
    if(item?.activeState===false||item?.answered===true)return true;
    const raw=sourceText(item);
    const tokens=new Set(raw.split(/[^A-Z0-9_가-힣]+/).filter(Boolean));
    const exact=[
      'CC','RETURNS_COMPLETED','ANSWER','ANSWERED','COMPLETE','COMPLETED',
      'CLOSED','DONE','FINISH','FINISHED','WITHDRAW','WITHDRAWN',
      'REJECT','REJECTED','CANCELLED','CANCELED','EXCHANGED','RETURNED'
    ];
    if(exact.some(word=>tokens.has(word)))return true;
    const structured=[
      'CANCEL_DONE','CANCEL_COMPLETE','CANCEL_COMPLETED',
      'RETURN_DONE','RETURN_COMPLETE','RETURN_COMPLETED',
      'EXCHANGE_DONE','EXCHANGE_COMPLETE','EXCHANGE_COMPLETED',
      'CLAIM_DONE','CLAIM_COMPLETE','CLAIM_COMPLETED',
      'ANSWER_DONE','ANSWER_COMPLETE','ANSWER_COMPLETED',
      'REQUEST_CANCELLED','REQUEST_CANCELED',
      'CANCEL_REJECT','RETURN_REJECT','EXCHANGE_REJECT',
      'ADMIN_CANCEL_DONE','ADMIN_CANCEL_REJECT'
    ];
    if(structured.some(word=>tokens.has(word)))return true;
    return [
      '처리완료','취소완료','반품완료','교환완료','답변완료',
      '철회','거부','종결','완료처리','요청철회','반품철회','교환철회'
    ].some(word=>raw.includes(word));
  }
  function included(item,integrations){
    const m=market(item);
    const key={쿠팡:'coupang',스마트스토어:'smartstore','11번가':'elevenst',G마켓:'gmarket',옥션:'auction',롯데온:'lotteon'}[m];
    if(!key)return true;
    // G마켓/옥션은 연결 상태가 명시적으로 true일 때만 포함합니다.
    if(key==='gmarket'||key==='auction')return integrations?.[key]?.connected===true;
    return integrations?.[key]?.connected!==false;
  }
  function latestBy(items,keyFn){
    const map=new Map();
    for(const item of items){
      const key=keyFn(item);
      const current=map.get(key);
      if(!current||timestamp(item)>=timestamp(current))map.set(key,item);
    }
    return [...map.values()];
  }
  function latestOrderLines(items,integrations){
    return latestBy(
      items.filter(item=>eventType(item)==='order'&&included(item,integrations)),
      lineKey
    );
  }
  function latestClaims(items,integrations){
    return latestBy(
      items.filter(item=>CLAIM_TYPES.has(eventType(item))&&included(item,integrations)),
      claimKey
    );
  }
  function statusRank(value){return {new:1,shipping_wait:2,delivering:3,delivered:4,purchase_confirmed:5,cancelled:6,returned:6}[value]||0;}
  function groupOrders(lines){
    const groups=new Map();
    for(const line of lines){
      const key=orderKey(line);
      if(!groups.has(key))groups.set(key,{key,market:market(line),orderNo:orderNo(line),lines:[],qty:0,amount:0,explicitTotal:0,representative:line});
      const group=groups.get(key);
      group.lines.push(line);
      group.qty+=Number(line?.qty||1);
      const explicit=Number(line?.orderTotalAmount||line?.totalAmount||line?.paymentAmount||0);
      if(Number.isFinite(explicit)&&explicit>0)group.explicitTotal=Math.max(group.explicitTotal,explicit);
      else group.amount+=Math.max(0,Number(line?.amount||line?.salePrice||0));
      const current=group.representative;
      const lineRank=statusRank(status(line));
      const currentRank=statusRank(status(current));
      if(lineRank>currentRank||(lineRank===currentRank&&timestamp(line)>timestamp(current)))group.representative=line;
    }
    return [...groups.values()].map(group=>{
      const pendingNew=group.lines.filter(line=>status(line)==='new').sort((a,b)=>timestamp(b)-timestamp(a));
      const pendingShipping=group.lines.filter(line=>status(line)==='shipping_wait').sort((a,b)=>timestamp(b)-timestamp(a));
      const representative=pendingNew[0]||pendingShipping[0]||group.representative;
      return {
        ...representative,
        ...group,
        representative,
        amount:group.explicitTotal||group.amount,
        status:status(representative),
        eventType:'order',
        workflowType:'order'
      };
    });
  }
  function workUnitKey(item){
    const source=normalized(market(item)||item?.source);
    if(source==='쿠팡'||normalized(item?.source)==='coupang'){
      return `coupang|${normalized(item?.shipmentBoxId||orderNo(item))}`;
    }
    if(source==='스마트스토어'||normalized(item?.source)==='smartstore'){
      return `smartstore|${normalized(item?.productOrderId||lineKey(item))}`;
    }
    if(source==='11번가'||normalized(item?.source)==='elevenst'){
      return `elevenst|${normalized(orderNo(item))}|${normalized(item?.orderProductSequence||item?.ordPrdSeq||'item')}`;
    }
    if(source==='롯데온'||normalized(item?.source)==='lotteon'){
      return `lotteon|${normalized(item?.orderItemId||item?.orderProductSequence||lineKey(item))}`;
    }
    return lineKey(item);
  }
  function pendingOrderUnits(items,integrations){
    const groups=new Map();
    for(const line of latestOrderLines(items,integrations)){
      const key=workUnitKey(line);
      const current=groups.get(key);
      if(!current){
        groups.set(key,{...line,status:status(line),workUnitKey:key,lines:[line]});
        continue;
      }
      current.lines.push(line);
      const nextRank=statusRank(status(line));
      const currentRank=statusRank(status(current));
      if(nextRank>currentRank||(nextRank===currentRank&&timestamp(line)>timestamp(current))){
        groups.set(key,{...line,status:status(line),workUnitKey:key,lines:current.lines});
      }
    }
    return [...groups.values()].filter(unit=>
      unit.activeState!==false&&PENDING_ORDER_STATUSES.has(status(unit))
    );
  }
  function pendingOrders(items,integrations){
    return pendingOrderUnits(items,integrations);
  }
  function openClaims(items,integrations){
    return latestClaims(items,integrations).filter(item=>!terminalClaim(item));
  }
  function pendingItems(items,integrations){return [...pendingOrders(items,integrations),...openClaims(items,integrations)];}
  function counts(items,integrations){
    const out={new:0,shipping_wait:0,cancel:0,return:0,exchange:0,inquiry:0};
    for(const item of pendingItems(items,integrations)){
      const key=eventType(item)==='order'?status(item):eventType(item);
      if(Object.prototype.hasOwnProperty.call(out,key))out[key]+=1;
    }
    return out;
  }
  function orderDate(item){
    const values=[item?.orderDate,item?.orderAt,item?.orderedAt,item?.paymentDate,item?.paymentAt,item?.datetime,item?.createdAt];
    for(const value of values){const n=time(value);if(n)return new Date(n);}
    return new Date(0);
  }
  function salesGroups(items,integrations){
    const groups=groupOrders(latestOrderLines(items,integrations));
    return groups.map(group=>{
      const dates=group.lines.map(orderDate).filter(d=>d.getTime());
      const date=dates.length?new Date(Math.min(...dates.map(d=>d.getTime()))):new Date(0);
      return {...group,date,day:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(date)};
    });
  }

  root.OrderStateEngine={
    status,eventType,terminalClaim,latestOrderLines,latestClaims,
    pendingOrders,pendingOrderUnits,openClaims,pendingItems,counts,salesGroups,groupOrders,workUnitKey,
    orderKey,lineKey,claimKey,timestamp,market,included
  };
})(typeof window!=='undefined'?window:globalThis);
