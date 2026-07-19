import crypto from 'node:crypto';
import { workflowFields,isClaimTerminal } from './workflow-model.js';
import { upsertDocuments,reconcileOpenDocuments } from './order-store.js';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function signedDate(){
  return new Date().toISOString().split('.')[0].replaceAll(':','').replaceAll('-','').slice(2)+'Z';
}
function kstMinute(date){
  const shifted=new Date(date.getTime()+9*60*60*1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth()+1).padStart(2,'0')}-${String(shifted.getUTCDate()).padStart(2,'0')}T${String(shifted.getUTCHours()).padStart(2,'0')}:${String(shifted.getUTCMinutes()).padStart(2,'0')}`;
}
function kstSecond(date){return `${kstMinute(date)}:${String(new Date(date.getTime()+9*60*60*1000).getUTCSeconds()).padStart(2,'0')}`;}
function auth({method,path,query,accessKey,secretKey}){
  const datetime=signedDate();
  const signature=crypto.createHmac('sha256',secretKey).update(`${datetime}${method}${path}${query}`).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;
}

async function request(config,path,params){
  const method='GET';
  let lastError;
  for(let attempt=0;attempt<4;attempt+=1){
    const query=new URLSearchParams(params).toString();
    try{
      const response=await fetch(`https://api-gateway.coupang.com${path}?${query}`,{
        method,signal:AbortSignal.timeout(60000),
        headers:{
          'Content-Type':'application/json;charset=UTF-8',
          Authorization:auth({method,path,query,accessKey:config.accessKey,secretKey:config.secretKey}),
          'X-Requested-By':config.vendorId,'X-MARKET':'KR','X-EXTENDED-TIMEOUT':'60000'
        }
      });
      const raw=await response.text();
      if([429,502,503,504].includes(response.status)){
        const wait=([10000,20000,40000,60000][attempt]);
        if(attempt===3) throw new Error(`쿠팡 CS API HTTP ${response.status}: 재시도 후에도 실패`);
        console.log(`쿠팡 CS API HTTP ${response.status} · ${wait/1000}초 후 재시도`);
        await sleep(wait);continue;
      }
      let payload;
      try{payload=JSON.parse(raw);}catch{throw new Error(`쿠팡 CS 응답 변환 실패(HTTP ${response.status})`);}
      if(!response.ok) throw new Error(`쿠팡 CS API HTTP ${response.status}: ${payload?.message||raw}`);
      if(payload?.code!=null&&Number(payload.code)!==200) throw new Error(`쿠팡 CS API 오류 ${payload.code}: ${payload.message||'알 수 없는 오류'}`);
      return payload;
    }catch(error){
      lastError=error;
      if((error?.name==='TimeoutError'||error?.name==='AbortError')&&attempt<3){
        const wait=[5000,10000,20000,40000][attempt];await sleep(wait);continue;
      }
      throw error;
    }
  }
  throw lastError||new Error('쿠팡 CS API 요청 실패');
}

function rangeWindows(days=31,windowDays=7){
  const now=new Date();
  const start=new Date(now.getTime()-days*86400000);
  const windows=[];
  let cursor=start;
  while(cursor<now){
    const end=new Date(Math.min(now.getTime(),cursor.getTime()+windowDays*86400000-60000));
    windows.push({from:cursor,to:end});
    cursor=new Date(end.getTime()+60000);
  }
  return windows;
}

