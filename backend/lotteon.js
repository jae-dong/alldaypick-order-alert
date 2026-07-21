import admin from 'firebase-admin';
import { workflowFields,isClaimTerminal } from './workflow-model.js';
import { upsertDocuments } from './order-store.js';

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

function statusInfo(row) {
  const raw = [
    'ordStsCd','ordStsNm','dlvStsCd','dlvStsNm','procStsCd','procStsNm',
    'ifTypCd','ifTypNm','workTypCd','workTypNm','dvProcTypCd','dvProcTypNm',
    'ordDtlStsCd','ordDtlStsNm','dtlDlvStsCd','dtlDlvStsNm','deliveryStatus'
  ]
    .map(key => text(row?.[key]))
    .filter(Boolean)
    .join(' ')
    .toUpperCase();

  if (
    raw.includes('RETURN') ||
    raw.includes('회수') ||
    raw.includes('반품')
  ) {
    return {
      eventType: 'return',
      status: 'return_request',
      statusLabel: '반품요청'
    };
  }

  if (
    raw.includes('EXCHANGE') ||
    raw.includes('교환')
  ) {
    return {
      eventType: 'exchange',
      status: 'exchange_request',
      statusLabel: '교환요청'
    };
  }

  if (
    raw.includes('CANCEL') ||
    raw.includes('취소')
  ) {
    return {
      eventType: 'cancel',
      status: 'cancel_request',
      statusLabel: '주문취소'
    };
  }

  if (
    raw.includes('PURCHASE_CONFIRM') ||
    raw.includes('PURCHASE_DECIDED') ||
    raw.includes('구매확정')
  ) {
    return {
      eventType: 'order',
      status: 'purchase_confirmed',
      statusLabel: '구매확정'
    };
  }

  if (
    raw.includes('DELIVERED') ||
    raw.includes('DELIVERY_COMPLETE') ||
    raw.includes('배송완료')
  ) {
    return {
      eventType: 'order',
      status: 'delivered',
      statusLabel: '배송완료'
    };
  }

  if (
    raw.includes('DELIVERING') ||
    raw.includes('SHIPPED') ||
    raw.includes('IN_TRANSIT') ||
    raw.includes('배송중') ||
    raw.includes('발송완료')
  ) {
    return {
      eventType: 'order',
      status: 'delivering',
      statusLabel: '배송중'
    };
  }

  if (
    raw.includes('READY') ||
    raw.includes('PREPARE') ||
    raw.includes('상품준비') ||
    raw.includes('출고지시') ||
    raw.includes('발송대기')
  ) {
    return {
      eventType: 'order',
      status: 'shipping_wait',
      statusLabel: '발송대기'
    };
  }

  // 이 API는 출고/회수지시 조회이므로 별도 상태값이 없어도 주문확인 후 발송대기 건입니다.
  return {
    eventType: 'order',
    status: 'shipping_wait',
    statusLabel: '발송대기'
  };
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

  const idPart =
    deliveryNo ||
    sequence ||
    first(row, ['sitmNo','spdNo','prdNo','productNo','itemNo','productId','skuNo']) ||
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
      'itemPrice'
    ])
  );

  const amount =
    numberValue(
      first(row, [
        'realPayAmt',
        'payAmt',
        'ordAmt',
        'totalAmount',
        'paymentAmount'
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
    eventType: mapped.eventType,
    ...workflowFields({source:'lotteon',orderNo,lineId:idPart,eventType:mapped.eventType,claimId}),
    status: mapped.status,
    statusLabel: mapped.statusLabel,
    sourceStatus: first(row, [
      'ordStsCd',
      'ordStsNm',
      'dlvStsCd',
      'dlvStsNm',
      'procStsCd',
      'procStsNm',
      'ifTypCd',
      'ifTypNm',
      'dvProcTypCd',
      'dvProcTypNm',
      'ordDtlStsCd',
      'ordDtlStsNm',
      'dtlDlvStsCd',
      'dtlDlvStsNm'
    ]),
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

    if(!accepted&&errors.length){
      console.warn('롯데온 조회 형식 재시도:',errors.at(-1));
    }
  }
  return {responses,requestBodies,rawRows,errors};
}

async function queryOrderInstructions(config, minutes, {repair=false}={}) {
  // 출고지시 API는 연동완료된 주문을 더 이상 주지 않을 수 있으므로,
  // 시작/수동수집에서는 배송상태 API도 함께 조회해 현재 상품준비 건을 복구합니다.
  const effectiveMinutes=Math.max(Number(minutes||0),(repair?7:3)*24*60);
  const windows=splitDateWindows(effectiveMinutes,3*24*60);
  const instructions=await queryPathWindows(config,ORDER_PATH,windows);
  let progress={responses:[],requestBodies:[],rawRows:0,errors:[]};

  if(repair||instructions.rawRows===0){
    progress=await queryPathWindows(config,PROGRESS_PATH,windows);
  }

  const responses=[...instructions.responses,...progress.responses];
  if(!responses.length&&[...instructions.errors,...progress.errors].length){
    throw new Error(`롯데온 주문조회 실패: ${[...instructions.errors,...progress.errors].slice(-4).join(' / ')}`);
  }
  return {
    responses,
    requestBodies:[...instructions.requestBodies,...progress.requestBodies],
    instructionRows:instructions.rawRows,
    progressRows:progress.rawRows
  };
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
    requestBodies,
    instructionRows,
    progressRows
  } = await queryOrderInstructions(config, minutes, { repair });

  const rows = responses.flatMap(response => collectRecords(response));
  const orders = [...new Map(
    rows
      .map(row => normalizeOrder(row, config.sellerId))
      .filter(Boolean)
      .map(order => [order.id, order])
  ).values()];

  return {
    connected: true,
    requestBody: requestBodies[requestBodies.length - 1] || null,
    requestBodies,
    rawRows: rows.length,
    instructionRows,
    progressRows,
    repairDiscovery: repair,
    ...(await saveOrders(db, orders))
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
              requestBody: result.requestBody
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

export const lotteonTestHelpers={collectRecords,statusInfo,normalizeOrder,splitDateWindows,productImageFromResponse,lotteonRowIdentity};
