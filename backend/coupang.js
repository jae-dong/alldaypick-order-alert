import crypto from 'node:crypto';
import { workflowFields } from './workflow-model.js';
import { upsertDocuments,reconcileOpenDocuments } from './order-store.js';
import { directCoupangOrderImage } from './product-image.js';

const MAP={
  ACCEPT:['new','신규주문'],
  INSTRUCT:['shipping_wait','발송대기'],
  DEPARTURE:['departure','배송지시'],
  DELIVERING:['delivering','배송중'],
  FINAL_DELIVERY:['delivered','배송완료'],
  NONE_TRACKING:['none_tracking','직접배송']
};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function signedDate(){
  return new Date().toISOString().split('.')[0]
    .replaceAll(':','').replaceAll('-','').slice(2)+'Z';
}
function kstDate(date){
  const shifted=new Date(date.getTime()+9*60*60*1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth()+1).padStart(2,'0')}-${String(shifted.getUTCDate()).padStart(2,'0')}+09:00`;
}
function auth({method,path,query,accessKey,secretKey}){
  const datetime=signedDate();
  const signature=crypto.createHmac('sha256',secretKey)
    .update(`${datetime}${method}${path}${query}`).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;
}

async function request(config,path,params){
  const method='GET';
  let lastError;
  for(let attempt=0;attempt<4;attempt+=1){
    const query=new URLSearchParams(params).toString();
    try{
      const response=await fetch(`https://api-gateway.coupang.com${path}?${query}`,{
        signal:AbortSignal.timeout(60000),method,
        headers:{
          'Content-Type':'application/json;charset=UTF-8',
          Authorization:auth({method,path,query,accessKey:config.accessKey,secretKey:config.secretKey}),
          'X-Requested-By':config.vendorId,'X-MARKET':'KR','X-EXTENDED-TIMEOUT':'60000'
        }
      });
      const text=await response.text();
      if([429,502,503,504].includes(response.status)){
        const waits=response.status===429?[10000,20000,40000,60000]:[5000,10000,20000,40000];
        if(attempt===3) throw new Error(`쿠팡 API HTTP ${response.status}: 재시도 후에도 응답하지 않습니다.`);
        console.log(`쿠팡 API HTTP ${response.status} · ${waits[attempt]/1000}초 후 재시도`);
        await sleep(waits[attempt]);
        continue;
      }
      let payload;
      try{payload=JSON.parse(text);}catch{throw new Error(`쿠팡 응답 변환 실패(HTTP ${response.status})`);}
      if(!response.ok) throw new Error(`쿠팡 API HTTP ${response.status}: ${payload?.message||text}`);
      if(payload?.code!=null&&Number(payload.code)!==200) throw new Error(`쿠팡 API 오류 ${payload.code}: ${payload.message||'알 수 없는 오류'}`);
      return payload;
    }catch(error){
      lastError=error;
      const retryable=['TimeoutError','AbortError'].includes(error?.name)||String(error?.message||'').includes('timeout');
      if(retryable&&attempt<3){
        const wait=[5000,10000,20000,40000][attempt];
        console.log(`쿠팡 API 응답 지연 · ${wait/1000}초 후 재시도`);
        await sleep(wait);
        continue;
      }
      throw error;
    }
  }
  throw lastError||new Error('쿠팡 API 요청 실패');
}

function money(value){
  if(value==null) return 0;
  if(typeof value==='number') return value;
  return Number(value.units||0)+Number(value.nanos||0)/1e9;
}


function firstImageUrl(value){
  return directCoupangOrderImage(value);
}


function normalize(sheets,requestedStatus){
  const out=[];
  for(const sheet of sheets){
    const sourceStatus=String(sheet.status||requestedStatus||'ACCEPT').toUpperCase();
    const [status,statusLabel]=MAP[sourceStatus]||[sourceStatus.toLowerCase(),sourceStatus];
    const items=Array.isArray(sheet.orderItems)?sheet.orderItems:[];
    for(const item of items){
      const orderedQty=Math.max(1,Number(item.shippingCount||item.quantity||1));
      const qty=Math.max(0,orderedQty-Number(item.cancelCount||0)-Number(item.holdCountForCancel||0));
      if(qty<=0) continue;
      const itemOrderTotal=
        money(item.orderPrice)||money(item.totalPrice)||
        money(item.salesPrice)*orderedQty||
        money(item.discountedPrice)*orderedQty||
        money(item.unitPrice)*orderedQty;
      const activeItemAmount=Math.round(
        itemOrderTotal>0
          ?itemOrderTotal*(qty/orderedQty)
          :(money(item.salesPrice)||money(item.discountedPrice)||money(item.unitPrice))*qty
      );
      const orderNo=String(sheet.orderId||'');
      const lineId=String(item.vendorItemId||item.sellerProductId||item.orderItemId||'item');
      if(!orderNo) continue;
      out.push({
        id:`coupang-${orderNo}-${lineId}`,
        source:'coupang',market:'쿠팡',eventType:'order',
        ...workflowFields({source:'coupang',orderNo,lineId,eventType:'order'}),
        orderNo,shipmentBoxId:String(sheet.shipmentBoxId||''),vendorItemId:lineId,
        sellerProductId:String(item.sellerProductId||''),productId:String(item.productId||''),
        externalVendorSkuCode:String(item.externalVendorSkuCode||item.externalVendorSku||item.sellerProductCode||''),
        sellerProductCode:String(item.sellerProductCode||item.externalVendorSkuCode||item.externalVendorSku||''),
        imageUrl:firstImageUrl(item),
        product:item.vendorItemName||[item.sellerProductName,item.sellerProductItemName].filter(Boolean).join(' ')||'쿠팡 상품',
        option:item.sellerProductItemName||'',qty,buyer:sheet.receiver?.name||sheet.orderer?.name||'',
        phone:sheet.receiver?.safeNumber||sheet.receiver?.receiverNumber||'',
        address:[sheet.receiver?.addr1,sheet.receiver?.addr2].filter(Boolean).join(' '),
        deliveryMemo:sheet.deliveryMessage||'',
        amount:activeItemAmount,
        unitPrice:Math.round(
          money(item.unitPrice)||money(item.salesPrice)||money(item.discountedPrice)||
          itemOrderTotal/orderedQty
        ),
        originalQty:orderedQty,
        cancelCount:Number(item.cancelCount||0),
        holdCountForCancel:Number(item.holdCountForCancel||0),
        orderTotalAmount:Math.round(
          money(sheet.orderPrice)||money(sheet.totalPrice)||money(sheet.paymentAmount)||0
        ),
        datetime:sheet.orderedAt||sheet.paidAt||new Date().toISOString(),
        metricDate:sheet.orderedAt||sheet.paidAt||'',
        orderDate:sheet.orderedAt||'',paymentDate:sheet.paidAt||'',
        status,statusLabel,sourceStatus,activeState:true,
        stateAuthority:'coupang-orders-api',
        stateVerifiedAt:new Date().toISOString(),
        apiVerifiedOpen:['ACCEPT','INSTRUCT'].includes(sourceStatus),
        invoiceNumber:item.invoiceNumber||sheet.invoiceNumber||'',
        deliveryCompanyName:item.deliveryCompanyName||sheet.deliveryCompanyName||'',
        sourceUpdatedAt:sheet.modifiedAt||sheet.updatedAt||new Date().toISOString(),
        syncedAt:new Date().toISOString()
      });
    }
  }
  return out;
}

