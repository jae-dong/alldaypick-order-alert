import admin from 'firebase-admin';
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

async function saveOrders(db, orders) {
  let created = 0;
  let existing = 0;
  let statusChanged = 0;
  const createdOrders = [];

  for (const order of orders) {
    const ref = db.collection('orders').doc(order.id);

    const outcome = await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);

      if (!snapshot.exists) {
        transaction.create(ref, {
          ...order,
          readStatus: 'unread',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return 'created';
      }

      const before = snapshot.data() || {};
      const changed =
        before.status !== order.status ||
        before.sourceStatus !== order.sourceStatus ||
        Number(before.qty || 0) !== Number(order.qty || 0) ||
        String(before.invoiceNumber || '') !==
          String(order.invoiceNumber || '');

      transaction.set(
        ref,
        {
          ...order,
          createdAt:
            before.createdAt ||
            admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      return changed ? 'changed' : 'existing';
    });

    if (outcome === 'created') {
      created += 1;
      createdOrders.push(order);
    } else if (outcome === 'changed') {
      statusChanged += 1;
    } else {
      existing += 1;
    }
  }

  return {
    found: orders.length,
    created,
    existing,
    statusChanged,
    createdOrders
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


function mapElevenStatus(row = {}) {
  const value = [
    first(row, ['ordPrdStat','ordStat','orderStatus','status','ordPrdStatNm','ordStatNm']),
    first(row, ['claimType','claimStatus','claimNm','claimStatusNm'])
  ].filter(Boolean).join(' ').toUpperCase();

  if (value.includes('CANCEL') || value.includes('취소')) {
    return { eventType:'cancel', status:'cancel_request', statusLabel:'주문취소' };
  }
  if (value.includes('EXCHANGE') || value.includes('교환')) {
    return { eventType:'exchange', status:'exchange_request', statusLabel:'교환요청' };
  }
  if (value.includes('RETURN') || value.includes('반품')) {
    return { eventType:'return', status:'return_request', statusLabel:'반품요청' };
  }
  if (
    value.includes('PURCHASE_CONFIRMED') ||
    value.includes('PURCHASE_DECIDED') ||
    value.includes('구매확정')
  ) {
    return {
      eventType:'order',
      status:'purchase_confirmed',
      statusLabel:'구매확정'
    };
  }

  if (value.includes('DELIVERED') || value.includes('배송완료')) {
    return {
      eventType:'order',
      status:'delivered',
      statusLabel:'배송완료'
    };
  }
  if (value.includes('DELIVERING') || value.includes('배송중') || value.includes('발송처리')) {
    return { eventType:'order', status:'delivering', statusLabel:'배송중' };
  }
  if (value.includes('PACKAGING') || value.includes('발주') || value.includes('배송준비') || value.includes('발송대기')) {
    return { eventType:'order', status:'shipping_wait', statusLabel:'발송대기' };
  }
  return { eventType:'order', status:'new', statusLabel:'신규주문' };
}

function collectRows(node, depth = 0) {
  if (!node || depth > 10) return [];
  if (Array.isArray(node)) return node.flatMap(v => collectRows(v, depth + 1));
  if (typeof node !== 'object') return [];

  const ordNo = first(node, ['ordNo','orderNo']);
  if (ordNo) {
    return [{
      ...node,
      ordNo,
      ordPrdSeq:first(node,['ordPrdSeq','orderProductSequence','prdSeq'])
    }];
  }

  return Object.values(node).flatMap(v => collectRows(v, depth + 1));
}

export async function syncElevenstStatuses(db, config) {
  const snap = await db.collection('orders').where('source','==','elevenst').get();
  const existing = snap.docs.map(doc => ({ id:doc.id, ...doc.data() }));
  const orderNos = [...new Set(existing.map(o => String(o.orderNo || '').trim()).filter(Boolean))];

  let checked = 0;
  let changed = 0;
  let failed = 0;
  const changedOrders = [];

  for (let i = 0; i < orderNos.length; i += 20) {
    const batch = orderNos.slice(i, i + 20);

    try {
      const parsed = await requestXml(
        config,
        `/rest/claimservice/orderlistalladdr/${batch.map(encodeURIComponent).join(',')}`
      );

      const rows = collectRows(parsed);

      for (const row of rows) {
        const ordNo = first(row,['ordNo','orderNo']);
        const ordPrdSeq = first(row,['ordPrdSeq','orderProductSequence','prdSeq']);
        const mapped = mapElevenStatus(row);
        const sourceStatus = first(row,['ordPrdStat','ordStat','orderStatus','status','ordPrdStatNm','ordStatNm']);
        const invoiceNumber = first(row,[
          'invoiceNo',
          'trackingNumber',
          'dlvNo'
        ]);

        const deliveryCompanyName = first(row,[
          'dlvCpnNm',
          'deliveryCompanyName',
          'deliveryCompany'
        ]);

        const reason = first(row,[
          'claimReason',
          'claimRsn',
          'reason',
          'reasonText',
          'ordCnDtsRsn',
          'ordCnDtsRsnNm',
          'cancelReason',
          'returnReason',
          'exchangeReason'
        ]);

        const reasonDetail = first(row,[
          'claimReasonDetail',
          'reasonDetail',
          'reasonEtc',
          'ordCnDtsRsnDetail',
          'ordCnDtsRsnDtl'
        ]);

        const matches = existing.filter(o =>
          String(o.orderNo || '') === String(ordNo) &&
          (!ordPrdSeq || String(o.orderProductSequence || '') === String(ordPrdSeq))
        );

        for (const order of matches) {
          checked += 1;
          const isChanged =
            order.status !== mapped.status ||
            order.eventType !== mapped.eventType ||
            String(order.sourceStatus || '') !== String(sourceStatus || '') ||
            String(order.invoiceNumber || '') !== String(invoiceNumber || '');

          const update = {
            eventType:mapped.eventType,
            status:mapped.status,
            statusLabel:mapped.statusLabel,
            sourceStatus,
            invoiceNumber:invoiceNumber || order.invoiceNumber || '',
            deliveryCompanyName:
              deliveryCompanyName ||
              order.deliveryCompanyName ||
              '',
            reason:reason || order.reason || '',
            reasonDetail:reasonDetail || order.reasonDetail || '',
            syncedAt:new Date().toISOString(),
            updatedAt:admin.firestore.FieldValue.serverTimestamp()
          };

          await db.collection('orders').doc(order.id).set(
            update,
            { merge:true }
          );

          if (isChanged) {
            changed += 1;

            changedOrders.push({
              ...order,
              ...update,
              previousStatus:order.status || '',
              previousStatusLabel:order.statusLabel || '',
              previousEventType:order.eventType || 'order'
            });
          }
        }
      }
    } catch (error) {
      failed += batch.length;
      console.error('11번가 상태조회 실패:', error instanceof Error ? error.message : String(error));
    }

    await sleep(1200);
  }

  return {
    checked,
    changed,
    failed,
    changedOrders
  };
}
