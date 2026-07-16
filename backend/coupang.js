import crypto from 'node:crypto';
import admin from 'firebase-admin';

const MAP={
  ACCEPT:['new','신규주문'],
  INSTRUCT:['shipping_wait','발송대기'],
  DEPARTURE:['departure','배송지시'],
  DELIVERING:['delivering','배송중'],
  FINAL_DELIVERY:['delivered','배송완료'],
  NONE_TRACKING:['none_tracking','직접배송']
};

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function signedDate(){
  return new Date().toISOString().split('.')[0]
    .replaceAll(':','').replaceAll('-','').slice(2)+'Z';
}

function kstDate(date){
  const d=new Date(date.getTime()+9*60*60*1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}+09:00`;
}

function auth({method,path,query,accessKey,secretKey}){
  const datetime=signedDate();
  const signature=crypto.createHmac('sha256',secretKey)
    .update(`${datetime}${method}${path}${query}`).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;
}

async function request(config,path,params){
  const method='GET';

  for(let attempt=0;attempt<4;attempt++){
    const query=new URLSearchParams(params).toString();
    const response=await fetch(`https://api-gateway.coupang.com${path}?${query}`,{
      signal:AbortSignal.timeout(30000),
method,
      headers:{
        'Content-Type':'application/json;charset=UTF-8',
        Authorization:auth({
          method,path,query,
          accessKey:config.accessKey,
          secretKey:config.secretKey
        }),
        'X-Requested-By':config.vendorId,
        'X-MARKET':'KR'
      }
    });

    const text=await response.text();

    if(response.status===429){
      const wait=[10000,20000,40000,60000][attempt];
      if(attempt===3) throw new Error('쿠팡 API 호출 제한(429)이 계속됩니다.');
      console.log(`쿠팡 API 429 · ${wait/1000}초 후 재시도`);
      await sleep(wait);
      continue;
    }

    let payload;
    try{ payload=JSON.parse(text); }
    catch{ throw new Error(`쿠팡 응답 변환 실패(HTTP ${response.status})`); }

    if(!response.ok){
      throw new Error(`쿠팡 API HTTP ${response.status}: ${payload?.message||text}`);
    }
    if(payload?.code!=null&&Number(payload.code)!==200){
      throw new Error(`쿠팡 API 오류 ${payload.code}: ${payload.message||'알 수 없는 오류'}`);
    }
    return payload;
  }
}

function money(v){
  if(v==null) return 0;
  if(typeof v==='number') return v;
  return Number(v.units||0)+Number(v.nanos||0)/1e9;
}

function normalize(sheets,requestedStatus){
  const out=[];

  for(const sheet of sheets){
    const sourceStatus=String(sheet.status||requestedStatus||'ACCEPT');
    const [status,statusLabel]=MAP[sourceStatus]||[sourceStatus.toLowerCase(),sourceStatus];
    const items=Array.isArray(sheet.orderItems)?sheet.orderItems:[];

    for(const item of items){
      const qty=Math.max(
        0,
        Number(item.shippingCount||0)-
        Number(item.cancelCount||0)-
        Number(item.holdCountForCancel||0)
      );
      if(qty<=0) continue;

      const orderNo=String(sheet.orderId);
      const vendorItemId=String(item.vendorItemId||item.sellerProductId||'item');
      const id=`coupang-${orderNo}-${vendorItemId}`;

      out.push({
        id,
        source:'coupang',
        market:'쿠팡',
        eventType:'order',
        orderNo,
        shipmentBoxId:String(sheet.shipmentBoxId||''),
        product:item.vendorItemName||
          [item.sellerProductName,item.sellerProductItemName].filter(Boolean).join(' ')||
          '쿠팡 상품',
        qty,
        buyer:sheet.receiver?.name||sheet.orderer?.name||'',
        amount:Math.round(money(item.orderPrice)),
        datetime:sheet.orderedAt||sheet.paidAt||new Date().toISOString(),
        status,
        statusLabel,
        sourceStatus,
        vendorItemId,
        invoiceNumber:item.invoiceNumber||sheet.invoiceNumber||'',
        deliveryCompanyName:item.deliveryCompanyName||sheet.deliveryCompanyName||'',
        activeState:true,
        syncedAt:new Date().toISOString()
      });
    }
  }
  return out;
}

