import crypto from 'node:crypto';
import { workflowFields,isClaimTerminal } from './workflow-model.js';
import { upsertDocuments,reconcileOpenDocuments } from './order-store.js';
import { enrichWithParentOrderContext } from './parent-order-context.js';

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
        stateAuthority:'coupang-return-api',
        stateVerifiedAt:new Date().toISOString(),
        apiVerifiedOpen:activeOverride==null?true:Boolean(activeOverride),
        sourceUpdatedAt:row.modifiedAt||row.createdAt||new Date().toISOString(),syncedAt:new Date().toISOString()
      };
      base.activeState=activeOverride==null?!isClaimTerminal(base):Boolean(activeOverride);
      if(!base.activeState){base.status=eventType==='cancel'?'cancelled':'returned';base.statusLabel=eventType==='cancel'?'취소완료':'반품완료';}
      documents.push(base);
    }
  }
  return documents;
}


function exchangeStatusValue(row={}){
  return String(
    row.exchangeStatus||
    row.exchangeStatusLabel||
    row.status||
    row.statusLabel||
    ''
  ).trim().toUpperCase();
}

function exchangeDeliveryCompleted(row={}){
  const deliveryStatus=String(row.deliveryStatus||'').trim().toUpperCase();
  if(['COMPLETEDELIVERY','COMPLETE_DELIVERY','WITHDRAW'].includes(deliveryStatus)) return true;

  const items=Array.isArray(row.exchangeItemDtoV1s)?row.exchangeItemDtoV1s:[];
  if(items.length>0&&items.every(item=>item?.targetItemDeliveryComplete===true)) return true;

  const invoiceGroups=Array.isArray(row.deliveryInvoiceGroupDtos)?row.deliveryInvoiceGroupDtos:[];
  const invoices=invoiceGroups.flatMap(group=>Array.isArray(group?.deliveryInvoiceDtos)?group.deliveryInvoiceDtos:[]);
  if(invoices.length>0&&invoices.every(invoice=>{
    const status=String(invoice?.statusCode||'').trim().toUpperCase();
    return ['FINAL_DELIVERY','DELIVERED','COMPLETEDELIVERY','COMPLETE_DELIVERY'].includes(status);
  })) return true;

  return false;
}

function exchangeActiveState(row={}){
  const status=exchangeStatusValue(row);

  // 쿠팡 교환 목록 API의 exchangeStatus가 판매자센터 교환 처리상태의 기준입니다.
  // 배송완료 플래그가 먼저 들어와도 exchangeStatus가 RECEIPT/PROGRESS이면
  // 판매자가 아직 처리해야 하는 교환으로 그대로 표시합니다.
  if(['RECEIPT','PROGRESS','접수','진행'].includes(status)) return true;
  if(['SUCCESS','REJECT','CANCEL','완료','거부','취소'].includes(status)) return false;

  // 구버전/불완전 응답에서 상태가 비어 있을 때만 배송완료 정보를 보조로 사용합니다.
  if(exchangeDeliveryCompleted(row)) return false;
  return false;
}

