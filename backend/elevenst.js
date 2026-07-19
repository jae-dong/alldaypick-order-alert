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


function statusText(row={}){
  return [
    first(row,['ordPrdStat','ordStat','orderStatus','status']),
    first(row,['ordPrdStatNm','ordStatNm','orderStatusName','statusName']),
    first(row,['dlvStat','deliveryStatus','deliveryState','procStat']),
    first(row,['dlvStatNm','deliveryStatusName','deliveryStateName','procStatNm'])
  ].filter(Boolean).join(' ').toUpperCase();
}

function mapElevenOrderStatus(row={},previous={}){
  const value=statusText(row);
  const invoice=first(row,[
    'invoiceNo','trackingNumber','waybillNo','waybillNo','송장번호'
  ]);

  if(value.includes('PURCHASE_CONFIRMED')||value.includes('PURCHASE_DECIDED')||value.includes('구매확정')){
    return {status:'purchase_confirmed',statusLabel:'구매확정',sourceStatus:value||'PURCHASE_CONFIRMED'};
  }
  if(value.includes('DELIVERED')||value.includes('FINAL_DELIVERY')||value.includes('배송완료')){
    return {status:'delivered',statusLabel:'배송완료',sourceStatus:value||'DELIVERED'};
  }
  if(
    value.includes('DELIVERING')||value.includes('DEPARTURE')||
    value.includes('SHIPPED')||value.includes('배송중')||
    value.includes('발송처리')||invoice
  ){
    return {status:'delivering',statusLabel:'배송중',sourceStatus:value||'INVOICE_REGISTERED'};
  }
  if(value.includes('CANCEL')||value.includes('취소')){
    return {status:'cancelled',statusLabel:'취소완료',sourceStatus:value||'CANCELLED'};
  }
  if(
    value.includes('PACKAGING')||value.includes('ORDER_CONFIRM')||
    value.includes('PREPARE')||value.includes('READY')||
    value.includes('발주')||value.includes('배송준비')||
    value.includes('발송대기')||value==='COMPLETE'||
    value.includes('ORDER_COMPLETE')
  ){
    return {status:'shipping_wait',statusLabel:'발송대기',sourceStatus:value||'ORDER_CONFIRMED'};
  }
  if(
    value.includes('PAYMENT')||value.includes('PAYED')||
    value.includes('ACCEPT')||value.includes('NEW')||
    value.includes('결제완료')
  ){
    return {status:'new',statusLabel:'신규주문',sourceStatus:value||'PAYMENT_COMPLETE'};
  }

  // 11번가 배송지/클레임 응답은 상태 문구가 비어 있거나 배송관리번호(dlvNo)만
  // 내려오는 경우가 있습니다. dlvNo는 송장번호가 아니므로 배송중으로 판정하지 않습니다.
  // 방금 COMPLETE 주문조회로 들어온 신규는 명확한 발주확인 신호가 없으면 신규를 유지하고,
  // 과거 잘못 종료된 주문은 현재 상태 확인 대상으로 다시 살릴 수 있도록 발송대기로 복구합니다.
  const previousStatus=String(previous?.status||'');
  const previousSource=String(previous?.sourceStatus||'').toUpperCase();
  if(
    previousStatus==='new'&&
    ['COMPLETE','PAYMENT_COMPLETE','PAYED','ACCEPT','NEW'].some(token=>previousSource.includes(token))
  ){
    return {
      status:'new',statusLabel:'신규주문',
      sourceStatus:previousSource||'PAYMENT_COMPLETE',
      inferred:true,previousStatus
    };
  }
  return {
    status:'shipping_wait',
    statusLabel:'발송대기',
    sourceStatus:value||'ORDER_CONFIRMED',
    inferred:true,
    previousStatus
  };
}

