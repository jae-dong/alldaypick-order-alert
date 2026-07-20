import bcrypt from 'bcrypt';
import { workflowFields,isClaimTerminal } from './workflow-model.js';
import { upsertDocuments,reconcileOpenDocuments,getCachedDocuments } from './order-store.js';

const API_BASE='https://api.commerce.naver.com/external';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function iso(date){return date.toISOString();}
function inquiryIso(date){return date.toISOString().replace(/\.\d{3}Z$/,'Z');}
function signature(clientId,clientSecret,timestamp){
  const hashed=bcrypt.hashSync(`${clientId}_${timestamp}`,clientSecret);
  return Buffer.from(hashed,'utf8').toString('base64');
}
function invalidInputText(body){
  const inputs=Array.isArray(body?.invalidInputs)?body.invalidInputs:[];
  return inputs
    .map(item=>[item?.name,item?.type,item?.message].filter(Boolean).join(' / '))
    .filter(Boolean)
    .join('; ');
}
async function jsonResponse(response,label){
  const text=await response.text();let body;
  try{body=JSON.parse(text);}catch{throw new Error(`${label} 응답 변환 실패(HTTP ${response.status})`);}
  if(!response.ok){
    const invalid=invalidInputText(body);
    const detail=[body?.message||body?.code||text,invalid].filter(Boolean).join(' · ');
    throw new Error(`${label} HTTP ${response.status}: ${detail}`);
  }
  return body;
}
async function accessToken(config){
  const timestamp=Date.now();
  const params=new URLSearchParams({client_id:config.clientId,timestamp:String(timestamp),client_secret_sign:signature(config.clientId,config.clientSecret,timestamp),grant_type:'client_credentials',type:'SELF'});
  const response=await fetch(`${API_BASE}/v1/oauth2/token`,{method:'POST',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:params});
  const body=await jsonResponse(response,'스마트스토어 인증');
  const token=body.access_token||body.accessToken||body.data?.access_token||body.data?.accessToken;
  if(!token) throw new Error('스마트스토어 인증 토큰이 응답에 없습니다.');
  return token;
}
async function api(token,path,options={}){
  const method=String(options.method||'GET').toUpperCase();
  const headers={
    Accept:'application/json',
    Authorization:`Bearer ${token}`,
    ...(options.body||!['GET','HEAD'].includes(method)?{'Content-Type':'application/json'}:{}),
    ...(options.headers||{})
  };
  const response=await fetch(`${API_BASE}${path}`,{
    signal:AbortSignal.timeout(45000),
    ...options,
    method,
    headers
  });
  return jsonResponse(response,`스마트스토어 API ${path.split('?')[0]}`);
}
function rows(body){
  if(Array.isArray(body)) return body;
  for(const value of [body?.data,body?.data?.contents,body?.data?.content,body?.contents,body?.content,body?.data?.lastChangeStatuses,body?.lastChangeStatuses]) if(Array.isArray(value)) return value;
  return [];
}
function detailRows(body){return rows(body);}
function upper(...values){return values.filter(Boolean).join(' ').toUpperCase();}

