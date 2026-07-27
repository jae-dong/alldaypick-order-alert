function asDate(value){
  if(!value) return null;

  if(value instanceof Date){
    return Number.isFinite(value.getTime())?value:null;
  }

  if(typeof value?.toDate==='function'){
    const converted=value.toDate();
    return converted instanceof Date&&Number.isFinite(converted.getTime())
      ?converted
      :null;
  }

  if(typeof value==='number'){
    const milliseconds=value<1e12?value*1000:value;
    const converted=new Date(milliseconds);
    return Number.isFinite(converted.getTime())?converted:null;
  }

  const text=String(value).trim();
  if(!text) return null;

  if(/^\d{14}$/.test(text)){
    const year=Number(text.slice(0,4));
    const month=Number(text.slice(4,6));
    const day=Number(text.slice(6,8));
    const hour=Number(text.slice(8,10));
    const minute=Number(text.slice(10,12));
    const second=Number(text.slice(12,14));
    const converted=new Date(Date.UTC(year,month-1,day,hour-9,minute,second));
    return Number.isFinite(converted.getTime())?converted:null;
  }

  if(/^\d{12}$/.test(text)){
    const year=Number(text.slice(0,4));
    const month=Number(text.slice(4,6));
    const day=Number(text.slice(6,8));
    const hour=Number(text.slice(8,10));
    const minute=Number(text.slice(10,12));
    const converted=new Date(Date.UTC(year,month-1,day,hour-9,minute,0));
    return Number.isFinite(converted.getTime())?converted:null;
  }

  let normalized=text;

  // 시간대 정보가 없는 쇼핑몰 시각은 한국시간으로 해석합니다.
  if(
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(text)
  ){
    normalized=`${text.replace(' ','T')}+09:00`;
  }

  const converted=new Date(normalized);
  return Number.isFinite(converted.getTime())?converted:null;
}

function firstOrderDate(order){
  const values=[
    order?.orderDate,
    order?.orderAt,
    order?.orderedAt,
    order?.paymentDate,
    order?.paymentAt
  ];

  // 일반 주문 문서는 datetime이 실제 주문시각이므로 마지막 후보로 사용합니다.
  if(String(order?.eventType||'order')==='order'){
    values.push(order?.datetime);
  }

  for(const value of values){
    const converted=asDate(value);
    if(converted) return converted;
  }

  return null;
}

export function formatTelegramOrderDate(order){
  const date=firstOrderDate(order);
  if(!date) return '';

  const parts=new Intl.DateTimeFormat('en-CA',{
    timeZone:'Asia/Seoul',
    year:'numeric',
    month:'2-digit',
    day:'2-digit',
    hour:'2-digit',
    minute:'2-digit',
    hourCycle:'h23'
  }).formatToParts(date);

  const map=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  if(!map.year||!map.month||!map.day||!map.hour||!map.minute) return '';

  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
}

function positiveMoney(...values){
  for(const value of values.flat(Infinity)){
    if(value==null||value==='') continue;
    let number;
    if(typeof value==='object'&&value){
      number=Number(value.units||0)+Number(value.nanos||0)/1e9;
    }else{
      number=Number(String(value).replace(/[^0-9.-]/g,''));
    }
    if(Number.isFinite(number)&&number>0) return Math.round(number);
  }
  return 0;
}

function telegramAmount(order={}){
  const direct=positiveMoney(
    order.amount,order.lineAmount,order.lineTotalAmount,order.itemAmount,
    order.productAmount,order.salePrice,order.totalProductAmount,
    order.orderTotalAmount,order.totalAmount,order.paymentAmount,
    order.totalPaymentAmount,order.realPayAmt,order.ordPayAmt,order.payAmt
  );
  if(direct>0) return direct;
  const unit=positiveMoney(
    order.unitPrice,order.itemPrice,order.orderItemUnitPrice,
    order.salePrc,order.sellPrc,order.selPrc,order.price
  );
  return unit*Math.max(1,Number(order.qty||order.quantity||1));
}

function telegramDetailText(value,maxLength=700){
  const text=String(value??'')
    .replace(/\r\n?/g,'\n')
    .replace(/[ \t]+\n/g,'\n')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
  if(text.length<=maxLength) return text;
  return `${text.slice(0,Math.max(0,maxLength-1)).trim()}…`;
}

function telegramEventType(order={}){
  const eventType=String(order.eventType||'').trim().toLowerCase();
  const status=String(order.status||'').trim().toLowerCase();
  if(eventType==='inquiry'||status==='inquiry') return 'inquiry';
  if(eventType==='return'||status.includes('return')) return 'return';
  if(eventType==='exchange'||status.includes('exchange')) return 'exchange';
  if(eventType==='cancel'||status.includes('cancel')) return 'cancel';
  return 'order';
}

export function telegramOrderBody(order){
  const orderedAt=formatTelegramOrderDate(order);
  const amount=telegramAmount(order);
  const type=telegramEventType(order);
  const reason=telegramDetailText(
    order?.reason||order?.reasonText||order?.claimReason||order?.reasonCodeText||''
  );
  const reasonDetail=telegramDetailText(
    order?.reasonDetail||order?.claimDetailedReason||order?.claimReasonDetail||
    order?.reasonEtcDetail||order?.reasonMemo||''
  );
  const inquiryContent=telegramDetailText(
    order?.content||order?.inquiryContent||order?.question||order?.questionContent||''
  );
  const detailLines=[];

  if(type==='inquiry'){
    if(reason) detailLines.push(`📂 문의유형: ${reason}`);
    if(inquiryContent) detailLines.push(`💬 문의내용: ${inquiryContent}`);
  }else if(type==='return'){
    if(reason) detailLines.push(`↩️ 반품사유: ${reason}`);
    if(reasonDetail) detailLines.push(`📝 상세사유: ${reasonDetail}`);
  }else if(type==='exchange'){
    if(reason) detailLines.push(`🔄 교환사유: ${reason}`);
    if(reasonDetail) detailLines.push(`📝 상세사유: ${reasonDetail}`);
  }else if(type==='cancel'){
    if(reason) detailLines.push(`❌ 취소사유: ${reason}`);
    if(reasonDetail) detailLines.push(`📝 상세사유: ${reasonDetail}`);
  }

  const lines=[
    `📦 ${String(order?.product||'상품명 없음').replace(/\s+/g,' ').trim()}`,
    order?.option?`⚙️ 옵션: ${order.option}`:'',
    `🔢 수량: ${Number(order?.qty||1)}개`,
    `💰 금액: ${Number(amount||0).toLocaleString('ko-KR')}원`,
    order?.buyer?`👤 구매자: ${order.buyer}`:'',
    order?.orderNo?`🧾 주문번호: ${order.orderNo}`:'',
    orderedAt?`🕒 주문일시: ${orderedAt}`:'',
    ...detailLines
  ].filter(Boolean);

  return lines.join('\n');
}

export const telegramFormatTestHelpers={positiveMoney,telegramAmount,telegramDetailText,telegramEventType};
