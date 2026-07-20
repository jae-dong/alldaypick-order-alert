import admin from 'firebase-admin';
import { workflowFields,isClaimTerminal } from './workflow-model.js';
import { upsertDocuments } from './order-store.js';

const API_BASE = 'https://openapi.lotteon.com';
const ORDER_PATH =
  '/v1/openapi/delivery/v1/SellerDeliveryOrdersSearch';

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

  if (!raw) return new Date().toISOString();

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
    ? new Date().toISOString()
    : date.toISOString();
}

function collectRecords(node, depth = 0) {
  if (!node || depth > 12) return [];

  if (Array.isArray(node)) {
    return node.flatMap(item => collectRecords(item, depth + 1));
  }

  if (typeof node !== 'object') return [];

  const orderNo = first(node, [
    'ordNo',
    'orderNo',
    'ordId',
    'orderId'
  ]);

  const deliveryNo = first(node, [
    'dlvNo',
    'deliveryNo',
    'deliveryId',
    'ifNo'
  ]);

  const productName = first(node, [
    'spdNm',
    'prdNm',
    'productName',
    'itemName',
    'ordItemNm'
  ]);

  if (orderNo && (deliveryNo || productName)) {
    return [node];
  }

  const likelyKeys = [
    'data',
    'result',
    'content',
    'contents',
    'items',
    'itemList',
    'orderList',
    'orders',
    'deliveryOrders',
    'sellerDeliveryOrders',
    'ifList',
    'list'
  ];

  for (const key of likelyKeys) {
    if (node[key] != null) {
      const rows = collectRecords(node[key], depth + 1);

      if (rows.length) return rows;
    }
  }

  return Object.values(node)
    .flatMap(value => collectRecords(value, depth + 1));
}

function statusInfo(row) {
  const raw = [
    first(row, [
      'ordStsCd',
      'ordStsNm',
      'dlvStsCd',
      'dlvStsNm',
      'procStsCd',
      'procStsNm',
      'ifTypCd',
      'ifTypNm',
      'workTypCd',
      'workTypNm'
    ])
  ]
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

  return {
    eventType: 'order',
    status: 'new',
    statusLabel: '신규주문'
  };
}

function normalizeOrder(row, sellerId) {
  const orderNo = first(row, [
    'ordNo',
    'orderNo',
    'ordId',
    'orderId'
  ]);

  if (!orderNo) return null;

  const deliveryNo = first(row, [
    'dlvNo',
    'deliveryNo',
    'deliveryId',
    'ifNo'
  ]);

  const sequence = first(row, [
    'ordDtlSeq',
    'ordItemSeq',
    'itemSeq',
    'prdSeq',
    'orderItemSequence'
  ]);

  const idPart =
    deliveryNo ||
    sequence ||
    first(row, ['spdNo', 'prdNo', 'productNo']) ||
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
      'ifTypNm'
    ]),
    orderNo,
    deliveryNo,
    orderProductSequence: sequence,
    productNo:first(row,['spdNo','prdNo','productNo','itemNo']),
    imageUrl:first(row,['spdImgUrl','prdImgUrl','productImageUrl','imageUrl','thumbUrl','thumbnailUrl']),
    product:
      first(row, [
        'spdNm',
        'prdNm',
        'productName',
        'itemName',
        'ordItemNm'
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
        'createdAt'
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

async function queryOrderInstructions(
  config,
  minutes
) {
  const now = new Date();
  const from = new Date(
    now.getTime() - minutes * 60 * 1000
  );

  const bodies = [
    {
      trNo: config.sellerId,
      srchStrtDt: formatDate(from),
      srchEndDt: formatDate(now)
    },
    {
      srchStrtDt: formatDate(from),
      srchEndDt: formatDate(now)
    },
    {
      trNo: config.sellerId
    },
    {}
  ];

  const errors = [];

  for (const body of bodies) {
    try {
      const response = await requestJson(
        config,
        ORDER_PATH,
        {
          method: 'POST',
          body
        }
      );

      return {
        response,
        requestBody: body
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      errors.push(message);

      if (
        message.includes('HTTP 401') ||
        message.includes('HTTP 403')
      ) {
        throw error;
      }
    }
  }

  throw new Error(
    `롯데온 주문조회 실패: ${errors.join(' / ')}`
  );
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
  minutes = 30
) {
  if (!isLotteonConfigured(config)) {
    throw new Error(
      '롯데온 API 키 또는 거래처번호가 등록되지 않았습니다.'
    );
  }

  const {
    response,
    requestBody
  } = await queryOrderInstructions(
    config,
    minutes
  );

  const rows = collectRecords(response);

  const orders = rows
    .map(row => normalizeOrder(row, config.sellerId))
    .filter(Boolean);

  return {
    connected: true,
    requestBody,
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