function returnDocuments(rows,{eventType,activeOverride=null}){
  const documents=[];
  for(const row of rows){
    const items=Array.isArray(row.returnItems)&&row.returnItems.length?row.returnItems:[{}];
    for(const item of items){
      const claimId=String(row.receiptId||row.returnId||row.orderId||'');
      const lineId=String(item.vendorItemId||item.orderItemId||'claim');
      if(!claimId) continue;
      const sourceStatus=String(row.receiptStatus||row.returnStatus||row.cancelStatus||'');
      const base={
        id:`coupang-${eventType}-${claimId}-${lineId}`,
        source:'coupang',market:'쿠팡',eventType,
        ...workflowFields({source:'coupang',orderNo:String(row.orderId||''),lineId,eventType,claimId}),
        orderNo:String(row.orderId||''),claimId,receiptId:String(row.receiptId||''),vendorItemId:lineId,
        product:item.vendorItemName||item.sellerProductName||`${eventType==='cancel'?'주문취소':'반품요청'} 상품`,
        qty:Number(item.cancelCount||item.requestQuantity||row.cancelCountSum||1),buyer:row.requesterName||'',amount:0,
        datetime:row.createdAt||row.receiptTime||new Date().toISOString(),
        claimRequestedAt:row.createdAt||row.receiptTime||'',
        status:`${eventType}_request`,statusLabel:eventType==='cancel'?'주문취소':'반품요청',
        sourceStatus,claimStatus:sourceStatus,
        reason:row.reasonCodeText||row.cancelReason||row.cancelReasonCategory2||'',
        reasonDetail:row.reasonEtcDetail||'',modifiedAt:row.modifiedAt||'',
        sourceUpdatedAt:row.modifiedAt||row.createdAt||new Date().toISOString(),syncedAt:new Date().toISOString()
      };
      base.activeState=activeOverride==null?!isClaimTerminal(base):Boolean(activeOverride);
      if(!base.activeState){base.status=eventType==='cancel'?'cancelled':'returned';base.statusLabel=eventType==='cancel'?'취소완료':'반품완료';}
      documents.push(base);
    }
  }
  return documents;
}

function exchangeDocuments(rows){
  const documents=[];
  for(const row of rows){
    const items=Array.isArray(row.exchangeItemDtoV1s)&&row.exchangeItemDtoV1s.length?row.exchangeItemDtoV1s:[{}];
    for(const item of items){
      const claimId=String(row.exchangeId||row.receiptId||'');
      const lineId=String(item.orderItemId||item.targetItemId||'claim');
      if(!claimId) continue;
      const sourceStatus=String(row.exchangeStatus||row.status||'');
      const document={
        id:`coupang-exchange-${claimId}-${lineId}`,source:'coupang',market:'쿠팡',eventType:'exchange',
        ...workflowFields({source:'coupang',orderNo:String(row.orderId||''),lineId,eventType:'exchange',claimId}),
        orderNo:String(row.orderId||''),claimId,exchangeId:claimId,orderItemId:lineId,
        product:item.orderItemName||item.targetItemName||'교환요청 상품',qty:Number(item.quantity||1),
        buyer:row.exchangeAddressDtoV1?.returnCustomerName||'',amount:Number(item.orderItemUnitPrice||0),
        datetime:row.createdAt||new Date().toISOString(),claimRequestedAt:row.createdAt||'',
        status:'exchange_request',statusLabel:'교환요청',sourceStatus,claimStatus:sourceStatus,
        reason:row.reasonCodeText||row.reasonEtcDetail||'',modifiedAt:row.modifiedAt||'',
        sourceUpdatedAt:row.modifiedAt||row.createdAt||new Date().toISOString(),syncedAt:new Date().toISOString()
      };
      document.activeState=!isClaimTerminal(document);
      if(!document.activeState){document.status='exchanged';document.statusLabel='교환완료';}
      documents.push(document);
    }
  }
  return documents;
}

async function fetchReturnRows(config,{status='',cancelType='',days=31}){
  const path=`/v2/providers/openapi/apis/api/v6/vendors/${encodeURIComponent(config.vendorId)}/returnRequests`;
  const rows=[];
  let complete=true;
  for(const window of rangeWindows(days,7)){
    const params={searchType:'timeFrame',createdAtFrom:kstMinute(window.from),createdAtTo:kstMinute(window.to)};
    if(status) params.status=status;
    if(cancelType) params.cancelType=cancelType;
    try{
      const payload=await request(config,path,params);
      rows.push(...(Array.isArray(payload.data)?payload.data:[]));
    }catch(error){complete=false;throw error;}
    await sleep(800);
  }
  return {rows,complete,from:new Date(Date.now()-days*86400000)};
}