function firstImageUrl(value,depth=0){
  if(depth>6||value==null) return '';
  if(typeof value==='string'){
    const text=value.trim();
    if(/^https?:\/\//i.test(text)) return text;
    if(text.startsWith('//')) return `https:${text}`;
    return '';
  }
  if(Array.isArray(value)){
    for(const item of value){
      const found=firstImageUrl(item,depth+1);
      if(found) return found;
    }
    return '';
  }
  if(typeof value!=='object') return '';
  for(const key of ['representativeImage','representativeImageUrl','productImageUrl','imageUrl','thumbnailUrl','images','url']){
    if(value[key]!=null){
      const found=firstImageUrl(value[key],depth+1);
      if(found) return found;
    }
  }
  for(const [key,item] of Object.entries(value)){
    if(!/image|thumb|photo/i.test(key)) continue;
    const found=firstImageUrl(item,depth+1);
    if(found) return found;
  }
  return '';
}

export async function resolveSmartstoreProductImage(config,channelProductNo){
  const productNo=String(channelProductNo||'').trim();
  if(!productNo||!config?.clientId||!config?.clientSecret) return '';
  const token=await accessToken(config);
  const body=await api(token,`/v2/products/channel-products/${encodeURIComponent(productNo)}`);
  return firstImageUrl(body?.data||body);
}

function orderStatus(productOrder={},row={}){
  const productStatus=upper(productOrder.productOrderStatus,productOrder.status);
  const placeOrderStatus=upper(productOrder.placeOrderStatus,row.placeOrderStatus);
  const lastChangedType=upper(productOrder.lastChangedType,row.lastChangedType);
  const hasPlaceOrder=Boolean(
    productOrder.placeOrderDate||row.placeOrderDate||
    placeOrderStatus.includes('OK')||
    lastChangedType.includes('PLACE_ORDER')
  );

  if(productStatus.includes('PURCHASE_DECIDED')) return ['purchase_confirmed','구매확정'];
  if(productStatus.includes('DELIVERED')) return ['delivered','배송완료'];
  if(productStatus.includes('DELIVERING')||lastChangedType.includes('DISPATCHED')) return ['delivering','배송중'];
  if(productStatus.includes('CANCEL')||productStatus.includes('RETURN')||productStatus.includes('EXCHANGE')) return ['cancelled','처리완료'];
  // Naver keeps productOrderStatus as PAYED after seller confirmation.
  // placeOrderStatus=OK/placeOrderDate is the authoritative confirmation signal.
  if(hasPlaceOrder||productStatus.includes('DISPATCH_WAITING')||productStatus.includes('PRODUCT_PREPARE')) return ['shipping_wait','발송대기'];
  if(productStatus.includes('PAYED')||productStatus.includes('PAYMENT_WAITING')||productStatus.includes('NEW')) return ['new','신규주문'];
  return [String(productOrder.productOrderStatus||productOrder.status||'unknown').toLowerCase(),'주문'];
}
function claimTypeOf(productOrder={},claim={}){
  const raw=upper(claim.claimType,productOrder.claimType,claim.claimStatus,productOrder.claimStatus);
  if(raw.includes('EXCHANGE')) return 'exchange';
  if(raw.includes('RETURN')) return 'return';
  if(raw.includes('CANCEL')) return 'cancel';
  return '';
}
function normalizeDetail(row){
  const order=row.order||row.orderInfo||{};
  const productOrder=row.productOrder||row.productOrderInfo||row.productOrderDetail||row;
  const productOrderId=String(productOrder.productOrderId||row.productOrderId||'');
  if(!productOrderId) return [];

  const orderNo=String(order.orderId||productOrder.orderId||row.orderId||productOrderId);
  const [status,statusLabel]=orderStatus(productOrder,row);
  const product=productOrder.productName||productOrder.productOrderName||productOrder.itemName||'스마트스토어 상품';
  const base={
    source:'smartstore',market:'스마트스토어',orderNo,productOrderId,product,
    productId:String(productOrder.productId||row.productId||''),
    originalProductId:String(productOrder.originalProductId||row.originalProductId||''),
    merchantChannelId:String(productOrder.merchantChannelId||row.merchantChannelId||''),
    imageUrl:firstImageUrl(productOrder)||firstImageUrl(row),
    option:productOrder.productOption||productOrder.optionCode||productOrder.optionName||'',
    qty:Number(productOrder.quantity||productOrder.productOrderQuantity||1),
    buyer:order.ordererName||productOrder.shippingAddress?.name||productOrder.shippingAddress?.receiverName||'',
    phone:order.ordererTel||order.ordererTelephone||productOrder.shippingAddress?.tel1||productOrder.shippingAddress?.telephone1||productOrder.shippingAddress?.receiverTel||'',
    address:[productOrder.shippingAddress?.baseAddress,productOrder.shippingAddress?.detailedAddress].filter(Boolean).join(' '),
    deliveryMemo:productOrder.shippingAddress?.deliveryMemo||productOrder.deliveryMemo||'',
    amount:Number(productOrder.totalPaymentAmount||productOrder.totalProductAmount||Number(productOrder.unitPrice||0)*Number(productOrder.quantity||1)||0),
    datetime:order.paymentDate||productOrder.paymentDate||productOrder.orderDate||new Date().toISOString(),
    orderDate:order.orderDate||productOrder.orderDate||'',paymentDate:order.paymentDate||productOrder.paymentDate||'',
    invoiceNumber:productOrder.trackingNumber||productOrder.invoiceNumber||'',
    deliveryCompanyName:productOrder.deliveryCompany||productOrder.deliveryMethod||'',
    placeOrderStatus:productOrder.placeOrderStatus||row.placeOrderStatus||'',
    placeOrderDate:productOrder.placeOrderDate||row.placeOrderDate||'',
    lastChangedType:productOrder.lastChangedType||row.lastChangedType||'',
    sourceUpdatedAt:productOrder.lastChangedDate||row.lastChangedDate||productOrder.claimStatusDate||new Date().toISOString(),syncedAt:new Date().toISOString()
  };

  const output=[{
    ...base,id:`smartstore-${productOrderId}`,eventType:'order',
    ...workflowFields({source:'smartstore',orderNo,lineId:productOrderId,eventType:'order'}),
    status,statusLabel,sourceStatus:productOrder.productOrderStatus||productOrder.status||'',activeState:true
  }];

  const currentClaim=row.currentClaim||productOrder.currentClaim||{};
  const currentCandidates=[
    {type:'cancel',value:currentClaim.cancel},
    {type:'return',value:currentClaim.return},
    {type:'exchange',value:currentClaim.exchange}
  ].filter(candidate=>candidate.value&&typeof candidate.value==='object');

  // currentClaim is authoritative. Deprecated claim objects are used only when
  // currentClaim is absent, preventing the same request from being counted twice.
  const claimCandidates=currentCandidates.length?currentCandidates:[
    {type:'cancel',value:row.cancel||row.cancelInfo||productOrder.cancel},
    {type:'return',value:row.return||row.returnInfo||row.returnClaim||productOrder.return},
    {type:'exchange',value:row.exchange||row.exchangeInfo||productOrder.exchange},
    {type:'',value:row.claim||row.claimInfo||productOrder.claim}
  ].filter(candidate=>candidate.value&&typeof candidate.value==='object');

  if(!claimCandidates.length&&claimTypeOf(productOrder,productOrder)){
    claimCandidates.push({type:'',value:productOrder});
  }

  const seen=new Set();
  for(const candidate of claimCandidates){
    const claim=candidate.value||{};
    const eventType=candidate.type||claimTypeOf(productOrder,claim);
    if(!eventType) continue;

    const claimId=String(
      claim.claimId||claim.cancelRequestId||claim.returnRequestId||claim.exchangeRequestId||
      claim.requestId||productOrder.claimId||`${productOrderId}-${eventType}`
    );
    const documentId=`smartstore-${eventType}-${claimId}`;
    if(seen.has(documentId)) continue;
    seen.add(documentId);

    const claimStatus=claim.claimStatus||claim.status||productOrder.claimStatus||'';
    const claimDocument={
      ...base,id:documentId,eventType,
      ...workflowFields({source:'smartstore',orderNo,lineId:productOrderId,eventType,claimId}),
      claimId,status:`${eventType}_request`,statusLabel:eventType==='cancel'?'주문취소':eventType==='return'?'반품요청':'교환요청',
      sourceStatus:claimStatus,claimStatus,
      claimRequestedAt:claim.requestDate||claim.claimRequestDate||claim.requestedAt||productOrder.claimRequestDate||base.sourceUpdatedAt,
      reason:claim.claimReason||claim.reason||claim.reasonCode||productOrder.claimReason||'',
      reasonDetail:claim.claimDetailedReason||claim.reasonDetail||claim.reasonMemo||'',
      modifiedAt:claim.lastChangedDate||claim.claimStatusDate||claim.updatedAt||base.sourceUpdatedAt,
      processingStatus:claim.processingStatus||claim.processStatus||'',
      resultStatus:claim.resultStatus||'',
      receiptStatus:claim.receiptStatus||'',
      exchangeStatus:claim.exchangeStatus||''
    };
    claimDocument.activeState=!isClaimTerminal(claimDocument);
    if(!claimDocument.activeState){
      claimDocument.status=eventType==='cancel'?'cancelled':eventType==='return'?'returned':'exchanged';
      claimDocument.statusLabel='처리완료';
    }
    output.push(claimDocument);
  }

  return output;
}
function splitDateRange(from,to,maxHours=23){
  const ranges=[];
  let cursor=new Date(from);
  const maxMs=maxHours*3600000;
  while(cursor<to){
    const end=new Date(Math.min(to.getTime(),cursor.getTime()+maxMs));
    ranges.push({from:new Date(cursor),to:end});
    if(end.getTime()>=to.getTime()) break;
    // 경계 시각을 1초 겹쳐 조회하고 ID로 중복 제거해 누락을 막습니다.
    cursor=new Date(end.getTime()-1000);
  }
  return ranges;
}
function rateLimited(error){return /429|too many requests|요청이 많아/i.test(String(error?.message||error));}
async function retry(task,label){
  const delays=[30000,60000,120000];
  for(let attempt=0;attempt<=delays.length;attempt+=1){
    try{return await task();}catch(error){if(!rateLimited(error)||attempt>=delays.length) throw error;console.warn(`${label} 요청 제한 · ${delays[attempt]/1000}초 뒤 재시도`);await sleep(delays[attempt]);}
  }
}
async function changedProductOrderIds(token,from,to){
  const ids=[];
  let nextFrom=new Date(from);
  let moreSequence='';

  for(let page=0;page<100;page+=1){
    const params=new URLSearchParams({
      lastChangedFrom:iso(nextFrom),
      lastChangedTo:iso(to),
      limitCount:'300'
    });
    if(moreSequence) params.set('moreSequence',moreSequence);

    const body=await api(
      token,
      `/v1/pay-order/seller/product-orders/last-changed-statuses?${params}`
    );

    rows(body).forEach(row=>{
      const id=String(row.productOrderId||row.productOrder?.productOrderId||'');
      if(id) ids.push(id);
    });

    const more=body?.data?.more||body?.more;
    if(!more?.moreFrom||more?.moreSequence==null) break;

    const parsedMoreFrom=new Date(more.moreFrom);
    if(Number.isNaN(parsedMoreFrom.getTime())){
      throw new Error('스마트스토어 다음 페이지 moreFrom 형식이 올바르지 않습니다.');
    }

    nextFrom=parsedMoreFrom;
    moreSequence=String(more.moreSequence);
  }

  return ids;
}
async function queryDetails(token,ids){
  const documents=[];
  for(let index=0;index<ids.length;index+=300){
    const batch=ids.slice(index,index+300);
    const body=await retry(()=>api(token,'/v1/pay-order/seller/product-orders/query',{method:'POST',body:JSON.stringify({productOrderIds:batch})}),`스마트스토어 상세조회 ${Math.floor(index/300)+1}`);
    documents.push(...detailRows(body).flatMap(normalizeDetail));
    if(index+300<ids.length) await sleep(2500);
  }
  return documents;
}
function inquiryArray(body){
  const candidates=[
    body,body?.data,body?.data?.contents,body?.data?.content,
    body?.contents,body?.content,body?.data?.items,body?.items
  ];
  for(const candidate of candidates){
    if(Array.isArray(candidate)) return {items:candidate,recognized:true};
  }
  return {items:[],recognized:false};
}
function inquiryDoc(row,kind){
  const inquiryId=String(
    row.questionId||row.inquiryNo||row.inquiryId||row.id||''
  );
  if(!inquiryId) return null;

  const claimId=`${kind}-${inquiryId}`;
  const answerObject=row.answer&&typeof row.answer==='object'?row.answer:{};
  const answerContent=String(
    row.answerContent||answerObject.content||answerObject.answerContent||
    (typeof row.answer==='string'?row.answer:'')||''
  ).trim();
  const answerStatus=upper(row.answerStatus,row.status,row.inquiryStatus);
  const answered=
    row.answered===true||
    Boolean(
      answerContent||row.answerDate||row.answeredAt||
      row.answerRegistrationDateTime
    )||
    answerStatus.includes('ANSWERED')||
    answerStatus.includes('답변완료');

  const orderNo=String(row.orderId||row.orderNo||row.productOrderId||'');
  const productOrderId=String(
    row.productOrderId||
    String(row.productOrderIdList||'').split(',')[0].trim()||
    ''
  );
  const lineId=String(
    row.productId||row.productNo||productOrderId||'inquiry'
  );
  const inquiryAt=
    row.createDate||row.inquiryRegistrationDateTime||
    row.createdAt||row.inquiryDate||new Date().toISOString();

  return {
    id:`smartstore-inquiry-${kind}-${claimId}`,
    source:'smartstore',market:'스마트스토어',eventType:'inquiry',
    ...workflowFields({source:'smartstore',orderNo,lineId,eventType:'inquiry',claimId}),
    orderNo,claimId,inquiryId,productOrderId,
    product:row.productName||row.title||'스마트스토어 문의',
    option:row.productOrderOption||'',
    qty:1,buyer:row.customerName||row.writerName||row.maskedWriterId||'',
    phone:'',amount:0,datetime:inquiryAt,inquiryAt,
    status:answered?'answered':'inquiry',
    statusLabel:answered?'답변완료':'문의사항',
    sourceStatus:answered?'ANSWERED':'NOANSWER',
    inquiryStatus:answered?'ANSWERED':'NOANSWER',
    inquiryKind:kind,
    content:row.question||row.inquiryContent||row.content||'',
    answered,activeState:!answered,
    inquiryVerificationVersion:1,
    lastVerifiedAt:new Date().toISOString(),
    sourceUpdatedAt:
      row.answerRegistrationDateTime||row.answerDate||row.updatedAt||
      inquiryAt,
    syncedAt:new Date().toISOString()
  };
}
function inquiryPageMeta(body){
  const root=body?.data&&typeof body.data==='object'&&!Array.isArray(body.data)
    ?body.data
    :body;
  const totalPages=Number(root?.totalPages??body?.totalPages??0);
  const currentPage=Number(root?.page??root?.currentPage??body?.page??body?.currentPage??0);
  const last=root?.last??body?.last;
  return {
    totalPages:Number.isFinite(totalPages)?totalPages:0,
    currentPage:Number.isFinite(currentPage)?currentPage:0,
    last:last===true
  };
}
function inquiryRanges(days,maxDays=29){
  // 문의 API는 날짜 범위를 엄격하게 검증하므로 30일 미만으로 분할합니다.
  // PC 시계와 서버 시계의 수초 차이로 종료 시각이 미래로 판정되는 것도 막습니다.
  const now=new Date(Date.now()-10000);
  const start=new Date(now.getTime()-Math.max(1,days)*86400000);
  const ranges=[];
  let cursor=start;
  while(cursor<now){
    const end=new Date(Math.min(now.getTime(),cursor.getTime()+maxDays*86400000));
    ranges.push({from:new Date(cursor),to:end});
    if(end.getTime()>=now.getTime()) break;
    cursor=new Date(end.getTime()-1000);
  }
  return ranges;
}
async function fetchInquiryPages(token,path,paramsForPage,{size=100,maxPages=30}={}){
  const items=[];
  let complete=false;

  for(let page=1;page<=maxPages;page+=1){
    const params=new URLSearchParams(paramsForPage(page,size));
    const suffix=params.toString()?`?${params}`:'';
    const body=await api(token,`${path}${suffix}`);
    const extracted=inquiryArray(body);
    if(!extracted.recognized){
      throw new Error(`${path} 응답 목록 형식을 확인할 수 없습니다.`);
    }

    items.push(...extracted.items);
    const meta=inquiryPageMeta(body);

    if(
      meta.last||
      (meta.totalPages>0&&page>=meta.totalPages)||
      (meta.totalPages===0&&extracted.items.length<size)
    ){
      complete=true;
      break;
    }

    if(page<maxPages) await sleep(400);
  }

  return {items,complete};
}
function badRequest(error){
  return /HTTP 400|BAD_REQUEST|잘못된 요청|명세에 맞지 않는 입력/i.test(String(error?.message||''));
}
async function fetchProductInquiryRange(token,range){
  const common=(page,size)=>({
    page:String(page),
    size:String(size),
    fromDate:inquiryIso(range.from),
    toDate:inquiryIso(range.to)
  });
  const profiles=[
    (page,size)=>({...common(page,size),answered:'false'}),
    common
  ];

  let lastError;
  for(const profile of profiles){
    try{
      return await fetchInquiryPages(token,'/v1/contents/qnas',profile);
    }catch(error){
      lastError=error;
      if(!badRequest(error)) throw error;
    }
  }
  throw lastError||new Error('스마트스토어 상품문의 조회 실패');
}
async function fetchProductInquiries(token,days){
  const all=[];
  let complete=true;

  for(const range of inquiryRanges(days,29)){
    const result=await fetchProductInquiryRange(token,range);
    all.push(...result.items);
    complete=complete&&result.complete;
    await sleep(300);
  }

  return {items:all,complete};
}
function inquiryDateOnly(date){
  return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(date);
}
function customerInquiryProfiles(range){
  const base={
    startSearchDate:inquiryDateOnly(range.from),
    endSearchDate:inquiryDateOnly(range.to),
    answered:'false'
  };
  // 공식 지원 답변에는 page로 안내되는 경우와 pgae로 표기된 경우가 함께 있어
  // 실제 게이트웨이 호환성을 위해 두 키를 순서대로 시도합니다.
  return [
    (page,size)=>({...base,page:String(page),size:String(size)}),
    (page,size)=>({...base,pgae:String(page),size:String(size)}),
    (page,size)=>({startSearchDate:base.startSearchDate,endSearchDate:base.endSearchDate,page:String(page),size:String(size)}),
    (page,size)=>({startSearchDate:base.startSearchDate,endSearchDate:base.endSearchDate,pgae:String(page),size:String(size)})
  ];
}
async function fetchCustomerInquiryRange(token,range){
  let lastError;
  for(const profile of customerInquiryProfiles(range)){
    try{
      return await fetchInquiryPages(
        token,
        '/v1/pay-user/inquiries',
        profile,
        {size:200,maxPages:100}
      );
    }catch(error){
      lastError=error;
      if(!badRequest(error)) throw error;
    }
  }
  throw lastError||new Error('스마트스토어 고객문의 조회 실패');
}
async function fetchCustomerInquiries(token,days){
  const all=[];
  let complete=true;
  // 날짜 형식은 yyyy-MM-dd이며, 과도한 단일 조회를 피하도록 7일 미만 단위로 나눕니다.
  for(const range of inquiryRanges(days,6)){
    const result=await fetchCustomerInquiryRange(token,range);
    all.push(...result.items);
    complete=complete&&result.complete;
    await sleep(300);
  }
  return {items:all,complete};
}
export async function syncSmartstoreInquiries(db,config,{reconcile=false}={}){
  const token=await accessToken(config);
  const documents=[];
  const errors=[];
  let complete=true;
  let rateLimitedResult=false;
  const days=reconcile?90:7;
  const from=new Date(Date.now()-days*86400000);
  const to=new Date();

  try{
    const product=await fetchProductInquiries(token,days);
    complete=complete&&product.complete;
    documents.push(
      ...product.items.map(row=>inquiryDoc(row,'product')).filter(Boolean)
    );
  }catch(error){
    complete=false;
    rateLimitedResult=rateLimitedResult||rateLimited(error);
    errors.push(`상품문의: ${error.message}`);
    console.warn('스마트스토어 상품문의 조회 건너뜀:',error.message);
  }

  try{
    const customer=await fetchCustomerInquiries(token,days);
    complete=complete&&customer.complete;
    documents.push(
      ...customer.items.map(row=>inquiryDoc(row,'customer')).filter(Boolean)
    );
  }catch(error){
    complete=false;
    rateLimitedResult=rateLimitedResult||rateLimited(error);
    errors.push(`고객문의: ${error.message}`);
    console.warn('스마트스토어 고객문의 조회 건너뜀:',error.message);
  }

  const unique=[...new Map(documents.map(item=>[item.id,item])).values()];
  const saved=await upsertDocuments(db,unique);
  const reconciled=reconcile&&complete
    ?await reconcileOpenDocuments(db,{
        source:'smartstore',eventType:'inquiry',
        currentIds:unique.filter(item=>item.activeState!==false).map(item=>item.id),
        from,complete:true,
        reason:'스마트스토어 답변완료 또는 현재 미답변 목록에서 제외됨'
      })
    :{deactivated:0,skipped:true};

  return {
    ...saved,createdClaims:saved.createdDocuments,
    changedClaims:saved.changedDocuments,
    deactivated:reconciled.deactivated||0,
    quota:{
      cloudReads:Number(saved.quota?.cloudReads||0)+Number(reconciled.quota?.cloudReads||0),
      cloudWrites:Number(saved.quota?.cloudWrites||0)+Number(reconciled.quota?.cloudWrites||0),
      cacheHits:Number(saved.quota?.cacheHits||0)
    },
    complete,days,rateLimited:rateLimitedResult,errors
  };
}

function isLegacyInquiryCacheStale(item,{minAgeMs=2*60*60*1000,now=Date.now()}={}){
  if(item?.lastVerifiedAt||Number(item?.inquiryVerificationVersion||0)>=1) return false;
  const time=new Date(
    item?.sourceUpdatedAt||item?.inquiryAt||item?.datetime||item?.createdAt||0
  ).getTime();
  return !Number.isFinite(time)||now-time>=Math.max(0,Number(minAgeMs||0));
}

export async function retireLegacySmartstoreInquiryCache(db,{minAgeMs=2*60*60*1000,now=Date.now()}={}){
  const cached=await getCachedDocuments(db,{
    source:'smartstore',eventType:'inquiry',activeOnly:true,hydrate:false
  });
  const stale=cached.documents.filter(item=>
    isLegacyInquiryCacheStale(item,{minAgeMs,now})
  );
  if(!stale.length){
    return {found:0,statusChanged:0,deactivated:0,quota:{cloudReads:0,cloudWrites:0,cacheHits:0}};
  }
  const retired=stale.map(item=>({
    ...item,
    answered:true,
    activeState:false,
    status:'verification_expired',
    statusLabel:'문의 확인 만료',
    sourceStatus:'LEGACY_CACHE_RETIRED',
    inquiryStatus:'LEGACY_CACHE_RETIRED',
    legacyCacheRetiredAt:new Date(now).toISOString(),
    resolvedReason:'v7.6.5 이전 문의 캐시 정리 · 다음 정상 API 조회 시 미답변 문의 자동 복구'
  }));
  const saved=await upsertDocuments(db,retired);
  return {...saved,deactivated:retired.length};
}

export const smartstoreTestHelpers={
  inquiryDoc,orderStatus,normalizeDetail,
  inquiryPageMeta,
  inquiryRanges,
  inquiryIso,
  inquiryDateOnly,
  customerInquiryProfiles,
  retireLegacySmartstoreInquiryCache,
  isLegacyInquiryCacheStale
};

export async function syncSmartstore(db,config,minutes=30,{reconcile=false}={}){
  const token=await accessToken(config);
  const now=new Date();
  const from=new Date(now.getTime()-minutes*60000);
  const ranges=splitDateRange(from,now,23);
  const idSet=new Set();

  for(const [index,range] of ranges.entries()){
    const ids=await retry(
      ()=>changedProductOrderIds(token,range.from,range.to),
      `스마트스토어 변경내역 ${index+1}`
    );
    ids.forEach(id=>idSet.add(id));
    if(index<ranges.length-1) await sleep(2500);
  }

  if(reconcile){
    // Include both open orders and open claims. A return/exchange can remain open
    // after the normal order has already left the shipping workflow.
    const cached=await getCachedDocuments(db,{source:'smartstore',activeOnly:true});
    cached.documents.forEach(data=>{
      if(data.productOrderId) idSet.add(String(data.productOrderId));
    });
  }

  const ids=[...idSet];
  if(!ids.length){
    return {
      connected:true,found:0,created:0,existing:0,statusChanged:0,
      createdOrders:[],createdClaims:[],rangeCount:ranges.length,
      claimReconcile:{cancel:0,return:0,exchange:0}
    };
  }

  const documents=await queryDetails(token,ids);
  const saved=await upsertDocuments(db,documents);
  const claimReconcile={cancel:0,return:0,exchange:0};
  const claimQuota={cloudReads:0,cloudWrites:0};

  if(reconcile){
    for(const eventType of ['cancel','return','exchange']){
      const currentIds=documents
        .filter(item=>item.eventType===eventType&&item.activeState!==false)
        .map(item=>item.id);
      const result=await reconcileOpenDocuments(db,{
        source:'smartstore',
        eventType,
        currentIds,
        complete:true,
        reason:'스마트스토어 현재 미처리 클레임에서 제외됨'
      });
      claimReconcile[eventType]=result.deactivated||0;
      claimQuota.cloudReads+=Number(result.quota?.cloudReads||0);
      claimQuota.cloudWrites+=Number(result.quota?.cloudWrites||0);
    }
  }

  return {
    connected:true,...saved,
    createdOrders:saved.createdDocuments.filter(item=>item.eventType==='order'&&item.status==='new'),
    createdClaims:saved.createdDocuments.filter(item=>item.eventType!=='order'),
    rangeCount:ranges.length,
    quota:{
      cloudReads:Number(saved.quota?.cloudReads||0)+claimQuota.cloudReads,
      cloudWrites:Number(saved.quota?.cloudWrites||0)+claimQuota.cloudWrites,
      cacheHits:Number(saved.quota?.cacheHits||0)
    },
    claimReconcile
  };
}