function mapElevenClaim(row={}){
  const value=[
    first(row,['claimType','claimNm','claimKind']),
    first(row,['claimStatus','claimStatusNm','claimProcStatus'])
  ].filter(Boolean).join(' ').toUpperCase();
  let eventType='';
  if(value.includes('EXCHANGE')||value.includes('교환')) eventType='exchange';
  else if(value.includes('RETURN')||value.includes('반품')) eventType='return';
  else if(value.includes('CANCEL')||value.includes('취소')) eventType='cancel';
  if(!eventType) return null;
  return {
    eventType,sourceStatus:value,status:`${eventType}_request`,
    statusLabel:eventType==='cancel'?'주문취소':eventType==='return'?'반품요청':'교환요청'
  };
}

function ownScalarFields(node){
  const fields={};
  if(!node||typeof node!=='object'||Array.isArray(node)) return fields;
  for(const [key,value] of Object.entries(node)){
    if(value==null||typeof value==='string'||typeof value==='number'||typeof value==='boolean'){
      fields[key]=value;
    }else if(typeof value==='object'&&!Array.isArray(value)&&value['#text']!=null){
      fields[key]=value;
    }
  }
  return fields;
}

function collectRows(node,depth=0,inherited={}){
  if(!node||depth>12) return [];
  if(Array.isArray(node)){
    return node.flatMap(value=>collectRows(value,depth+1,inherited));
  }
  if(typeof node!=='object') return [];

  const context={...inherited,...ownScalarFields(node)};
  const childRows=[];
  for(const value of Object.values(node)){
    if(value&&typeof value==='object'){
      childRows.push(...collectRows(value,depth+1,context));
    }
  }
  if(childRows.length) return childRows;

  const ordNo=first(context,['ordNo','orderNo']);
  if(!ordNo) return [];
  const ordPrdSeq=first(context,['ordPrdSeq','orderProductSequence','prdSeq']);
  const recordSignal=Boolean(
    ordPrdSeq||statusText(context)||
    first(context,['invoiceNo','trackingNumber','waybillNo','waybillNo'])||
    first(context,['claimType','claimNm','claimKind','claimStatus','claimStatusNm','claimProcStatus'])
  );
  if(!recordSignal) return [];
  return [{...context,ordNo,ordPrdSeq}];
}

async function fetchStatusRows(config,batch){
  const requested=[...new Set(batch.map(String).filter(Boolean))];
  const requestedSet=new Set(requested);
  const parsed=await requestXml(
    config,
    `/rest/claimservice/orderlistalladdr/${requested.map(encodeURIComponent).join(',')}`
  );
  let rows=collectRows(parsed).filter(row=>requestedSet.has(first(row,['ordNo','orderNo'])));

  // The gateway can return only part of a multi-order request. Re-query every
  // missing order individually before deciding that the refresh is complete.
  const responded=new Set(rows.map(row=>first(row,['ordNo','orderNo'])).filter(Boolean));
  const missing=requested.filter(orderNo=>!responded.has(orderNo));
  for(const orderNo of missing){
    const single=await requestXml(
      config,
      `/rest/claimservice/orderlistalladdr/${encodeURIComponent(orderNo)}`
    );
    const singleRows=collectRows(single).filter(row=>first(row,['ordNo','orderNo'])===String(orderNo));
    rows.push(...singleRows);
    if(singleRows.length) responded.add(orderNo);
    await sleep(350);
  }

  const unique=new Map();
  for(const row of rows){
    const key=[
      first(row,['ordNo','orderNo']),
      first(row,['ordPrdSeq','orderProductSequence','prdSeq']),
      statusText(row),
      first(row,['invoiceNo','trackingNumber','waybillNo'])
    ].join('|');
    unique.set(key,row);
  }
  return {
    rows:[...unique.values()],
    complete:requested.every(orderNo=>responded.has(orderNo)),
    missingOrderNos:requested.filter(orderNo=>!responded.has(orderNo))
  };
}

