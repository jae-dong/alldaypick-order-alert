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

export function telegramOrderBody(order){
  const orderedAt=formatTelegramOrderDate(order);
  const lines=[
    `📦 ${String(order?.product||'상품명 없음').replace(/\s+/g,' ').trim()}`,
    order?.option?`⚙️ 옵션: ${order.option}`:'',
    `🔢 수량: ${Number(order?.qty||1)}개`,
    `💰 금액: ${Number(order?.amount||0).toLocaleString('ko-KR')}원`,
    order?.buyer?`👤 구매자: ${order.buyer}`:'',
    order?.orderNo?`🧾 주문번호: ${order.orderNo}`:'',
    orderedAt?`🕒 주문일시: ${orderedAt}`:'',
    order?.reason?`📝 사유: ${order.reason}`:'',
    order?.reasonDetail?`📝 상세: ${order.reasonDetail}`:''
  ].filter(Boolean);

  return lines.join('\n');
}