function exchangeDocuments(rows){
  const documents=[];
  for(const row of rows){
    const items=Array.isArray(row.exchangeItemDtoV1s)&&row.exchangeItemDtoV1s.length?row.exchangeItemDtoV1s:[{}];
    for(const item of items){
      const claimId=String(row.exchangeId||row.receiptId||'');
      const lineId=String(item.orderItemId||item.targetItemId||'claim');
      if(!claimId) continue;
      const sourceStatus=exchangeStatusValue(row);
      const document={
        id:`coupang-exchange-${claimId}-${lineId}`,source:'coupang',market:'쿠팡',eventType:'exchange',
        ...workflowFields({source:'coupang',orderNo:String(row.orderId||''),lineId,eventType:'exchange',claimId}),
        orderNo:String(row.orderId||''),claimId,exchangeId:claimId,orderItemId:lineId,
        product:item.orderItemName||item.targetItemName||'교환요청 상품',qty:Number(item.quantity||1),
        buyer:row.exchangeAddressDtoV1?.returnCustomerName||'',amount:Number(item.orderItemUnitPrice||0),
        datetime:row.createdAt||new Date().toISOString(),claimRequestedAt:row.createdAt||'',
        status:'exchange_request',statusLabel:'교환요청',sourceStatus,claimStatus:sourceStatus,
        reason:row.reasonCodeText||row.reasonEtcDetail||'',modifiedAt:row.modifiedAt||'',
        exchangeStatus:sourceStatus,deliveryStatus:String(row.deliveryStatus||''),
        targetItemDeliveryComplete:item.targetItemDeliveryComplete===true,
        stateAuthority:'coupang-exchange-api',
        stateVerifiedAt:new Date().toISOString(),
        apiVerifiedOpen:exchangeActiveState(row),
        sourceUpdatedAt:row.modifiedAt||row.createdAt||new Date().toISOString(),syncedAt:new Date().toISOString()
      };
      document.activeState=exchangeActiveState(row);
      if(!document.activeState){
        document.status='exchanged';
        document.statusLabel=sourceStatus==='REJECT'?'교환불가':sourceStatus==='CANCEL'?'교환철회':'교환완료';
      }
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

async function fetchExchangeRows(config,days=31,maxPages=10,statuses=['RECEIPT','PROGRESS']){
  const now=new Date();
  const from=new Date(now.getTime()-days*86400000);
  const path=`/v2/providers/openapi/apis/api/v4/vendors/${encodeURIComponent(config.vendorId)}/exchangeRequests`;
  const rows=[];
  let complete=true;
  const statusList=[...new Set((statuses||[]).map(value=>String(value||'').trim()).filter(Boolean))];

  // 현재 처리 중인 교환은 공식 상태 RECEIPT/PROGRESS를 각각 직접 조회합니다.
  // 전체 상태 혼합 응답에 의존하지 않아 판매자센터의 진행 중 교환을 놓치지 않습니다.
  for(const status of statusList){
    for(const window of rangeWindows(days,6)){
      let nextToken='';
      let windowComplete=false;

      for(let page=0;page<maxPages;page+=1){
        const params={
          createdAtFrom:kstSecond(window.from),
          createdAtTo:kstSecond(window.to),
          maxPerPage:'50',
          status
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
        await sleep(700);
      }

      complete=complete&&windowComplete;
      await sleep(500);
    }
  }

  const unique=[...new Map(rows.map(row=>[
    String(row.exchangeId||row.receiptId||JSON.stringify(row)),
    row
  ])).values()];
  return {rows:unique,complete,from,statuses:statusList};
}

async function saveAndReconcile(db,eventType,documents,{from,complete,reconcile}){
  const enriched=await enrichWithParentOrderContext(db,documents,{source:'coupang'});
  const saved=await upsertDocuments(db,enriched);
  const open=enriched.filter(item=>item.activeState!==false);
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
  const saved=await saveAndReconcile(db,'cancel',[...terminal,...open],{
    from:release.from,
    complete:payment.complete&&release.complete,
    reconcile
  });
  return {
    ...saved,
    directAudit:{
      authority:'coupang-return-api-v6',
      verifiedAt:new Date().toISOString(),
      type:'cancel',
      open:open.length,
      terminal:terminal.length,
      complete:Boolean(payment.complete&&release.complete),
      checkedFrom:release.from.toISOString()
    }
  };
}

export async function syncReturns(db,config,reconcile=false){
  const received=await fetchReturnRows(config,{status:'UC',days:31});
  await sleep(1000);
  const review=await fetchReturnRows(config,{status:'PR',days:31});
  await sleep(1000);
  const completed=await fetchReturnRows(config,{status:'CC',days:31});
  const open=[
    ...returnDocuments(received.rows,{eventType:'return',activeOverride:true}),
    ...returnDocuments(review.rows,{eventType:'return',activeOverride:true})
  ];
  const terminal=returnDocuments(completed.rows,{eventType:'return',activeOverride:false});
  const documents=[...open,...terminal];
  const complete=received.complete&&review.complete&&completed.complete;
  const saved=await saveAndReconcile(db,'return',documents,{from:received.from,complete,reconcile});
  return {
    ...saved,
    directAudit:{
      authority:'coupang-return-api-v6',
      verifiedAt:new Date().toISOString(),
      type:'return',
      open:open.length,
      terminal:terminal.length,
      complete:Boolean(complete),
      checkedFrom:received.from.toISOString()
    }
  };
}


function normalizedMarketValue(value){
  return String(value??'').trim().toLowerCase().replace(/\s+/g,' ');
}

function isCoupangExchangeDocument(data={},documentId=''){
  const sourceValues=[data.source,data.market,data.marketName,data.channel]
    .map(normalizedMarketValue);
  const coupang=sourceValues.some(value=>value==='coupang'||value==='쿠팡')||
    normalizedMarketValue(documentId).startsWith('coupang-');
  if(!coupang) return false;

  const event=normalizedMarketValue(data.eventType);
  if(event==='exchange') return true;

  const signals=[
    data.workflowType,data.status,data.statusLabel,data.sourceStatus,
    data.claimStatus,data.exchangeStatus,data.exchangeStatusLabel,
    data.claimKey,documentId
  ].filter(Boolean).join(' ').toUpperCase();
  return signals.includes('EXCHANGE')||signals.includes('교환');
}

function exchangeClaimIdentity(data={},documentId=''){
  const explicit=String(
    data.claimId||data.exchangeId||data.receiptId||''
  ).trim();
  const stored=String(data.claimKey||'').trim();
  return explicit||stored||String(documentId||'').trim();
}

async function forceCloseStaleCoupangExchanges(db,currentDocuments,{complete=true,from=new Date(0)}={}){
  if(!complete) return {deactivated:0,skipped:true};
  const cutoff=new Date(from||0).getTime()||0;

  const activeIds=new Set();
  const activeClaims=new Set();
  for(const item of currentDocuments||[]){
    if(item?.activeState===false) continue;
    if(item?.id) activeIds.add(String(item.id));
    const identity=exchangeClaimIdentity(item,item?.id);
    if(identity) activeClaims.add(identity);
  }

  // A single-field activeState query is intentionally used here. It reads only
  // currently open workflow documents and also catches legacy records whose
  // source was stored as Korean "쿠팡" or whose eventType was omitted.
  const snapshot=await db.collection('orders')
    .where('activeState','==',true)
    .get();

  const stale=[];
  snapshot.forEach(doc=>{
    const data=doc.data()||{};
    if(!isCoupangExchangeDocument(data,doc.id)) return;
    if(data.activeState===false) return;
    const businessTime=new Date(
      data.claimRequestedAt||data.datetime||data.createdAt||data.sourceUpdatedAt||0
    ).getTime()||0;
    if(cutoff&&businessTime&&businessTime<cutoff) return;
    if(activeIds.has(doc.id)) return;
    const identity=exchangeClaimIdentity(data,doc.id);
    if(identity&&activeClaims.has(identity)) return;
    stale.push(doc.ref);
  });

  for(let index=0;index<stale.length;index+=400){
    const batch=db.batch();
    for(const ref of stale.slice(index,index+400)){
      batch.set(ref,{
        activeState:false,
        status:'exchanged',
        statusLabel:'교환완료',
        sourceStatus:'SUCCESS',
        claimStatus:'SUCCESS',
        resolvedReason:'쿠팡 현재 미처리 교환 목록에서 제외됨',
        resolvedAt:new Date(),
        updatedAt:new Date()
      },{merge:true});
    }
    await batch.commit();
  }

  return {deactivated:stale.length,skipped:false};
}

function exchangeReconcileFrom(fetchedFrom){
  // 직접 조회한 기간 안의 문서만 종료 정리합니다. 조회 범위 밖의 오래된 문서를
  // 추측으로 닫지 않아 실제 진행 중 교환이 사라지는 일을 막습니다.
  return fetchedFrom;
}

export async function syncExchanges(db,config,reconcile=false){
  // 시작/수동 정밀수집에서는 과거 잘못 남은 완료 교환까지 정리할 수 있도록
  // 90일을 확인하고, 평상시 순환 수집은 API 부담을 줄여 31일만 확인합니다.
  const fetched=await fetchExchangeRows(
    config,
    reconcile?90:31,
    10,
    ['RECEIPT','PROGRESS']
  );
  const documents=exchangeDocuments(fetched.rows);
  const saved=await saveAndReconcile(db,'exchange',documents,{
    from:exchangeReconcileFrom(fetched.from),
    complete:fetched.complete,
    reconcile
  });
  // 교환 API가 완전한 응답을 돌려준 주기에는 현재 목록에 없는 과거 active 교환을
  // 매번 정리합니다. 기존에는 정밀수집 때만 실행되어 완료 건이 장시간 남았습니다.
  const direct=await forceCloseStaleCoupangExchanges(
    db,documents,{complete:fetched.complete,from:fetched.from}
  );
  return {
    ...saved,
    deactivated:Number(saved.deactivated||0)+Number(direct.deactivated||0),
    directCleanup:direct,
    directAudit:{
      authority:'coupang-exchange-api-v4',
      verifiedAt:new Date().toISOString(),
      type:'exchange',
      queriedStatuses:fetched.statuses,
      rawRows:fetched.rows.length,
      open:documents.filter(item=>item.activeState!==false).length,
      complete:Boolean(fetched.complete),
      checkedFrom:fetched.from.toISOString()
    }
  };
}

export const coupangClaimsTestHelpers={
  exchangeStatusValue,
  exchangeActiveState,
  exchangeDeliveryCompleted,
  exchangeDocuments,
  rangeWindows,
  exchangeReconcileFrom,
  forceCloseStaleCoupangExchanges,
  isCoupangExchangeDocument,
  exchangeClaimIdentity
};