function statusRefreshDocuments(existing=[],now=Date.now()){
  const repairLookbackMs=90*24*60*60*1000;
  const recentEnough=item=>{
    const raw=item?.datetime||item?.orderDate||item?.paymentDate||item?.sourceUpdatedAt||'';
    const time=new Date(raw).getTime();
    return Number.isFinite(time)&&now-time<=repairLookbackMs;
  };
  const normalExisting=existing.filter(item=>
    String(item.eventType||'order')==='order'&&(
      item.activeState!==false||
      ['new','shipping_wait'].includes(String(item.status||''))||
      recentEnough(item)
    )
  );
  const activeClaims=existing.filter(item=>
    String(item.eventType||'order')!=='order'&&item.activeState!==false
  );
  return {normalExisting,activeClaims};
}

export async function syncElevenstStatuses(db,config,{repair=false}={}){
  // Include inactive documents that still carry a pending status. This repairs
  // records incorrectly deactivated by an earlier partial status response.
  const cached=await getCachedDocuments(db,{source:'elevenst',activeOnly:false});
  let existing=[...(cached.documents||[])];

  // v7.6.3 이전에는 11번가 주문이 배송관리번호(dlvNo) 때문에 배송중으로
  // 잘못 종료될 수 있었습니다. 시작/수동수집 때만 11번가 문서를 제한 조회해
  // 로컬 캐시에 없는 비활성 주문도 다시 상태 확인 대상으로 복구합니다.
  if(repair&&typeof db?.collection==='function'){
    try{
      let query=db.collection('orders').where('source','==','elevenst');
      if(typeof query.limit==='function') query=query.limit(500);
      const snapshot=await query.get();
      const remote=[];
      snapshot.forEach(doc=>remote.push({id:doc.id,...(doc.data()||{})}));
      existing=[...new Map([...existing,...remote].map(item=>[String(item.id),item])).values()];
    }catch(error){
      console.warn('11번가 과거 상태 보정 조회 건너뜀:',error instanceof Error?error.message:String(error));
    }
  }
  const {normalExisting,activeClaims}=statusRefreshDocuments(existing);
  const orderNos=[...new Set(
    [...normalExisting,...activeClaims]
      .map(item=>String(item.orderNo||'').trim())
      .filter(Boolean)
  )];
  let checked=0,failed=0,recognizedRows=0;
  let allResponsesComplete=true;
  const missingOrderNos=[];
  const documents=[];

  for(let index=0;index<orderNos.length;index+=10){
    const batch=orderNos.slice(index,index+10);
    try{
      const fetched=await fetchStatusRows(config,batch);
      const rows=fetched.rows;
      recognizedRows+=rows.length;
      if(!fetched.complete){
        allResponsesComplete=false;
        failed+=fetched.missingOrderNos.length;
        missingOrderNos.push(...fetched.missingOrderNos);
      }
      for(const row of rows){
        const ordNo=first(row,['ordNo','orderNo']);
        const ordPrdSeq=first(row,['ordPrdSeq','orderProductSequence','prdSeq']);
        const orderMatches=normalExisting.filter(item=>String(item.orderNo||'')===ordNo);
        const exactMatches=ordPrdSeq
          ?orderMatches.filter(item=>String(item.orderProductSequence||'')===ordPrdSeq)
          :orderMatches;
        // 일부 11번가 응답은 ordPrdSeq 형식이 기존 주문 문서와 다르게 내려옵니다.
        // 주문번호가 일치하면 해당 주문의 모든 상품줄에 같은 현재 상태를 적용합니다.
        const matches=exactMatches.length?exactMatches:orderMatches;
        for(const previous of matches){
          checked+=1;
          const mapped=mapElevenOrderStatus(row,previous);
          const lineId=String(ordPrdSeq||previous.orderProductSequence||previous.productNo||'item');
          documents.push({
            ...previous,
            id:previous.id,eventType:'order',
            ...workflowFields({source:'elevenst',orderNo:ordNo,lineId,eventType:'order'}),
            status:mapped.status,statusLabel:mapped.statusLabel,
            sourceStatus:mapped.sourceStatus,
            activeState:['new','shipping_wait'].includes(mapped.status),
            invoiceNumber:first(row,['invoiceNo','trackingNumber','waybillNo','waybillNo'])||previous.invoiceNumber||'',
            deliveryCompanyName:first(row,['dlvCpnNm','deliveryCompanyName','deliveryCompany'])||previous.deliveryCompanyName||'',
            statusInferred:Boolean(mapped.inferred),
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
              claimId,status:claim.status,statusLabel:claim.statusLabel,
              sourceStatus:claim.sourceStatus,claimStatus:claim.sourceStatus,
              reason:first(row,['claimReason','claimRsn','reason','reasonText','ordCnDtsRsn','ordCnDtsRsnNm','cancelReason','returnReason','exchangeReason']),
              reasonDetail:first(row,['claimReasonDetail','reasonDetail','reasonEtc','ordCnDtsRsnDetail','ordCnDtsRsnDtl']),
              claimRequestedAt:first(row,['claimDate','claimDt','requestDate'])||new Date().toISOString(),
              sourceUpdatedAt:new Date().toISOString(),syncedAt:new Date().toISOString()
            };
            claimDocument.activeState=!isClaimTerminal(claimDocument);
            if(!claimDocument.activeState){
              claimDocument.status=claim.eventType==='cancel'?'cancelled':claim.eventType==='return'?'returned':'exchanged';
              claimDocument.statusLabel='처리완료';
            }
            documents.push(claimDocument);
          }
        }
      }
    }catch(error){
      failed+=batch.length;
      allResponsesComplete=false;
      missingOrderNos.push(...batch);
      console.error('11번가 상태조회 실패:',error instanceof Error?error.message:String(error));
    }
    await sleep(1200);
  }

  const unique=[...new Map(documents.map(item=>[item.id,item])).values()];
  const saved=await upsertDocuments(db,unique);
  const reconciliation={};
  const reconciliationQuota={cloudReads:0,cloudWrites:0};
  const responseComplete=
    failed===0&&allResponsesComplete&&
    (orderNos.length===0||recognizedRows>0);

  if(responseComplete){
    reconciliation.order=await reconcileOpenDocuments(db,{
      source:'elevenst',eventType:'order',
      currentIds:unique
        .filter(item=>item.eventType==='order'&&['new','shipping_wait'].includes(item.status))
        .map(item=>item.id),
      complete:true,
      reason:'11번가 현재 신규/발송대기 목록에서 제외됨'
    });
    reconciliationQuota.cloudReads+=Number(reconciliation.order.quota?.cloudReads||0);
    reconciliationQuota.cloudWrites+=Number(reconciliation.order.quota?.cloudWrites||0);

    for(const eventType of ['cancel','return','exchange']){
      reconciliation[eventType]=await reconcileOpenDocuments(db,{
        source:'elevenst',eventType,
        currentIds:unique
          .filter(item=>item.eventType===eventType&&item.activeState!==false)
          .map(item=>item.id),
        complete:true,
        reason:'11번가 현재 미처리 클레임 목록에서 제외됨'
      });
      reconciliationQuota.cloudReads+=Number(reconciliation[eventType].quota?.cloudReads||0);
      reconciliationQuota.cloudWrites+=Number(reconciliation[eventType].quota?.cloudWrites||0);
    }
  }

  return {
    checked,changed:saved.statusChanged,failed,recognizedRows,
    missingOrderNos:[...new Set(missingOrderNos)],
    deactivatedOrders:reconciliation.order?.deactivated||0,
    changedOrders:saved.changedDocuments,
    createdClaims:saved.createdDocuments.filter(item=>item.eventType!=='order'),
    quota:{
      cloudReads:Number(saved.quota?.cloudReads||0)+reconciliationQuota.cloudReads,
      cloudWrites:Number(saved.quota?.cloudWrites||0)+reconciliationQuota.cloudWrites,
      cacheHits:Number(saved.quota?.cacheHits||0)
    },
    reconciliation
  };
}

export const elevenstTestHelpers={
  mapElevenOrderStatus,collectRows,statusText,fetchStatusRows,statusRefreshDocuments
};