async function fetchExchangeRows(config,days=31,maxPages=10){
  const now=new Date();
  const from=new Date(now.getTime()-days*86400000);
  const path=`/v2/providers/openapi/apis/api/v4/vendors/${encodeURIComponent(config.vendorId)}/exchangeRequests`;
  const rows=[];
  let complete=true;

  // 교환 조회 API는 createdAtFrom~createdAtTo가 7일 미만이어야 하므로
  // 6일 단위로 나누고 각 구간을 끝까지 페이지 조회합니다.
  for(const window of rangeWindows(days,6)){
    let nextToken='';
    let windowComplete=false;

    for(let page=0;page<maxPages;page+=1){
      const params={
        createdAtFrom:kstSecond(window.from),
        createdAtTo:kstSecond(window.to),
        maxPerPage:'50'
      };
      if(nextToken) params.nextToken=nextToken;

      const payload=await request(config,path,params);
      const pageRows=Array.isArray(payload.data)?payload.data:[];
      rows.push(...pageRows);
      nextToken=payload.nextToken||payload.pagination?.nextToken||'';

      if(!nextToken||pageRows.length===0){
        windowComplete=true;
        break;
      }
      await sleep(1000);
    }

    complete=complete&&windowComplete;
    await sleep(800);
  }

  const unique=[...new Map(rows.map(row=>[
    String(row.exchangeId||row.receiptId||JSON.stringify(row)),
    row
  ])).values()];
  return {rows:unique,complete,from};
}

async function saveAndReconcile(db,eventType,documents,{from,complete,reconcile}){
  const saved=await upsertDocuments(db,documents);
  const open=documents.filter(item=>item.activeState!==false);
  const result=reconcile?await reconcileOpenDocuments(db,{
    source:'coupang',eventType,currentIds:open.map(item=>item.id),from,complete,
    reason:'쿠팡 현재 미처리 목록에서 제외됨'
  }):{deactivated:0,skipped:true};
  return {...saved,createdClaims:saved.createdDocuments,changedClaims:saved.changedDocuments,deactivated:result.deactivated||0};
}

export async function syncCancellations(db,config,reconcile=false){
  const payment=await fetchReturnRows(config,{cancelType:'CANCEL',days:31});
  await sleep(1000);
  const release=await fetchReturnRows(config,{status:'RU',days:31});
  const terminal=returnDocuments(payment.rows,{eventType:'cancel',activeOverride:false});
  const open=returnDocuments(release.rows,{eventType:'cancel',activeOverride:true});
  return saveAndReconcile(db,'cancel',[...terminal,...open],{from:release.from,complete:release.complete,reconcile});
}

export async function syncReturns(db,config,reconcile=false){
  const received=await fetchReturnRows(config,{status:'UC',days:31});
  await sleep(1000);
  const review=await fetchReturnRows(config,{status:'PR',days:31});
  await sleep(1000);
  const completed=await fetchReturnRows(config,{status:'CC',days:31});
  const documents=[
    ...returnDocuments(received.rows,{eventType:'return',activeOverride:true}),
    ...returnDocuments(review.rows,{eventType:'return',activeOverride:true}),
    ...returnDocuments(completed.rows,{eventType:'return',activeOverride:false})
  ];
  return saveAndReconcile(db,'return',documents,{from:received.from,complete:received.complete&&review.complete&&completed.complete,reconcile});
}

export async function syncExchanges(db,config,reconcile=false){
  const fetched=await fetchExchangeRows(config,31,10);
  const documents=exchangeDocuments(fetched.rows);
  return saveAndReconcile(db,'exchange',documents,{from:fetched.from,complete:fetched.complete,reconcile});
}
