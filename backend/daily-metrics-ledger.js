import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const BACKEND_DIR=path.dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH=path.join(BACKEND_DIR,'.daily-order-ledger-v2.json');
const SOURCES=[
  ['coupang','쿠팡'],
  ['smartstore','스마트스토어'],
  ['elevenst','11번가'],
  ['lotteon','롯데온']
];
const MAX_SOURCE_DOCS=2500;

function text(value){return String(value??'').trim();}
function normalized(value){return text(value).toLowerCase().replace(/\s+/g,' ');}
function money(value){
  if(value==null||value==='') return 0;
  if(typeof value==='object'){
    const amount=Number(value.units||0)+Number(value.nanos||0)/1e9;
    return Number.isFinite(amount)&&amount>0?amount:0;
  }
  const amount=Number(String(value).replace(/[^0-9.-]/g,''));
  return Number.isFinite(amount)&&amount>0?amount:0;
}
function dateValue(value){
  if(!value) return new Date(0);
  if(typeof value?.toDate==='function'){
    const date=value.toDate();
    return Number.isNaN(date.getTime())?new Date(0):date;
  }
  const date=new Date(value);
  return Number.isNaN(date.getTime())?new Date(0):date;
}
export function kstDay(value=new Date()){
  const date=value instanceof Date?value:dateValue(value);
  if(!date.getTime()) return '';
  return new Intl.DateTimeFormat('sv-SE',{
    timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'
  }).format(date);
}
function encodedOrderDate(orderNo=''){
  const match=text(orderNo).match(/(20\d{2})(0[1-9]|1[0-2])([0-2]\d|3[01])/);
  if(!match) return new Date(0);
  return dateValue(`${match[1]}-${match[2]}-${match[3]}T12:00:00+09:00`);
}
function businessDate(item){
  const source=normalized(item?.source||item?.market);
  const encoded=encodedOrderDate(item?.orderNo||item?.orderId);
  if((source==='elevenst'||source==='11번가')&&encoded.getTime()) return encoded;
  for(const value of [
    item?.metricDate,item?.businessDate,item?.orderDate,item?.orderAt,item?.orderedAt,
    item?.paymentDate,item?.paymentAt,item?.paidAt,item?.orderDateTime,item?.paymentDateTime,
    item?.datetime,item?.createdAt
  ]){
    const date=dateValue(value);
    if(date.getTime()) return date;
  }
  return encoded;
}
function marketName(item,source=''){
  const raw=text(item?.market||item?.source||source);
  const key=normalized(raw);
  if(key==='coupang'||key==='쿠팡') return '쿠팡';
  if(key==='smartstore'||key==='스마트스토어') return '스마트스토어';
  if(key==='elevenst'||key==='11번가') return '11번가';
  if(key==='lotteon'||key==='롯데온') return '롯데온';
  return raw||'기타';
}
function sourceName(item,source=''){
  const raw=normalized(item?.source||source||item?.market);
  if(raw==='쿠팡') return 'coupang';
  if(raw==='스마트스토어') return 'smartstore';
  if(raw==='11번가') return 'elevenst';
  if(raw==='롯데온') return 'lotteon';
  return raw;
}
function excluded(item){
  const gift=text(item?.giftReceivingStatus).toUpperCase();
  return Boolean(
    item?.excludedFromMetrics===true||item?.giftPending===true||gift==='WAIT_FOR_RECEIVING'
  );
}
function lineIdentifier(item,source){
  const src=sourceName(item,source);
  if(src==='coupang'){
    return text(item?.vendorItemId||item?.orderItemId||item?.sellerProductId||item?.productNo||item?.itemId||item?.line||item?.lineKey||item?.id);
  }
  if(src==='smartstore'){
    return text(item?.productOrderId||item?.orderItemId||item?.line||item?.lineKey||item?.id);
  }
  if(src==='elevenst'){
    return text(item?.orderProductSequence||item?.ordPrdSeq||item?.productNo||item?.sellerProductCode||item?.line||item?.lineKey||item?.id);
  }
  if(src==='lotteon'){
    return text(item?.orderItemId||item?.orderProductSequence||item?.sitmNo||item?.itemNo||item?.productNo||item?.deliveryNo||item?.line||item?.lineKey||item?.id);
  }
  return text(item?.productOrderId||item?.orderItemId||item?.line||item?.lineKey||item?.id);
}
function lineKey(item,source=''){
  const src=sourceName(item,source);
  const orderNo=text(item?.orderNo||item?.orderId||item?.shipmentBoxId||item?.deliveryNo||item?.id);
  const line=lineIdentifier(item,src)||text(item?.product||'item');
  return `${src}|${normalized(orderNo)}|${normalized(line)}`;
}
function directLineAmount(item){
  for(const value of [
    item?.lineAmount,item?.itemAmount,item?.productAmount,item?.orderProductAmount,
    item?.ordPrdAmt,item?.prdAmt,item?.saleAmt,item?.amount
  ]){
    const amount=money(value);
    if(amount>0) return amount;
  }
  const unit=money(item?.unitPrice||item?.itemPrice||item?.salePrice||item?.sellPrc||item?.selPrc);
  const qty=Math.max(1,Number(item?.qty||item?.quantity||item?.ordQty||1));
  return unit>0?unit*qty:0;
}
function orderTotal(item){
  for(const value of [
    item?.orderTotalAmount,item?.totalAmount,item?.paymentAmount,item?.totalPaymentAmount,
    item?.ordPayAmt,item?.payAmt,item?.realPayAmt,item?.totPayAmt
  ]){
    const amount=money(value);
    if(amount>0) return amount;
  }
  return 0;
}
function compactRow(item,source=''){
  const src=sourceName(item,source);
  const date=businessDate(item);
  const orderNo=text(item?.orderNo||item?.orderId||item?.shipmentBoxId||item?.deliveryNo||item?.id);
  const line=lineIdentifier(item,src);
  const qty=Math.max(1,Number(item?.qty||item?.quantity||item?.ordQty||1));
  return {
    id:lineKey(item,src),source:src,market:marketName(item,src),orderNo,line,
    datetime:date.getTime()?date.toISOString():'',
    product:text(item?.product||item?.productName||item?.itemName||'상품명 없음').slice(0,180),
    option:text(item?.option||item?.optionName||'').slice(0,120),
    qty,
    amount:Math.round(directLineAmount(item)),
    orderTotalAmount:Math.round(orderTotal(item)),
    status:text(item?.status||''),sourceStatus:text(item?.sourceStatus||''),
    excludedFromMetrics:excluded(item)
  };
}
function mergeRow(previous,next){
  if(!previous) return next;
  const result={...previous,...next};
  if(Number(next.amount||0)<=0&&Number(previous.amount||0)>0) result.amount=previous.amount;
  if(Number(next.orderTotalAmount||0)<=0&&Number(previous.orderTotalAmount||0)>0) result.orderTotalAmount=previous.orderTotalAmount;
  if(!next.product||next.product==='상품명 없음') result.product=previous.product||next.product;
  if(!next.option) result.option=previous.option||'';
  if(!next.datetime) result.datetime=previous.datetime||'';
  result.qty=Math.max(1,Number(next.qty||previous.qty||1));
  result.excludedFromMetrics=Boolean(next.excludedFromMetrics);
  return result;
}
function allocateOrderAmounts(rows){
  const groups=new Map();
  for(const row of rows){
    const key=`${row.source}|${normalized(row.orderNo)}`;
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(row);
  }
  const output=[];
  for(const groupRows of groups.values()){
    const active=groupRows.filter(row=>!row.excludedFromMetrics);
    if(!active.length) continue;
    const lineSum=active.reduce((sum,row)=>sum+Math.max(0,Number(row.amount||0)),0);
    const explicit=Math.max(0,...active.map(row=>Number(row.orderTotalAmount||0)));
    let target=lineSum||explicit;
    // 여러 상품행에 주문 전체금액이 반복 저장되면 합계가 실제 결제금액보다 커집니다.
    if(explicit>0&&active.length>1&&lineSum>explicit*1.02) target=explicit;
    const weights=active.map(row=>Math.max(0,Number(row.amount||0))||Math.max(1,Number(row.qty||1)));
    const weightSum=weights.reduce((sum,value)=>sum+value,0)||active.length;
    let allocated=0;
    active.forEach((row,index)=>{
      let amount;
      if(index===active.length-1){
        amount=Math.max(0,Math.round(target-allocated));
      }else{
        amount=Math.max(0,Math.round(target*(weights[index]/weightSum)));
        allocated+=amount;
      }
      output.push({...row,amount});
    });
  }
  return output;
}
function emptyLedger(day=kstDay()){
  return {version:2,day,generatedAt:'',rows:{}};
}
function loadLedger(day=kstDay()){
  try{
    if(!fs.existsSync(LEDGER_PATH)) return emptyLedger(day);
    const parsed=JSON.parse(fs.readFileSync(LEDGER_PATH,'utf8'));
    if(parsed?.version!==2||parsed?.day!==day) return emptyLedger(day);
    return {...emptyLedger(day),...parsed,rows:parsed.rows||{}};
  }catch{return emptyLedger(day);}
}
function saveLedger(ledger){
  const temporary=`${LEDGER_PATH}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify(ledger,null,2),'utf8');
  fs.renameSync(temporary,LEDGER_PATH);
}
async function sourceDocuments(db,source){
  let query=db.collection('orders').where('source','==',source);
  if(typeof query.limit==='function') query=query.limit(MAX_SOURCE_DOCS);
  const snapshot=await query.get();
  const documents=[];
  snapshot.forEach(doc=>documents.push({id:doc.id,...(doc.data()||{})}));
  return documents;
}
export function buildDailySnapshot(rows,{day=kstDay(),generatedAt=new Date().toISOString()}={}){
  const active=allocateOrderAmounts(rows.filter(row=>row&&row.datetime&&kstDay(row.datetime)===day&&!row.excludedFromMetrics));
  const markets={};
  for(const [,name] of SOURCES){markets[name]={count:0,sales:0,rows:[]};}
  for(const row of active){
    if(!markets[row.market]) markets[row.market]={count:0,sales:0,rows:[]};
    markets[row.market].count+=1;
    markets[row.market].sales+=Number(row.amount||0);
    markets[row.market].rows.push(row);
  }
  const allRows=active.sort((a,b)=>new Date(a.datetime)-new Date(b.datetime));
  return {
    version:2,appVersion:'v7.7.18',day,generatedAt,
    basis:'공식 API 저장 상품주문 행 일일 원장 · 송장번호/주문자 수가 아닌 상품주문 처리행 기준',
    excludedMarkets:['G마켓','옥션'],
    count:allRows.length,
    sales:allRows.reduce((sum,row)=>sum+Number(row.amount||0),0),
    markets,rows:allRows
  };
}
export async function rebuildDailyMetrics(db,{forceRemote=false,additionalRows=[]}={}){
  const day=kstDay();
  const ledger=loadLedger(day);
  const merged=new Map(Object.entries(ledger.rows||{}));
  const append=item=>{
    if(!item||String(item.eventType||'order').toLowerCase()!=='order') return;
    const row=compactRow(item,item.source);
    if(!row.datetime||kstDay(row.datetime)!==day) return;
    merged.set(row.id,mergeRow(merged.get(row.id),row));
  };
  additionalRows.forEach(append);
  if(forceRemote||!Object.keys(ledger.rows||{}).length){
    for(const [source] of SOURCES){
      try{
        const documents=await sourceDocuments(db,source);
        documents.forEach(append);
      }catch(error){
        console.warn(`${source} 당일 원장 복구 조회 실패:`,error?.message||error);
      }
    }
  }
  ledger.rows=Object.fromEntries(merged);
  ledger.generatedAt=new Date().toISOString();
  saveLedger(ledger);
  return buildDailySnapshot(Object.values(ledger.rows),{day,generatedAt:ledger.generatedAt});
}

export const dailyMetricsTestHelpers={
  compactRow,mergeRow,allocateOrderAmounts,lineKey,businessDate,excluded
};