async function fetchStatus(config,path,from,to,status,maxPages){
  const orders=[];
  let nextToken='';

  for(let page=0;page<maxPages;page++){
    const params={
      createdAtFrom:kstDate(from),
      createdAtTo:kstDate(to),
      maxPerPage:'50',
      status
    };
    if(nextToken) params.nextToken=nextToken;

    const payload=await request(config,path,params);
    const sheets=Array.isArray(payload.data)?payload.data:[];
    orders.push(...normalize(sheets,status));

    nextToken=payload.nextToken||payload.pagination?.nextToken||'';
    if(!nextToken||sheets.length===0) break;
    await sleep(1500);
  }
  return orders;
}


async function reconcileCurrentStatus(db,status,currentOrders,from,complete){
  if(!complete){
    return {deactivated:0,skipped:true};
  }

  const currentIds=new Set(currentOrders.map(order=>order.id));
  const snapshot=await db.collection('orders').where('source','==','coupang').get();
  const fromTime=from.getTime();
  const stale=[];

  snapshot.forEach(doc=>{
    const data=doc.data()||{};
    if(data.eventType!=='order') return;
    if(String(data.sourceStatus||'')!==status) return;
    if(data.activeState===false) return;
    const ordered=new Date(data.datetime||0).getTime();
    if(!Number.isFinite(ordered)||ordered<fromTime) return;
    if(currentIds.has(doc.id)) return;
    stale.push(doc.ref);
  });

  for(let i=0;i<stale.length;i+=400){
    const batch=db.batch();
    stale.slice(i,i+400).forEach(ref=>batch.set(ref,{
      activeState:false,
      status:'resolved',
      statusLabel:'처리완료',
      resolvedReason:'현재 API 상태에서 제외됨',
      resolvedAt:admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:admin.firestore.FieldValue.serverTimestamp()
    },{merge:true}));
    await batch.commit();
  }

  return {deactivated:stale.length,skipped:false};
}

async function save(db,orders){
  let created=0,existing=0,statusChanged=0;
  const createdOrders=[];

  for(const order of orders){
    const ref=db.collection('orders').doc(order.id);
    const result=await db.runTransaction(async tx=>{
      const snap=await tx.get(ref);

      if(!snap.exists){
        tx.create(ref,{
          ...order,
          createdAt:admin.firestore.FieldValue.serverTimestamp(),
          updatedAt:admin.firestore.FieldValue.serverTimestamp()
        });
        return 'created';
      }

      const before=snap.data()||{};
      const changed=
        before.sourceStatus!==order.sourceStatus||
        before.status!==order.status||
        Number(before.qty||0)!==Number(order.qty||0)||
        String(before.invoiceNumber||'')!==String(order.invoiceNumber||'');

      if(!changed){
        return 'existing';
      }

      tx.set(ref,{
        ...order,
        createdAt:
          before.createdAt||
          admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp()
      },{merge:true});

      return 'changed';
    });

    if(result==='created'){ created++; createdOrders.push(order); }
    else if(result==='changed') statusChanged++;
    else existing++;
  }

  return {found:orders.length,created,existing,statusChanged,createdOrders};
}

export async function pollCoupangStatuses(
  db,
  config,
  {statuses,days,maxPages=2,reconcile=false}
){
  const now=new Date();
  const from=new Date(now.getTime()-days*86400000);
  const path=`/v2/providers/openapi/apis/api/v5/vendors/${encodeURIComponent(config.vendorId)}/ordersheets`;

  const all=[];
  const counts={};

  for(let i=0;i<statuses.length;i++){
    if(i>0) await sleep(1800);
    const status=statuses[i];
    const orders=await fetchStatus(config,path,from,now,status,maxPages);
    counts[status]=orders.length;
    all.push(...orders);

    if(reconcile){
      const complete=orders.length<(maxPages*50);
      const reconciled=await reconcileCurrentStatus(
        db,status,orders,from,complete
      );
      counts[`${status}_DEACTIVATED`]=
        reconciled.deactivated||0;
    }else{
      counts[`${status}_DEACTIVATED`]=0;
    }
  }

  const unique=[...new Map(all.map(o=>[o.id,o])).values()];
  const result=await save(db,unique);

  return {
    ...result,
    counts,
    statuses,
    days,
    checkedFrom:from.toISOString(),
    checkedTo:now.toISOString()
  };
}