async function fetchStatus(config,path,from,to,status,maxPages){
  const orders=[];
  let nextToken='';
  let complete=false;
  for(let page=0;page<maxPages;page+=1){
    const params={createdAtFrom:kstDate(from),createdAtTo:kstDate(to),maxPerPage:'50',status};
    if(nextToken) params.nextToken=nextToken;
    const payload=await request(config,path,params);
    const sheets=Array.isArray(payload.data)?payload.data:[];
    orders.push(...normalize(sheets,status));
    nextToken=payload.nextToken||payload.pagination?.nextToken||'';
    if(!nextToken||sheets.length===0){complete=true;break;}
    await sleep(1200);
  }
  return {orders,complete,nextToken};
}

export async function pollCoupangStatuses(db,config,{statuses,days,maxPages=2,reconcile=false}){
  const now=new Date();
  const from=new Date(now.getTime()-Math.max(1,Number(days||1))*86400000);
  const path=`/v2/providers/openapi/apis/api/v5/vendors/${encodeURIComponent(config.vendorId)}/ordersheets`;
  const all=[];
  const counts={};
  const completeness={};
  const reconcileQuota={cloudReads:0,cloudWrites:0,cacheHits:0};

  for(let index=0;index<statuses.length;index+=1){
    if(index) await sleep(1500);
    const sourceStatus=statuses[index];
    const fetched=await fetchStatus(config,path,from,now,sourceStatus,maxPages);
    counts[sourceStatus]=fetched.orders.length;
    completeness[sourceStatus]=fetched.complete;
    all.push(...fetched.orders);

    if(reconcile){
      const result=await reconcileOpenDocuments(db,{
        source:'coupang',eventType:'order',
        currentIds:fetched.orders.map(item=>item.id),from,complete:fetched.complete,
        reason:`쿠팡 ${sourceStatus} 현재 상태에서 제외됨`,sourceStatus
      });
      counts[`${sourceStatus}_DEACTIVATED`]=result.deactivated||0;
      counts[`${sourceStatus}_RECONCILE_SKIPPED`]=result.skipped?1:0;
      reconcileQuota.cloudReads+=Number(result.quota?.cloudReads||0);
      reconcileQuota.cloudWrites+=Number(result.quota?.cloudWrites||0);
    }
  }

  const unique=[...new Map(all.map(item=>[item.id,item])).values()];
  const saved=await upsertDocuments(db,unique);
  return {
    ...saved,createdOrders:saved.createdDocuments,changedOrders:saved.changedDocuments,
    counts,completeness,statuses,days,
    quota:{
      cloudReads:Number(saved.quota?.cloudReads||0)+reconcileQuota.cloudReads,
      cloudWrites:Number(saved.quota?.cloudWrites||0)+reconcileQuota.cloudWrites,
      cacheHits:Number(saved.quota?.cacheHits||0)
    },
    checkedFrom:from.toISOString(),checkedTo:now.toISOString(),
    directAudit:{
      authority:'coupang-orders-api-v5',
      verifiedAt:new Date().toISOString(),
      checkedFrom:from.toISOString(),
      checkedTo:now.toISOString(),
      statuses:[...statuses],
      counts:{...counts},
      complete:Object.values(completeness).every(Boolean),
      completeness:{...completeness},
      normalizedRows:unique.length,
      missingAmount:unique.filter(item=>Number(item.amount||0)<=0).length,
      orderLines:unique.slice(0,300).map(item=>({
        id:item.id,orderNo:item.orderNo,line:item.vendorItemId,
        datetime:item.datetime,amount:Number(item.amount||0),qty:Number(item.qty||0),
        status:item.status,sourceStatus:item.sourceStatus
      }))
    }
  };
}

// Backward-compatible entry point for the optional cloud poller.
export async function pollCoupang(db,config,minutes=30){
  const days=Math.max(1,Math.ceil(Number(minutes||30)/1440)+1);
  return pollCoupangStatuses(db,config,{
    statuses:['ACCEPT','INSTRUCT'],
    days,
    maxPages:5,
    reconcile:false
  });
}
