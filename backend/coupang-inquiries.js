import crypto from 'node:crypto';
import { workflowFields } from './workflow-model.js';
import { upsertDocuments,reconcileOpenDocuments } from './order-store.js';
import { enrichWithParentOrderContext } from './parent-order-context.js';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function signedDate(){return new Date().toISOString().split('.')[0].replaceAll(':','').replaceAll('-','').slice(2)+'Z';}
function dateOnly(date){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(date);}
function auth({method,path,query,accessKey,secretKey}){
  const datetime=signedDate();
  const signature=crypto.createHmac('sha256',secretKey).update(`${datetime}${method}${path}${query}`).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;
}
async function request(config,path,params){
  const method='GET';
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
        const wait=[10000,20000,40000,60000][attempt];
        if(attempt===3) throw new Error(`쿠팡 문의 API HTTP ${response.status}: 재시도 후 실패`);
        await sleep(wait);continue;
      }
      let payload;
      try{payload=JSON.parse(raw);}catch{throw new Error(`쿠팡 문의 응답 변환 실패(HTTP ${response.status})`);}
      if(!response.ok) throw new Error(`쿠팡 문의 API HTTP ${response.status}: ${payload?.message||raw}`);
      if(payload?.code!=null&&Number(payload.code)!==200) throw new Error(`쿠팡 문의 API 오류 ${payload.code}: ${payload.message||'알 수 없는 오류'}`);
      return payload;
    }catch(error){
      if((error?.name==='TimeoutError'||error?.name==='AbortError')&&attempt<3){await sleep([5000,10000,20000][attempt]);continue;}
      throw error;
    }
  }
  throw new Error('쿠팡 문의 API 요청 실패');
}
function windows(days=31){
  const now=new Date();const start=new Date(now.getTime()-days*86400000);const result=[];let cursor=start;
  while(cursor<now){
    const end=new Date(Math.min(now.getTime(),cursor.getTime()+6*86400000));
    result.push({from:new Date(cursor),to:end});cursor=new Date(end.getTime()+86400000);
  }
  return result;
}
async function fetchPaged(config,path,baseParams,maxPageSize){
  const rows=[];let complete=true;
  for(let pageNum=1;pageNum<=100;pageNum+=1){
    const payload=await request(config,path,{...baseParams,pageNum:String(pageNum),pageSize:String(maxPageSize)});
    const pageRows=Array.isArray(payload?.data?.content)?payload.data.content:[];
    rows.push(...pageRows);
    const totalPages=Number(payload?.data?.pagination?.totalPages||1);
    if(pageNum>=totalPages||pageRows.length===0) break;
    if(pageNum===100) complete=false;
    await sleep(500);
  }
  return {rows,complete};
}
function productDocument(row){
  const inquiryId=String(row.inquiryId||'');if(!inquiryId) return null;
  const claimId=`product-${inquiryId}`;
  const orderNo=String(Array.isArray(row.orderIds)&&row.orderIds.length?row.orderIds[0]:'');
  const lineId=String(row.vendorItemId||row.sellerItemId||row.productId||'inquiry');
  return {
    id:`coupang-inquiry-product-${claimId}`,source:'coupang',market:'쿠팡',eventType:'inquiry',
    ...workflowFields({source:'coupang',orderNo,lineId,eventType:'inquiry',claimId}),
    orderNo,claimId,inquiryId,vendorItemId:lineId,product:row.itemName||row.productName||'쿠팡 상품문의',
    qty:1,buyer:'',phone:'',amount:0,datetime:row.inquiryAt||new Date().toISOString(),inquiryAt:row.inquiryAt||'',
    status:'inquiry',statusLabel:'문의사항',sourceStatus:'NOANSWER',inquiryStatus:'NOANSWER',
    inquiryKind:'product',content:row.content||'',activeState:true,answered:false,
    sourceUpdatedAt:row.inquiryAt||new Date().toISOString(),syncedAt:new Date().toISOString()
  };
}
function callCenterDocument(row,queryStatus='NO_ANSWER'){
  const inquiryId=String(row.inquiryId||'');if(!inquiryId) return null;
  const claimId=`call-${inquiryId}`;
  const orderNo=String(row.orderId||'');
  const vendorItems=Array.isArray(row.vendorItemId)?row.vendorItemId:row.vendorItemId?[row.vendorItemId]:[];
  const lineId=String(vendorItems[0]||'inquiry');
  const counselingStatus=String(row.csPartnerCounselingStatus||row.partnerCounselingStatus||queryStatus);
  const inquiryStatus=String(row.inquiryStatus||'progress');
  return {
    id:`coupang-inquiry-call-${claimId}`,source:'coupang',market:'쿠팡',eventType:'inquiry',
    ...workflowFields({source:'coupang',orderNo,lineId,eventType:'inquiry',claimId}),
    orderNo,claimId,inquiryId,vendorItemId:lineId,product:row.itemName||'쿠팡 고객센터 문의',
    qty:1,buyer:'',phone:row.buyerPhone||'',amount:0,datetime:row.inquiryAt||new Date().toISOString(),inquiryAt:row.inquiryAt||'',
    status:'inquiry',statusLabel:'문의사항',sourceStatus:queryStatus,
    inquiryStatus,partnerCounselingStatus:queryStatus,csPartnerCounselingStatus:counselingStatus,
    inquiryKind:queryStatus==='TRANSFER'?'call_center_confirm':'call_center_answer',
    content:row.content||'',reason:row.receiptCategory||'',activeState:true,answered:false,
    sourceUpdatedAt:row.inquiryAt||new Date().toISOString(),syncedAt:new Date().toISOString()
  };
}


export async function syncCoupangInquiries(db,config,reconcile=false){
  const current=[];let complete=true;const from=new Date(Date.now()-31*86400000);
  const productPath=`/v2/providers/openapi/apis/api/v5/vendors/${encodeURIComponent(config.vendorId)}/onlineInquiries`;
  const callPath=`/v2/providers/openapi/apis/api/v5/vendors/${encodeURIComponent(config.vendorId)}/callCenterInquiries`;

  for(const window of windows(31)){
    const product=await fetchPaged(config,productPath,{
      vendorId:config.vendorId,answeredType:'NOANSWER',inquiryStartAt:dateOnly(window.from),inquiryEndAt:dateOnly(window.to)
    },50);
    complete=complete&&product.complete;
    current.push(...product.rows.map(productDocument).filter(Boolean));
    await sleep(700);
    for(const queryStatus of ['NO_ANSWER','TRANSFER']){
      const call=await fetchPaged(config,callPath,{
        vendorId:config.vendorId,
        partnerCounselingStatus:queryStatus,
        inquiryStartAt:dateOnly(window.from),
        inquiryEndAt:dateOnly(window.to)
      },30);
      complete=complete&&call.complete;
      current.push(...call.rows.map(row=>callCenterDocument(row,queryStatus)).filter(Boolean));
      await sleep(700);
    }
  }

  const unique=[...new Map(current.map(item=>[item.id,item])).values()];
  const enriched=await enrichWithParentOrderContext(db,unique,{source:'coupang'});
  const saved=await upsertDocuments(db,enriched);
  const reconciled=reconcile?await reconcileOpenDocuments(db,{
    source:'coupang',eventType:'inquiry',currentIds:enriched.map(item=>item.id),from,complete,
    reason:'쿠팡 문의 답변완료 또는 현재 미답변 목록에서 제외됨'
  }):{deactivated:0,skipped:true};
  return {...saved,createdClaims:saved.createdDocuments,changedClaims:saved.changedDocuments,deactivated:reconciled.deactivated||0,complete};
}
