import admin from 'firebase-admin';
import { workflowFields,isClaimTerminal } from './workflow-model.js';
import { upsertDocuments,reconcileOpenDocuments } from './order-store.js';

const API_BASE = 'https://openapi.lotteon.com';
const ORDER_PATH =
  '/v1/openapi/delivery/v1/SellerDeliveryOrdersSearch';
const PRODUCT_DETAIL_PATH='/v1/openapi/product/v1/product/detail';
const PROGRESS_PATH='/v1/openapi/delivery/v1/SellerDeliveryProgressStateSearch';

function value(object, keys) {
  for (const key of keys) {
    if (object && object[key] != null) {
      return object[key];
    }
  }

  return '';
}

function text(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim();
  }

  return '';
}

function first(object, keys) {
  return text(value(object, keys));
}

function numberValue(value) {
  const parsed = Number(
    text(value).replace(/[^\d.-]/g, '')
  );

  return Number.isFinite(parsed) ? parsed : 0;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeImageUrl(value){
  let url=text(value).replaceAll('&amp;','&').replaceAll('\\/','/').replace(/\\u002f/gi,'/');
  if(!url) return '';
  if(url.startsWith('//')) url=`https:${url}`;
  if(/^(?:contents|image|img|static)\.lotteon\.(?:com|net)\//i.test(url)) url=`https://${url}`;
  if(!/^https?:\/\//i.test(url)) return '';
  try{return new URL(url).toString();}catch{return '';}
}
function productImageFromResponse(value,depth=0,parentKey=''){
  if(depth>10||value==null) return '';
  if(typeof value==='string'){
    const raw=value.replaceAll('&amp;','&');
    const html=raw.match(/<img[^>]+(?:src|data-src)=["']([^"']+)["']/i);
    if(html?.[1]) return normalizeImageUrl(html[1]);
    const direct=normalizeImageUrl(raw);
    if(!direct) return '';
    if(/image|img|thumb|photo|pic|url|path/i.test(parentKey)||/\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i.test(direct)) return direct;
    return '';
  }
  if(Array.isArray(value)){
    const ordered=[...value].sort((a,b)=>{
      const score=item=>{
        const type=String(item?.imgTypCd||item?.imageType||item?.imgType||item?.type||'').toUpperCase();
        return /RPRS|REPRESENT|MAIN|THUMB|대표/.test(type)?100-Number(item?.sortSeq||item?.imgSeq||item?.order||0):0;
      };
      return score(b)-score(a);
    });
    for(const item of ordered){const found=productImageFromResponse(item,depth+1,parentKey);if(found)return found;}
    return '';
  }
  if(typeof value!=='object') return '';
  for(const key of [
    'rprsImgUrl','rprsImgFilePath','representativeImageUrl','repImgUrl','mainImageUrl','mainImgUrl',
    'spdImgUrl','sitmImgUrl','prdImgUrl','productImageUrl','goodsImageUrl','imageUrl','imgUrl',
    'imgFullPthNm','imgFullPath','imageFullPath','orgImgUrl','lrgImgUrl','thumbUrl','thumbnailUrl',
    'rprsImg','repImg','mainImg','spdImg','sitmImg','prdImg','image','images','imageList','imgList','spdImgList','sitmImgList'
  ]){
    if(value[key]!=null){const found=productImageFromResponse(value[key],depth+1,key);if(found)return found;}
  }
  for(const [key,item] of Object.entries(value)){
    if(!/image|img|thumb|photo|pic/i.test(key)) continue;
    const found=productImageFromResponse(item,depth+1,key);if(found)return found;
  }
  for(const [key,item] of Object.entries(value)){
    if(item&&typeof item==='object'){
      const found=productImageFromResponse(item,depth+1,key);if(found)return found;
    }
  }
  return '';
}

function messageFrom(body) {
  if (!body || typeof body !== 'object') return '';

  return first(body, [
    'message',
    'msg',
    'resultMessage',
    'resultMsg',
    'errorMessage',
    'error_description'
  ]);
}

function formatDate(date) {
  const formatter = new Intl.DateTimeFormat(
    'sv-SE',
    {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }
  );

  return formatter
    .format(date)
    .replace(/[-:\s]/g, '');
}

function parseDate(value) {
  const raw = text(value);

  if (!raw) return '';

  if (/^\d{14}$/.test(raw)) {
    return new Date(
      `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` +
      `T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}+09:00`
    ).toISOString();
  }

  if (/^\d{12}$/.test(raw)) {
    return new Date(
      `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` +
      `T${raw.slice(8, 10)}:${raw.slice(10, 12)}:00+09:00`
    ).toISOString();
  }

  const date = new Date(raw);

  return Number.isNaN(date.getTime())
    ? ''
    : date.toISOString();
}

function scalarContext(node, inherited = {}) {
  const keys = [
    'ordNo','orderNo','orderNumber','ordId','orderId','odNo','orNo','orderNum',
    'dlvNo','deliveryNo','deliveryId','ifNo','dvNo','deliveryOrderNo','instructionNo',
    'ordDtlSeq','ordItemSeq','itemSeq','prdSeq','orderItemSequence','orderDetailSequence',
    'spdNo','prdNo','productNo','itemNo','sitmNo','productId','skuNo',
    'spdNm','prdNm','productName','itemName','ordItemNm','sitmNm','productTitle',
    'ordDttm','ordDt','payDttm','ifDttm','ifCreDttm','ifCrtDttm','regDttm','createdAt',
    'orderDateTime','paymentDateTime','ordrNm','ordNm','buyerName','receiverName','rcvrNm',
    'ordStsCd','ordStsNm','dlvStsCd','dlvStsNm','procStsCd','procStsNm',
    'ifTypCd','ifTypNm','workTypCd','workTypNm','dvProcTypCd','dvProcTypNm',
    'ordDtlStsCd','ordDtlStsNm','dtlDlvStsCd','dtlDlvStsNm','deliveryStatus',
    'realPayAmt','payAmt','ordAmt','totalAmount','paymentAmount','salePrc','sellPrc',
    'ordQty','qty','quantity','orderQuantity','rprsImgUrl','rprsImgFilePath','repImgUrl','mainImgUrl',
    'spdImgUrl','sitmImgUrl','prdImgUrl','productImageUrl','goodsImageUrl','imageUrl','imgUrl',
    'imgFullPthNm','imgFullPath','thumbUrl','thumbnailUrl','claimNo','claimId','returnNo','exchangeNo','cancelNo'
  ];
  const context = { ...inherited };
  for (const key of keys) {
    const candidate = node?.[key];
    if (candidate != null && ['string','number','boolean'].includes(typeof candidate)) {
      context[key] = candidate;
    }
  }
  return context;
}

function lotteonRowIdentity(row = {}) {
  return [
    first(row,['ordNo','orderNo','orderNumber','ordId','orderId','odNo','orNo','orderNum']),
    first(row,['dlvNo','deliveryNo','deliveryId','ifNo','dvNo','deliveryOrderNo','instructionNo']),
    first(row,['ordDtlSeq','ordItemSeq','itemSeq','prdSeq','orderItemSequence','orderDetailSequence']),
    first(row,['sitmNo','spdNo','prdNo','productNo','itemNo','productId','skuNo'])
  ].join('|');
}

function collectRecords(node, depth = 0, inherited = {}) {
  if (!node || depth > 16) return [];
  if (Array.isArray(node)) return node.flatMap(item => collectRecords(item, depth + 1, inherited));
  if (typeof node !== 'object') return [];

  const context = scalarContext(node, inherited);
  const merged = { ...context, ...node };
  const likelyKeys = [
    'data','result','content','contents','items','itemList','orderList','orders',
    'deliveryOrders','sellerDeliveryOrders','ifList','list','rsltData','resultData',
    'responseData','orderInfos','orderInfoList','deliveryOrderList','ordList','ordDtlList',
    'orderDetailList','itemDetails','itemsInfo','sitmList','spdList','detailList','dtlList',
    'deliveryProgressList','deliveryStateList','sellerDeliveryProgressStates','rows','records'
  ];
  const rows = [];
  const visited = new Set();

  // Traverse children first. Actual LotteON payloads often keep orderNo in a header
  // and product/status in nested detail rows; inherited context merges both levels.
  for (const key of likelyKeys) {
    if (node[key] == null) continue;
    visited.add(key);
    rows.push(...collectRecords(node[key], depth + 1, context));
  }
  for (const [key, child] of Object.entries(node)) {
    if (visited.has(key) || child == null || typeof child !== 'object') continue;
    rows.push(...collectRecords(child, depth + 1, context));
  }

  if (!rows.length) {
    const orderNo = first(merged,[
      'ordNo','orderNo','orderNumber','ordId','orderId','odNo','orNo','orderNum'
    ]);
    const lineSignal = first(merged,[
      'dlvNo','deliveryNo','deliveryId','ifNo','dvNo','deliveryOrderNo','instructionNo',
      'spdNm','prdNm','productName','itemName','ordItemNm','sitmNm','productTitle',
      'sitmNo','spdNo','prdNo','productNo','itemNo','productId','skuNo',
      'ordStsCd','ordStsNm','dlvStsCd','dlvStsNm','procStsCd','procStsNm','deliveryStatus'
    ]);
    if (orderNo && lineSignal) rows.push(merged);
  }

  const unique = new Map();
  for (const row of rows) {
    const key = lotteonRowIdentity(row);
    if (key.replaceAll('|','')) unique.set(key, row);
  }
  return [...unique.values()];
}

function sourceStatusText(row={}){
  return [
    'ordStsCd','ordStsNm','dlvStsCd','dlvStsNm','procStsCd','procStsNm',
    'ifTypCd','ifTypNm','workTypCd','workTypNm','dvProcTypCd','dvProcTypNm',
    'ordDtlStsCd','ordDtlStsNm','dtlDlvStsCd','dtlDlvStsNm','deliveryStatus'
  ]
    .map(key=>text(row?.[key]))
    .filter(Boolean)
    .join(' ')
    .toUpperCase();
}

function statusInfo(row) {
  const raw=sourceStatusText(row);
  const feed=text(row?.__lotteonFeed).toLowerCase();
  const deliveredEvidence=Boolean(first(row,[
    'dlvCmplDttm','deliveryCompleteDate','deliveredDate','deliveryCompletedAt',
    'rcvDttm','purchaseConfirmDate','buyDecisionDate'
  ]));
  const shipmentEvidence=Boolean(first(row,[
    'invNo','invoiceNo','trackingNumber','dlvCpnNm','deliveryCompanyName'
  ]));

  if (
    raw.includes('RETURN') ||
    raw.includes('회수') ||
    raw.includes('반품')
  ) {
    return {eventType:'return',status:'return_request',statusLabel:'반품요청'};
  }

  if (
    raw.includes('EXCHANGE') ||
    raw.includes('교환')
  ) {
    return {eventType:'exchange',status:'exchange_request',statusLabel:'교환요청'};
  }

  if (
    raw.includes('CANCEL') ||
    raw.includes('취소')
  ) {
    return {eventType:'cancel',status:'cancel_request',statusLabel:'주문취소'};
  }

  if (
    raw.includes('PURCHASE_CONFIRM') ||
    raw.includes('PURCHASE_DECIDED') ||
    raw.includes('BUY_DECISION') ||
    raw.includes('구매확정')
  ) {
    return {eventType:'order',status:'purchase_confirmed',statusLabel:'구매확정'};
  }

  if (
    deliveredEvidence ||
    raw.includes('FINAL_DELIVERY') ||
    raw.includes('DELIVERED') ||
    raw.includes('DELIVERY_COMPLETE') ||
    raw.includes('DLV_COMPLETE') ||
    raw.includes('배송완료')
  ) {
    return {eventType:'order',status:'delivered',statusLabel:'배송완료'};
  }

  if (
    raw.includes('DELIVERING') ||
    raw.includes('SHIPPED') ||
    raw.includes('DEPARTURE') ||
    raw.includes('IN_TRANSIT') ||
    raw.includes('DELIVERY_START') ||
    raw.includes('배송중') ||
    raw.includes('발송완료') ||
    raw.includes('출고완료')
  ) {
    return {eventType:'order',status:'delivering',statusLabel:'배송중'};
  }

  if (
    raw.includes('READY') ||
    raw.includes('PREPARE') ||
    raw.includes('INSTRUCT') ||
    raw.includes('상품준비') ||
    raw.includes('출고지시') ||
    raw.includes('발송대기')
  ) {
    return {eventType:'order',status:'shipping_wait',statusLabel:'발송대기'};
  }

  // 배송진행 API의 알 수 없는 상태를 출고지시로 되돌리지 않습니다.
  // 진행 피드에 존재하거나 송장 정보가 있으면 최소 배송중으로 처리해
  // 이미 출고된 주문이 발송대기에 남는 문제를 막습니다.
  if(feed==='progress'||shipmentEvidence){
    return {eventType:'order',status:'delivering',statusLabel:'배송중'};
  }

  // 출고지시 API의 상태값이 생략된 경우에만 발송대기로 봅니다.
  return {eventType:'order',status:'shipping_wait',statusLabel:'발송대기'};
}

function normalizeOrder(row, sellerId) {
  const orderNo = first(row, [
    'ordNo',
    'orderNo',
    'orderNumber',
    'ordId',
    'orderId',
    'odNo',
    'orNo',
    'orderNum'
  ]);

  if (!orderNo) return null;

  const deliveryNo = first(row, [
    'dlvNo',
    'deliveryNo',
    'deliveryId',
    'ifNo',
    'dvNo',
    'deliveryOrderNo',
    'instructionNo'
  ]);

  const sequence = first(row, [
    'ordDtlSeq',
    'ordItemSeq',
    'itemSeq',
    'prdSeq',
    'orderItemSequence',
    'orderDetailSequence'
  ]);

  // 출고지시와 배송진행 API가 서로 다른 deliveryNo를 줄 수 있으므로
  // 주문상세순번/상품번호를 먼저 사용해 동일 상품행의 문서 ID를 안정화합니다.
  const idPart =
    sequence ||
    first(row, ['sitmNo','itemNo','skuNo','spdNo','prdNo','productNo','productId']) ||
    deliveryNo ||
    'item';

  const mapped = statusInfo(row);

  const qty =
    numberValue(
      first(row, [
        'ordQty',
        'qty',
        'quantity',
        'orderQuantity'
      ])
    ) || 1;

  const unitPrice = numberValue(
    first(row, [
      'salePrc',
      'sellPrc',
      'unitPrice',
      'itemPrice',
      'ordPrc',
      'prdPrc'
    ])
  );

  const amount =
    numberValue(
      first(row, [
        'realPayAmt',
        'payAmt',
        'ordAmt',
        'totalAmount',
        'paymentAmount',
        'totPayAmt',
        'ordPayAmt',
        'saleAmt',
        'orderProductAmount'
      ])
    ) ||
    unitPrice * qty;

  const claimId=first(row,['claimNo','claimId','returnNo','exchangeNo','cancelNo'])||`${orderNo}-${idPart}-${mapped.eventType}`;
  const documentId=mapped.eventType==='order'
    ?`lotteon-${orderNo}-${idPart}`
    :`lotteon-${mapped.eventType}-${claimId}`;

  const document={
    id: documentId,
    source: 'lotteon',
    market: '롯데온',
    sellerId,
    sourceFeed:first(row,['__lotteonFeed'])||'unknown',
    eventType: mapped.eventType,
    ...workflowFields({source:'lotteon',orderNo,lineId:idPart,eventType:mapped.eventType,claimId}),
    status: mapped.status,
    statusLabel: mapped.statusLabel,
    sourceStatus: sourceStatusText(row),
    orderNo,
    deliveryNo,
    orderProductSequence: sequence,
    spdNo:first(row,['spdNo','prdNo','productNo','productId']),
    sitmNo:first(row,['sitmNo','itemNo','skuNo']),
    productNo:first(row,['spdNo','prdNo','productNo','productId','sitmNo','itemNo','skuNo']),
    itemNo:first(row,['sitmNo','itemNo']),
    imageUrl:first(row,[
      'rprsImgUrl','rprsImgFilePath','repImgUrl','mainImgUrl','spdImgUrl','sitmImgUrl',
      'prdImgUrl','productImageUrl','goodsImageUrl','imageUrl','imgUrl','imgFullPthNm',
      'imgFullPath','thumbUrl','thumbnailUrl'
    ]),
    product:
      first(row, [
        'spdNm',
        'prdNm',
        'productName',
        'itemName',
        'ordItemNm',
        'sitmNm'
      ]) || '롯데온 상품',
    option: first(row, [
      'itmNm',
      'optNm',
      'optionName',
      'itemOptionName'
    ]),
    qty,
    buyer: first(row, [
      'ordrNm',
      'ordNm',
      'buyerName',
      'receiverName',
      'rcvrNm'
    ]),
    phone: first(row, [
      'rcvrMblNo',
      'rcvrTelNo',
      'buyerPhone',
      'receiverPhone',
      'mobileNo'
    ]),
    address: [
      first(row, [
        'rcvrBscAddr',
        'baseAddress',
        'receiverBaseAddress',
        'addr'
      ]),
      first(row, [
        'rcvrDtlAddr',
        'detailAddress',
        'receiverDetailAddress',
        'addrDtl'
      ])
    ].filter(Boolean).join(' '),
    deliveryMemo: first(row, [
      'dlvMemo',
      'deliveryMemo',
      'ordMemo',
      'memo'
    ]),
    amount,
    unitPrice,
    orderTotalAmount:numberValue(first(row,['realPayAmt','payAmt','totalAmount','paymentAmount','totPayAmt','ordPayAmt'])),
    datetime: parseDate(
      first(row, [
        'ordDttm',
        'ordDt',
        'payDttm',
        'ifDttm',
        'regDttm',
        'createdAt',
        'ifCreDttm',
        'ifCrtDttm',
        'ordCrtDttm',
        'orderDateTime'
      ])
    ),
    deliveryCompanyName: first(row, [
      'dlvCpnNm',
      'deliveryCompanyName',
      'courierName'
    ]),
    invoiceNumber: first(row, [
      'invNo',
      'invoiceNo',
      'trackingNumber'
    ]),
    reason: first(row, [
      'claimRsnNm',
      'reason',
      'reasonName'
    ]),
    reasonDetail: first(row, [
      'claimDtlRsn',
      'reasonDetail',
      'reasonMemo'
    ]),
    claimId:mapped.eventType==='order'?'':claimId,
    claimStatus:mapped.eventType==='order'?'':first(row,['claimStsCd','claimStsNm','procStsCd','procStsNm']),
    activeState:true,
    stateAuthority:'lotteon-api',
    stateVerifiedAt:new Date().toISOString(),
    apiVerifiedOpen:mapped.eventType==='order'
      ?['new','shipping_wait'].includes(mapped.status)
      :true,
    sourceUpdatedAt:first(row,['modDttm','updDttm','ifDttm'])||new Date().toISOString(),
    syncedAt: new Date().toISOString()
  };

  if(mapped.eventType!=='order'){
    document.activeState=!isClaimTerminal(document);
    if(!document.activeState){
      document.status=mapped.eventType==='cancel'?'cancelled':mapped.eventType==='return'?'returned':'exchanged';
      document.statusLabel='처리완료';
    }
  }

  return document;
}

export function lotteonConfigFromEnv(env = process.env) {
  return {
    apiKey: String(env.LOTTEON_API_KEY || '').trim(),
    sellerId: String(env.LOTTEON_SELLER_ID || '').trim(),
    sellerLoginId: String(env.LOTTEON_LOGIN_ID || '').trim()
  };
}

export function isLotteonConfigured(config) {
  return Boolean(config?.apiKey && config?.sellerId);
}

async function requestJson(
  config,
  path,
  {
    method = 'GET',
    body
  } = {}
) {
  const response = await fetch(
    `${API_BASE}${path}`,
    {
      signal:AbortSignal.timeout(30000),
method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept-Language': 'ko',
        'X-Timezone': 'GMT+09:00'
      },
      body:
        body == null
          ? undefined
          : JSON.stringify(body)
    }
  );

  const raw = await response.text();
  let parsed = {};

  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = { raw };
  }

  if (!response.ok) {
    const detail =
      messageFrom(parsed) ||
      raw.slice(0, 400);

    if (response.status === 401) {
      throw new Error(
        `롯데온 인증키 오류(HTTP 401): ${detail}`
      );
    }

    if (response.status === 403) {
      throw new Error(
        `롯데온 출발지 IP 접근거부(HTTP 403): ${detail}`
      );
    }

    throw new Error(
      `롯데온 API HTTP ${response.status}: ${detail}`
    );
  }

  return parsed;
}

export async function resolveLotteonProductImage(config,order={}){
  if(!isLotteonConfigured(config)) return '';
  const spdNo=text(order.spdNo||order.productNo||order.productId);
  if(!spdNo) return '';
  const attempts=[
    {spdNo},
    {spdNo,trNo:config.sellerId},
    {spdNo,sitmNo:text(order.sitmNo||order.itemNo)},
    {spdNo,sitmNo:text(order.sitmNo||order.itemNo),trNo:config.sellerId}
  ].filter((body,index,array)=>array.findIndex(item=>JSON.stringify(item)===JSON.stringify(body))===index);
  let lastError;
  for(const body of attempts){
    try{
      const response=await requestJson(config,PRODUCT_DETAIL_PATH,{method:'POST',body});
      const image=productImageFromResponse(response);
      if(image) return image;
    }catch(error){lastError=error;}
  }
  if(lastError) console.warn('롯데온 상품 썸네일 상세조회 실패:',lastError?.message||lastError);
  return '';
}

export async function testLotteonConnection(config) {
  if (!isLotteonConfigured(config)) {
    throw new Error(
      '롯데온 API 키 또는 거래처번호가 등록되지 않았습니다.'
    );
  }

  const body = await requestJson(
    config,
    '/v1/openapi/common/v1/identity'
  );

  const data =
    body?.data ||
    body?.result ||
    body;

  return {
    connected: true,
    authMode: 'bearer',
    identity: {
      sellerId:
        String(
          value(data, [
            'trNo',
            'lrtrNo',
            'sellerId',
            'accountNumber'
          ]) || config.sellerId
        ),
      sellerName:
        String(
          value(data, [
            'trNm',
            'sellerName',
            'shopName'
          ]) || ''
        )
    },
    raw: data
  };
}

function splitDateWindows(minutes, maxWindowMinutes = 3 * 24 * 60) {
  const end = new Date();
  const start = new Date(end.getTime() - Math.max(1, minutes) * 60000);
  const windows = [];
  let cursor = start;

  while (cursor < end) {
    const next = new Date(Math.min(end.getTime(), cursor.getTime() + maxWindowMinutes * 60000));
    windows.push({ from: new Date(cursor), to: next });
    cursor = next;
  }

  return windows;
}

function dateOnly(date) {
  return formatDate(date).slice(0, 8);
}

function uniqueRequestBodies(base14, base8, config) {
  const raw = [
    base14,
    { ...base14, trNo: config.sellerId },
    base8,
    { ...base8, trNo: config.sellerId },
    { srchStartDt: base14.srchStrtDt, srchEndDt: base14.srchEndDt },
    { srchStartDt: base14.srchStrtDt, srchEndDt: base14.srchEndDt, trNo: config.sellerId }
  ];
  return raw.filter((body,index,array)=>
    array.findIndex(item=>JSON.stringify(item)===JSON.stringify(body))===index
  );
}

async function queryPathWindows(config, apiPath, windows) {
  const responses=[];
  const requestBodies=[];
  const errors=[];
  let rawRows=0;
  let acceptedWindows=0;

  for (const window of windows) {
    const base14={srchStrtDt:formatDate(window.from),srchEndDt:formatDate(window.to)};
    const base8={srchStrtDt:dateOnly(window.from),srchEndDt:dateOnly(window.to)};
    const primary=[base14,{...base14,trNo:config.sellerId}];
    const fallback=[base8,{...base8,trNo:config.sellerId}];
    let accepted=false;
    let windowRows=0;

    for (const body of primary) {
      try {
        const response=await requestJson(config,apiPath,{method:'POST',body});
        const rows=collectRecords(response);
        responses.push(response);
        requestBodies.push(body);
        rawRows+=rows.length;
        windowRows+=rows.length;
        accepted=true;
        if(rows.length>0) break;
      } catch (error) {
        const message=error instanceof Error?error.message:String(error);
        errors.push(`${apiPath}: ${message}`);
        if(message.includes('HTTP 401')||message.includes('HTTP 403')) throw error;
      }
    }

    // 14자리 날짜 계약 자체가 거부된 경우에만 8자리 날짜를 보조로 시도합니다.
    // 정상 200 빈 응답에는 불필요한 형식 재호출을 하지 않아 API 부하를 줄입니다.
    if(!accepted){
      for(const body of fallback){
        try{
          const response=await requestJson(config,apiPath,{method:'POST',body});
          const rows=collectRecords(response);
          responses.push(response);
          requestBodies.push(body);
          rawRows+=rows.length;
          windowRows+=rows.length;
          accepted=true;
          if(rows.length>0) break;
        }catch(error){
          const message=error instanceof Error?error.message:String(error);
          errors.push(`${apiPath}: ${message}`);
          if(message.includes('HTTP 401')||message.includes('HTTP 403')) throw error;
        }
      }
    }

    if(accepted) acceptedWindows+=1;
    if(!accepted&&errors.length){
      console.warn('롯데온 조회 형식 재시도:',errors.at(-1));
    }
  }
  return {
    responses,requestBodies,rawRows,errors,
    acceptedWindows,totalWindows:windows.length,
    complete:windows.length===0||acceptedWindows===windows.length,
    from:windows[0]?.from||null,
    to:windows.at(-1)?.to||null
  };
}

async function queryOrderInstructions(config, minutes, {repair=false}={}) {
  // 출고지시 목록만 보면 이미 처리된 주문이 로컬 캐시에 계속 남을 수 있습니다.
  // 매 주기 배송진행상태를 함께 조회해 현재 상태로 덮어쓰고, 목록에서 사라진
  // 미처리 주문은 안전하게 종료 처리합니다.
  const effectiveMinutes=Math.max(Number(minutes||0),(repair?7:3)*24*60);
  const windows=splitDateWindows(effectiveMinutes,3*24*60);
  const instructions=await queryPathWindows(config,ORDER_PATH,windows);
  const progress=await queryPathWindows(config,PROGRESS_PATH,windows);

  const responses=[...instructions.responses,...progress.responses];
  const errors=[...instructions.errors,...progress.errors];
  if(!responses.length&&errors.length){
    throw new Error(`롯데온 주문조회 실패: ${errors.slice(-4).join(' / ')}`);
  }
  return {
    responses,
    instructionResponses:instructions.responses,
    progressResponses:progress.responses,
    requestBodies:[...instructions.requestBodies,...progress.requestBodies],
    instructionRows:instructions.rawRows,
    progressRows:progress.rawRows,
    instructionComplete:instructions.complete,
    progressComplete:progress.complete,
    reconciliationFrom:progress.from||instructions.from||null,
    queryErrors:errors
  };
}

function lotteonWorkflowKey(order={}){
  if(order.eventType&&order.eventType!=='order'){
    return `claim|${order.eventType}|${order.claimId||order.id}`;
  }
  const line=order.orderProductSequence||order.sitmNo||order.itemNo||order.spdNo||order.productNo||order.deliveryNo||order.product||'item';
  return `order|${order.orderNo||''}|${line}`;
}

function lotteonStatusRank(order={}){
  const rank={
    new:1,shipping_wait:2,delivering:3,delivered:4,purchase_confirmed:5,
    cancel_request:6,return_request:6,exchange_request:6,
    cancelled:7,returned:7,exchanged:7
  };
  return rank[String(order.status||'')]||0;
}

function mergeOrderFields(base={},override={}){
  const merged={...base,...override};
  const preferBaseWhenMissing=[
    'product','option','imageUrl','buyer','phone','address','deliveryMemo',
    'amount','unitPrice','orderTotalAmount','qty','datetime','spdNo','sitmNo',
    'productNo','itemNo','orderProductSequence'
  ];
  for(const key of preferBaseWhenMissing){
    const value=override[key];
    const missing=value==null||value===''||(typeof value==='number'&&value<=0)||
      (key==='product'&&value==='롯데온 상품');
    if(missing&&base[key]!=null&&base[key]!=='') merged[key]=base[key];
  }
  return merged;
}

function mergeLotteonOrders(instructionOrders=[],progressOrders=[]){
  const merged=new Map();
  for(const order of instructionOrders){
    merged.set(lotteonWorkflowKey(order),order);
  }
  for(const order of progressOrders){
    const key=lotteonWorkflowKey(order);
    const previous=merged.get(key);
    if(!previous){
      merged.set(key,order);
      continue;
    }
    const previousTime=new Date(previous.sourceUpdatedAt||previous.syncedAt||0).getTime()||0;
    const currentTime=new Date(order.sourceUpdatedAt||order.syncedAt||0).getTime()||0;
    const preferCurrent=currentTime>=previousTime||lotteonStatusRank(order)>=lotteonStatusRank(previous);
    merged.set(key,preferCurrent?mergeOrderFields(previous,order):mergeOrderFields(order,previous));
  }
  return [...merged.values()];
}

async function saveOrders(db,orders){
  const saved=await upsertDocuments(db,orders);
  return {
    ...saved,
    createdOrders:saved.createdDocuments.filter(item=>item.eventType==='order'&&item.status==='new'),
    createdClaims:saved.createdDocuments.filter(item=>item.eventType!=='order'),
    changedOrders:saved.changedDocuments
  };
}

export async function syncLotteonOrders(
  db,
  config,
  minutes = 30,
  { repair = false } = {}
) {
  if (!isLotteonConfigured(config)) {
    throw new Error(
      '롯데온 API 키 또는 거래처번호가 등록되지 않았습니다.'
    );
  }

  const {
    responses,
    instructionResponses,
    progressResponses,
    requestBodies,
    instructionRows,
    progressRows,
    instructionComplete,
    progressComplete,
    reconciliationFrom,
    queryErrors
  } = await queryOrderInstructions(config, minutes, { repair });

  const instructionRaw=(instructionResponses||[])
    .flatMap(response=>collectRecords(response))
    .map(row=>({...row,__lotteonFeed:'instruction'}));
  const progressRaw=(progressResponses||[])
    .flatMap(response=>collectRecords(response))
    .map(row=>({...row,__lotteonFeed:'progress'}));
  const instructionOrders=[...new Map(
    instructionRaw
      .map(row=>normalizeOrder(row,config.sellerId))
      .filter(Boolean)
      .map(order=>[lotteonWorkflowKey(order),order])
  ).values()];
  const progressOrders=[...new Map(
    progressRaw
      .map(row=>normalizeOrder(row,config.sellerId))
      .filter(Boolean)
      .map(order=>[lotteonWorkflowKey(order),order])
  ).values()];
  // 출고지시 API는 발송 이후에도 출고지시 상태를 계속 반환할 수 있으므로
  // 동일 상품행은 배송진행 API의 최신 상태를 우선합니다.
  const orders=mergeLotteonOrders(instructionOrders,progressOrders);
  const rows=[...instructionRaw,...progressRaw];

  const saved=await saveOrders(db,orders);
  const currentOpenOrderIds=orders
    .filter(item=>item.eventType==='order'&&item.activeState!==false&&['new','shipping_wait'].includes(item.status))
    .map(item=>item.id);

  // 배송진행 API의 모든 날짜 구간이 정상 응답한 경우에만 캐시 정리를 수행합니다.
  // 부분 오류가 난 주기에는 기존 주문을 닫지 않아 오탐을 방지합니다.
  const reconciliation=await reconcileOpenDocuments(db,{
    source:'lotteon',
    eventType:'order',
    currentIds:currentOpenOrderIds,
    from:reconciliationFrom,
    complete:Boolean(progressComplete),
    reason:'롯데온 현재 출고/배송진행 목록에서 제외됨'
  });

  return {
    connected: true,
    requestBody: requestBodies[requestBodies.length - 1] || null,
    requestBodies,
    rawRows: rows.length,
    instructionRows,
    progressRows,
    instructionComplete,
    progressComplete,
    queryErrors,
    repairDiscovery: repair,
    ...saved,
    deactivatedOrders:Number(reconciliation.deactivated||0),
    reconciliation,
    quota:{
      cloudReads:Number(saved.quota?.cloudReads||0)+Number(reconciliation.quota?.cloudReads||0),
      cloudWrites:Number(saved.quota?.cloudWrites||0)+Number(reconciliation.quota?.cloudWrites||0),
      cacheHits:Number(saved.quota?.cacheHits||0)
    },
    directAudit:{
      authority:'lotteon-delivery-api',
      verifiedAt:new Date().toISOString(),
      instructionRows,
      progressRows,
      normalizedRows:orders.length,
      openOrders:orders.filter(item=>item.eventType==='order'&&item.activeState!==false&&['new','shipping_wait'].includes(item.status)).length,
      progressOrders:orders.filter(item=>item.eventType==='order'&&['delivering','delivered','purchase_confirmed'].includes(item.status)).length,
      activeClaims:{
        cancel:orders.filter(item=>item.eventType==='cancel'&&item.activeState!==false).length,
        return:orders.filter(item=>item.eventType==='return'&&item.activeState!==false).length,
        exchange:orders.filter(item=>item.eventType==='exchange'&&item.activeState!==false).length
      },
      missingAmount:orders.filter(item=>item.eventType==='order'&&Number(item.amount||0)<=0).length,
      complete:Boolean(instructionComplete&&progressComplete),
      queryErrors
    }
  };
}

export async function saveLotteonIntegration(
  db,
  result
) {
  await db.collection('system').doc('integrations').set({
    lotteon: {
      name: '롯데온',
      connected: true,
      configured: true,
      lastRun: new Date().toISOString(),
      message:
        result.found == null
          ? `인증 성공 · 거래처 ${result.identity?.sellerId || ''}`
          : (
              `정상 조회 · 발견 ${result.found} · ` +
              `신규 ${result.created} · 상태변경 ${result.statusChanged}`
            ),
      authMode: 'bearer',
      sellerId:
        result.identity?.sellerId ||
        result.sellerId ||
        '',
      sellerName:
        result.identity?.sellerName ||
        '',
      lastResult:
        result.found == null
          ? null
          : {
              found: result.found,
              created: result.created,
              existing: result.existing,
              statusChanged: result.statusChanged,
              requestBody: result.requestBody,
              directAudit:result.directAudit||null
            }
    }
  }, { merge: true });
}

export async function saveLotteonError(
  db,
  config,
  error
) {
  await db.collection('system').doc('integrations').set({
    lotteon: {
      name: '롯데온',
      connected: false,
      configured: isLotteonConfigured(config),
      lastRun: new Date().toISOString(),
      message:
        error instanceof Error
          ? error.message
          : String(error)
    }
  }, { merge: true });
}

export const lotteonTestHelpers={collectRecords,statusInfo,normalizeOrder,splitDateWindows,productImageFromResponse,lotteonRowIdentity,lotteonWorkflowKey,mergeLotteonOrders,queryPathWindows,queryOrderInstructions};
