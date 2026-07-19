import admin from 'firebase-admin';
import { workflowFields,isClaimTerminal } from './workflow-model.js';
import { upsertDocuments,reconcileOpenDocuments,getCachedDocuments } from './order-store.js';
import { XMLParser } from 'fast-xml-parser';
import iconv from 'iconv-lite';

const API_BASE = 'https://api.11st.co.kr';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false
});

function text(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim();
  }

  if (typeof value === 'object') {
    return String(
      value['#text'] ??
      value.text ??
      value.value ??
      ''
    ).trim();
  }

  return '';
}

function first(object, names) {
  for (const name of names) {
    if (object && object[name] != null) {
      const value = text(object[name]);
      if (value !== '') return value;
    }
  }

  return '';
}

function number(value) {
  const cleaned = text(value).replace(/[^\d.-]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function findOrders(node, depth = 0) {
  if (!node || depth > 8) return [];

  if (Array.isArray(node)) {
    return node.flatMap(item => findOrders(item, depth + 1));
  }

  if (typeof node !== 'object') return [];

  const directKeys = [
    'order',
    'orders',
    'Order',
    'productOrder',
    'productOrders'
  ];

  for (const key of directKeys) {
    if (node[key] != null) {
      const value = node[key];

      if (key.toLowerCase().endsWith('orders') && typeof value === 'object') {
        const nested =
          value.order ??
          value.Order ??
          value.productOrder ??
          value.productOrders;

        if (nested != null) return asArray(nested);
      }

      if (key === 'order' || key === 'Order' || key === 'productOrder') {
        return asArray(value);
      }
    }
  }

  for (const value of Object.values(node)) {
    const found = findOrders(value, depth + 1);
    if (found.length) return found;
  }

  return [];
}

function formatDate(date) {
  const d = new Date(date.getTime() + 9 * 60 * 60 * 1000);

  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
    String(d.getUTCHours()).padStart(2, '0'),
    String(d.getUTCMinutes()).padStart(2, '0')
  ].join('');
}

function parseDate(value) {
  const raw = text(value);

  if (!raw) return new Date().toISOString();

  if (/^\d{12,14}$/.test(raw)) {
    const year = raw.slice(0, 4);
    const month = raw.slice(4, 6);
    const day = raw.slice(6, 8);
    const hour = raw.slice(8, 10);
    const minute = raw.slice(10, 12);
    const second = raw.slice(12, 14) || '00';

    return new Date(
      `${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`
    ).toISOString();
  }

  const normalized = raw
    .replace(/\./g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  const date = new Date(normalized);

  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}

function configFromEnv(env = process.env) {
  return {
    apiKey: String(env.ELEVENST_API_KEY || '').trim(),
    sellerId: String(env.ELEVENST_SELLER_ID || '').trim()
  };
}

export function elevenstConfigFromEnv(env = process.env) {
  return configFromEnv(env);
}

export function isElevenstConfigured(config) {
  return Boolean(config?.apiKey);
}

async function requestXml(config, path) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${API_BASE}${path}`, {
      signal:AbortSignal.timeout(30000),
headers: {
        openapikey: config.apiKey,
        Accept: 'application/xml'
      }
    });

    const buffer = Buffer.from(await response.arrayBuffer());

    const contentType = String(
      response.headers.get('content-type') || ''
    ).toLowerCase();

    const body =
      contentType.includes('euc-kr') ||
      contentType.includes('ks_c_5601') ||
      contentType.includes('cp949')
        ? iconv.decode(buffer, 'euc-kr')
        : (() => {
            const utf8 = buffer.toString('utf8');

            if (
              utf8.includes('encoding="EUC-KR"') ||
              utf8.includes("encoding='EUC-KR'")
            ) {
              return iconv.decode(buffer, 'euc-kr');
            }

            return utf8;
          })();

    if (response.status === 429) {
      const waitMs = [10000, 20000, 40000, 60000][attempt];

      if (attempt === 3) {
        throw new Error('11번가 API 호출 제한(429)이 계속됩니다.');
      }

      console.log(`11번가 API 429 · ${waitMs / 1000}초 후 재시도`);
      await sleep(waitMs);
      continue;
    }

    if (!response.ok) {
      let authMessage = '';

      try {
        const authParsed = parser.parse(body);
        authMessage =
          first(authParsed, ['resultMessage', 'result_text', 'message']) ||
          first(authParsed?.AuthMessage, [
            'resultMessage',
            'result_text',
            'message'
          ]);
      } catch {}

      throw new Error(
        `11번가 API HTTP ${response.status}: ` +
        `${authMessage || body.slice(0, 300)}`
      );
    }

    let parsed;

    try {
      parsed = parser.parse(body);
    } catch {
      throw new Error('11번가 XML 응답 변환에 실패했습니다.');
    }

    const resultCode = first(parsed, [
      'result_code',
      'resultCode',
      'code'
    ]);

    if (resultCode && !['0', '200'].includes(resultCode)) {
      const resultText = first(parsed, [
        'result_text',
        'resultText',
        'message'
      ]);

      throw new Error(
        `11번가 API 오류 ${resultCode}: ${resultText || '알 수 없는 오류'}`
      );
    }

    return parsed;
  }

  throw new Error('11번가 API 요청에 실패했습니다.');
}

function normalizeOrder(row) {
  const orderNo = first(row, [
    'ordNo',
    'orderNo',
    'orderNumber'
  ]);

  const orderProductSequence = first(row, [
    'ordPrdSeq',
    'orderProductSequence',
    'prdSeq'
  ]);

  if (!orderNo) return null;

  const itemKey =
    orderProductSequence ||
    first(row, ['prdNo', 'productNo']) ||
    'item';

  const product = first(row, [
    'prdNm',
    'productName',
    'prdName',
    'itemName'
  ]) || '11번가 상품';

  const option = first(row, [
    'selPrc',
    'optionNm',
    'optionName',
    'optNm',
    'prdOptNm'
  ]);

  const buyer = first(row, [
    'ordNm',
    'recvNm',
    'rcvrNm',
    'buyerName',
    'receiverName'
  ]);

  const phone = first(row, [
    'recvHp',
    'rcvrHp',
    'ordHp',
    'buyerPhone',
    'receiverPhone'
  ]);

  const address = [
    first(row, [
      'recvAddr',
      'rcvrAddr',
      'addr',
      'receiverAddress'
    ]),
    first(row, [
      'recvAddrDetail',
      'rcvrAddrDtl',
      'addrDetail',
      'receiverAddressDetail'
    ])
  ].filter(Boolean).join(' ');

  const deliveryMemo = first(row, [
    'dlvMemo',
    'deliveryMemo',
    'memo'
  ]);

  const quantity = number(
    first(row, ['ordQty', 'qty', 'quantity'])
  ) || 1;

  const amount =
    number(first(row, [
      'ordAmt',
      'ordPayAmt',
      'paymentAmount',
      'totalAmount'
    ])) ||
    number(first(row, [
      'selPrc',
      'salePrice',
      'unitPrice'
    ])) * quantity;

  const datetime = parseDate(
    first(row, [
      'ordDt',
      'payDt',
      'orderDate',
      'paymentDate',
      'createdAt'
    ])
  );

  return {
    id: `elevenst-${orderNo}-${itemKey}`,
    source: 'elevenst',
    market: '11번가',
    eventType: 'order',
    ...workflowFields({source:'elevenst',orderNo,lineId:itemKey,eventType:'order'}),
    orderNo,
    orderProductSequence,
    product,
    option,
    qty: quantity,
    buyer,
    phone,
    address,
    deliveryMemo,
    amount,
    datetime,
    status: 'new',
    statusLabel: '신규주문',
    sourceStatus: 'COMPLETE',
    activeState:true,
    productNo: first(row, ['prdNo', 'productNo']),
    sellerProductCode: first(row, [
      'sellerPrdCd',
      'sellerProductCode'
    ]),
    deliveryCompanyName: first(row, [
      'dlvCpnNm',
      'deliveryCompanyName'
    ]),
    invoiceNumber: first(row, [
      'invoiceNo',
      'trackingNumber',
      'dlvNo'
    ]),
    syncedAt: new Date().toISOString()
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

export async function syncElevenstOrders(
  db,
  config,
  minutes = 30
) {
  if (!isElevenstConfigured(config)) {
    throw new Error('11번가 Open API 키가 등록되지 않았습니다.');
  }

  const now = new Date();
  const from = new Date(now.getTime() - minutes * 60 * 1000);

  const path =
    `/rest/ordservices/complete/` +
    `${formatDate(from)}/${formatDate(now)}`;

  const parsed = await requestXml(config, path);
  const rows = findOrders(parsed);

  const orders = rows
    .map(normalizeOrder)
    .filter(Boolean);

  return {
    connected: true,
    ...(await saveOrders(db, orders))
  };
}

export async function checkElevenstConfiguration(db, config) {
  const configured = isElevenstConfigured(config);

  await db.collection('system').doc('integrations').set(
    {
      elevenst: {
        name: '11번가',
        connected: false,
        configured,
        lastRun: new Date().toISOString(),
        message: configured
          ? 'API 키 등록 완료 · 주문조회 준비'
          : 'Open API 키 등록 필요'
      }
    },
    { merge: true }
  );

  return {
    configured,
    connected: false
  };
}


function mapElevenOrderStatus(row={}){
  const value=first(row,['ordPrdStat','ordStat','orderStatus','status','ordPrdStatNm','ordStatNm']).toUpperCase();
  if(value.includes('PURCHASE_CONFIRMED')||value.includes('PURCHASE_DECIDED')||value.includes('구매확정')) return {status:'purchase_confirmed',statusLabel:'구매확정'};
  if(value.includes('DELIVERED')||value.includes('배송완료')) return {status:'delivered',statusLabel:'배송완료'};
  if(value.includes('DELIVERING')||value.includes('배송중')||value.includes('발송처리')) return {status:'delivering',statusLabel:'배송중'};
  if(value.includes('PACKAGING')||value.includes('발주')||value.includes('배송준비')||value.includes('발송대기')||value.includes('ORDER_CONFIRM')) return {status:'shipping_wait',statusLabel:'발송대기'};
  if(value.includes('CANCEL')||value.includes('취소')) return {status:'cancelled',statusLabel:'취소완료'};
  return {status:'new',statusLabel:'신규주문'};
}

function mapElevenClaim(row={}){
  const value=[first(row,['claimType','claimNm','claimKind']),first(row,['claimStatus','claimStatusNm','claimProcStatus'])].filter(Boolean).join(' ').toUpperCase();
  let eventType='';
  if(value.includes('EXCHANGE')||value.includes('교환')) eventType='exchange';
  else if(value.includes('RETURN')||value.includes('반품')) eventType='return';
  else if(value.includes('CANCEL')||value.includes('취소')) eventType='cancel';
  if(!eventType) return null;
  return {eventType,sourceStatus:value,status:`${eventType}_request`,statusLabel:eventType==='cancel'?'주문취소':eventType==='return'?'반품요청':'교환요청'};
}

function collectRows(node,depth=0){
  if(!node||depth>10) return [];
  if(Array.isArray(node)) return node.flatMap(value=>collectRows(value,depth+1));
  if(typeof node!=='object') return [];
  const ordNo=first(node,['ordNo','orderNo']);
  if(ordNo) return [{...node,ordNo,ordPrdSeq:first(node,['ordPrdSeq','orderProductSequence','prdSeq'])}];
  return Object.values(node).flatMap(value=>collectRows(value,depth+1));
}

export async function syncElevenstStatuses(db,config){
  const cached=await getCachedDocuments(db,{source:'elevenst',activeOnly:true});
  const existing=cached.documents;
  const normalExisting=existing.filter(item=>String(item.eventType||'order')==='order');
  const orderNos=[...new Set(normalExisting.map(item=>String(item.orderNo||'').trim()).filter(Boolean))];
  let checked=0,failed=0;
  const documents=[];

  for(let index=0;index<orderNos.length;index+=20){
    const batch=orderNos.slice(index,index+20);
    try{
      const parsed=await requestXml(config,`/rest/claimservice/orderlistalladdr/${batch.map(encodeURIComponent).join(',')}`);
      for(const row of collectRows(parsed)){
        const ordNo=first(row,['ordNo','orderNo']);
        const ordPrdSeq=first(row,['ordPrdSeq','orderProductSequence','prdSeq']);
        const matches=normalExisting.filter(item=>String(item.orderNo||'')===ordNo&&(!ordPrdSeq||String(item.orderProductSequence||'')===ordPrdSeq));
        for(const previous of matches){
          checked+=1;
          const mapped=mapElevenOrderStatus(row);
          const lineId=String(ordPrdSeq||previous.orderProductSequence||previous.productNo||'item');
          const sourceStatus=first(row,['ordPrdStat','ordStat','orderStatus','status','ordPrdStatNm','ordStatNm']);
          documents.push({
            ...previous,
            id:previous.id,eventType:'order',
            ...workflowFields({source:'elevenst',orderNo:ordNo,lineId,eventType:'order'}),
            status:mapped.status,statusLabel:mapped.statusLabel,sourceStatus,activeState:true,
            invoiceNumber:first(row,['invoiceNo','trackingNumber','dlvNo'])||previous.invoiceNumber||'',
            deliveryCompanyName:first(row,['dlvCpnNm','deliveryCompanyName','deliveryCompany'])||previous.deliveryCompanyName||'',
            sourceUpdatedAt:new Date().toISOString(),syncedAt:new Date().toISOString()
          });

          const claim=mapElevenClaim(row);
          if(claim){
            const claimId=first(row,['claimNo','claimId','claimSeq','ordCnDtsSeq'])||`${ordNo}-${lineId}-${claim.eventType}`;
            const claimDocument={
              ...previous,
              id:`elevenst-${claim.eventType}-${claimId}`,
              eventType:claim.eventType,
              ...workflowFields({source:'elevenst',orderNo:ordNo,lineId,eventType:claim.eventType,claimId}),
              claimId,status:claim.status,statusLabel:claim.statusLabel,sourceStatus:claim.sourceStatus,claimStatus:claim.sourceStatus,
              reason:first(row,['claimReason','claimRsn','reason','reasonText','ordCnDtsRsn','ordCnDtsRsnNm','cancelReason','returnReason','exchangeReason']),
              reasonDetail:first(row,['claimReasonDetail','reasonDetail','reasonEtc','ordCnDtsRsnDetail','ordCnDtsRsnDtl']),
              claimRequestedAt:first(row,['claimDate','claimDt','requestDate'])||new Date().toISOString(),
              sourceUpdatedAt:new Date().toISOString(),syncedAt:new Date().toISOString()
            };
            claimDocument.activeState=!isClaimTerminal(claimDocument);
            if(!claimDocument.activeState){claimDocument.status=claim.eventType==='cancel'?'cancelled':claim.eventType==='return'?'returned':'exchanged';claimDocument.statusLabel='처리완료';}
            documents.push(claimDocument);
          }
        }
      }
    }catch(error){
      failed+=batch.length;
      console.error('11번가 상태조회 실패:',error instanceof Error?error.message:String(error));
    }
    await sleep(1200);
  }

  const saved=await upsertDocuments(db,documents);
  const claimReconciliation={};
  const claimQuota={cloudReads:0,cloudWrites:0};

  if(failed===0){
    for(const eventType of ['cancel','return','exchange']){
      claimReconciliation[eventType]=await reconcileOpenDocuments(db,{
        source:'elevenst',
        eventType,
        currentIds:documents
          .filter(item=>item.eventType===eventType&&item.activeState!==false)
          .map(item=>item.id),
        complete:true,
        reason:'11번가 현재 미처리 클레임 목록에서 제외됨'
      });
      claimQuota.cloudReads+=Number(claimReconciliation[eventType].quota?.cloudReads||0);
      claimQuota.cloudWrites+=Number(claimReconciliation[eventType].quota?.cloudWrites||0);
    }
  }

  return {
    checked,changed:saved.statusChanged,failed,
    changedOrders:saved.changedDocuments,
    createdClaims:saved.createdDocuments.filter(item=>item.eventType!=='order'),
    quota:{
      cloudReads:Number(saved.quota?.cloudReads||0)+claimQuota.cloudReads,
      cloudWrites:Number(saved.quota?.cloudWrites||0)+claimQuota.cloudWrites,
      cacheHits:Number(saved.quota?.cacheHits||0)
    },
    claimReconciliation
  };
}
