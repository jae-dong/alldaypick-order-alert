import bcrypt from 'bcrypt';
import admin from 'firebase-admin';

const API_BASE = 'https://api.commerce.naver.com/external';

function iso(date) {
  return date.toISOString();
}

function signature(clientId, clientSecret, timestamp) {
  const password = `${clientId}_${timestamp}`;
  const hashed = bcrypt.hashSync(password, clientSecret);
  return Buffer.from(hashed, 'utf8').toString('base64');
}

async function jsonResponse(response, label) {
  const text = await response.text();
  let body;

  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${label} 응답 변환 실패(HTTP ${response.status})`);
  }

  if (!response.ok) {
    throw new Error(
      `${label} HTTP ${response.status}: ${body?.message || body?.code || text}`
    );
  }

  return body;
}

async function accessToken(config) {
  const timestamp = Date.now();
  const params = new URLSearchParams({
    client_id: config.clientId,
    timestamp: String(timestamp),
    client_secret_sign: signature(
      config.clientId,
      config.clientSecret,
      timestamp
    ),
    grant_type: 'client_credentials',
    type: 'SELF'
  });

  const response = await fetch(`${API_BASE}/v1/oauth2/token`, {
    signal:AbortSignal.timeout(30000),
method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });

  const body = await jsonResponse(response, '스마트스토어 인증');
  const token =
    body.access_token ||
    body.accessToken ||
    body.data?.access_token ||
    body.data?.accessToken;

  if (!token) {
    throw new Error('스마트스토어 인증 토큰이 응답에 없습니다.');
  }

  return token;
}

async function api(token, path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    signal:AbortSignal.timeout(30000),
...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  return jsonResponse(response, '스마트스토어 API');
}

function changedRows(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.data?.lastChangeStatuses)) {
    return body.data.lastChangeStatuses;
  }
  if (Array.isArray(body.lastChangeStatuses)) {
    return body.lastChangeStatuses;
  }
  if (Array.isArray(body.contents)) return body.contents;
  return [];
}

function detailRows(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.data?.contents)) return body.data.contents;
  if (Array.isArray(body.contents)) return body.contents;
  return [];
}

function statusInfo(productOrder = {}, claim = {}) {
  const productOrderStatus = String(
    productOrder.productOrderStatus ||
    productOrder.status ||
    ''
  ).toUpperCase();

  const claimStatus = String(
    claim.claimStatus ||
    productOrder.claimStatus ||
    ''
  ).toUpperCase();

  const claimType = String(
    claim.claimType ||
    productOrder.claimType ||
    ''
  ).toUpperCase();

  if (claimType.includes('CANCEL') || claimStatus.includes('CANCEL')) {
    return {
      eventType: 'cancel',
      status: 'cancel_request',
      statusLabel: '주문취소'
    };
  }

  if (claimType.includes('RETURN') || claimStatus.includes('RETURN')) {
    return {
      eventType: 'return',
      status: 'return_request',
      statusLabel: '반품요청'
    };
  }

  if (claimType.includes('EXCHANGE') || claimStatus.includes('EXCHANGE')) {
    return {
      eventType: 'exchange',
      status: 'exchange_request',
      statusLabel: '교환요청'
    };
  }

  if (
    productOrderStatus.includes('PAYED') ||
    productOrderStatus.includes('PAYMENT_WAITING') ||
    productOrderStatus.includes('NEW')
  ) {
    return {
      eventType: 'order',
      status: 'new',
      statusLabel: '신규주문'
    };
  }

  if (
    productOrderStatus.includes('PLACE_ORDER') ||
    productOrderStatus.includes('DISPATCH_WAITING') ||
    productOrderStatus.includes('PRODUCT_PREPARE')
  ) {
    return {
      eventType: 'order',
      status: 'shipping_wait',
      statusLabel: '발송대기'
    };
  }

  if (
    productOrderStatus.includes('DELIVERING') ||
    productOrderStatus.includes('DISPATCHED')
  ) {
    return {
      eventType: 'order',
      status: 'delivering',
      statusLabel: '배송중'
    };
  }

  if (productOrderStatus.includes('PURCHASE_DECIDED')) {
    return {
      eventType: 'order',
      status: 'purchase_confirmed',
      statusLabel: '구매확정'
    };
  }

  if (productOrderStatus.includes('DELIVERED')) {
    return {
      eventType: 'order',
      status: 'delivered',
      statusLabel: '배송완료'
    };
  }

  return {
    eventType: 'order',
    status: productOrderStatus.toLowerCase() || 'new',
    statusLabel: productOrderStatus || '주문'
  };
}

function normalizeDetail(row) {
  const order = row.order || row.orderInfo || {};
  const productOrder =
    row.productOrder ||
    row.productOrderInfo ||
    row.productOrderDetail ||
    row;

  const claim = row.claim || row.claimInfo || {};
  const productOrderId = String(
    productOrder.productOrderId ||
    row.productOrderId ||
    ''
  );

  if (!productOrderId) return null;

  const mapped = statusInfo(productOrder, claim);
  const product =
    productOrder.productName ||
    productOrder.productOrderName ||
    productOrder.itemName ||
    '스마트스토어 상품';

  return {
    id: `smartstore-${productOrderId}`,
    source: 'smartstore',
    market: '스마트스토어',
    eventType: mapped.eventType,
    orderNo: String(
      order.orderId ||
      productOrder.orderId ||
      row.orderId ||
      productOrderId
    ),
    productOrderId,
    product,
    option:
      productOrder.productOption ||
      productOrder.optionCode ||
      productOrder.optionName ||
      '',
    qty: Number(
      productOrder.quantity ||
      productOrder.productOrderQuantity ||
      1
    ),
    buyer:
      order.ordererName ||
      productOrder.shippingAddress?.name ||
      productOrder.shippingAddress?.receiverName ||
      '',
    phone:
      order.ordererTel ||
      order.ordererTelephone ||
      productOrder.shippingAddress?.tel1 ||
      productOrder.shippingAddress?.telephone1 ||
      productOrder.shippingAddress?.receiverTel ||
      '',
    address:
      [
        productOrder.shippingAddress?.baseAddress,
        productOrder.shippingAddress?.detailedAddress
      ].filter(Boolean).join(' '),
    deliveryMemo:
      productOrder.shippingAddress?.deliveryMemo ||
      productOrder.deliveryMemo ||
      '',
    amount: Number(
      productOrder.totalPaymentAmount ||
      productOrder.totalProductAmount ||
      productOrder.unitPrice * productOrder.quantity ||
      0
    ),
    datetime:
      order.paymentDate ||
      productOrder.paymentDate ||
      productOrder.orderDate ||
      new Date().toISOString(),
    status: mapped.status,
    statusLabel: mapped.statusLabel,
    sourceStatus:
      productOrder.productOrderStatus ||
      productOrder.status ||
      '',
    claimStatus:
      claim.claimStatus || productOrder.claimStatus || '',
    claimType:
      claim.claimType || productOrder.claimType || '',
    activeState:true,
    invoiceNumber:
      productOrder.trackingNumber ||
      productOrder.invoiceNumber ||
      '',
    deliveryCompanyName:
      productOrder.deliveryCompany ||
      productOrder.deliveryMethod ||
      '',
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

    const result = await db.runTransaction(async tx => {
      const snapshot = await tx.get(ref);

      if (!snapshot.exists) {
        tx.create(ref, {
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
        before.invoiceNumber !== order.invoiceNumber ||
        Number(before.qty || 0) !== Number(order.qty || 0);

      tx.set(
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

    if (result === 'created') {
      created += 1;
      createdOrders.push(order);
    } else if (result === 'changed') {
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


function splitDateRange(from,to,maxHours=23){
  const ranges=[];
  const maxMs=Math.max(1,maxHours)*60*60*1000;
  let cursor=new Date(from);

  while(cursor<to){
    const end=new Date(
      Math.min(
        cursor.getTime()+maxMs,
        to.getTime()
      )
    );

    ranges.push({
      from:new Date(cursor),
      to:end
    });

    cursor=new Date(end.getTime()+1000);
  }

  return ranges;
}

async function changedProductOrderIds(token,from,to){
  const params=new URLSearchParams({
    lastChangedFrom:iso(from),
    lastChangedTo:iso(to),
    limitCount:'300'
  });

  const changed=await api(
    token,
    `/v1/pay-order/seller/product-orders/last-changed-statuses?${params}`
  );

  return changedRows(changed)
    .map(row=>
      String(
        row.productOrderId ||
        row.productOrder?.productOrderId ||
        ''
      )
    )
    .filter(Boolean);
}



function smartstoreWait(ms){
  return new Promise(resolve=>setTimeout(resolve,ms));
}

function smartstoreRateLimited(error){
  const message=String(
    error instanceof Error?error.message:error
  ).toLowerCase();

  return (
    message.includes('429') ||
    message.includes('too many requests') ||
    message.includes('요청이 많아')
  );
}

async function smartstoreRetry(task,label){
  const delays=[30000,60000,120000];
  let lastError;

  for(let attempt=0;attempt<=delays.length;attempt+=1){
    try{
      return await task();
    }catch(error){
      lastError=error;

      if(
        !smartstoreRateLimited(error) ||
        attempt>=delays.length
      ){
        throw error;
      }

      const delay=delays[attempt];

      console.warn(
        `${label} 요청 제한 · ${delay/1000}초 뒤 자동 재시도 `+
        `(${attempt+1}/${delays.length})`
      );

      await smartstoreWait(delay);
    }
  }

  throw lastError;
}


export async function syncSmartstore(db,config,minutes=30){
  const token=await accessToken(config);
  const now=new Date();
  const from=new Date(
    now.getTime()-minutes*60*1000
  );

  const ranges=splitDateRange(from,now,23);
  const idSet=new Set();

  for(let index=0;index<ranges.length;index+=1){
    const range=ranges[index];

    const ids=await smartstoreRetry(
      ()=>changedProductOrderIds(
        token,
        range.from,
        range.to
      ),
      `스마트스토어 변경내역 ${index+1}/${ranges.length}`
    );

    ids.forEach(id=>idSet.add(id));

    if(index<ranges.length-1){
      await smartstoreWait(3000);
    }
  }

  const ids=[...idSet];

  if(!ids.length){
    return {
      connected:true,
      found:0,
      created:0,
      existing:0,
      statusChanged:0,
      createdOrders:[],
      rangeCount:ranges.length
    };
  }

  const allOrders=[];

  for(let index=0;index<ids.length;index+=300){
    const batch=ids.slice(index,index+300);

    const details=await smartstoreRetry(
      ()=>api(
        token,
        '/v1/pay-order/seller/product-orders/query',
        {
          method:'POST',
          body:JSON.stringify({
            productOrderIds:batch
          })
        }
      ),
      `스마트스토어 상세조회 ${Math.floor(index/300)+1}`
    );

    allOrders.push(
      ...detailRows(details)
        .map(normalizeDetail)
        .filter(Boolean)
    );

    if(index+300<ids.length){
      await smartstoreWait(3000);
    }
  }

  const saved=await saveOrders(db,allOrders);

  return {
    connected:true,
    ...saved,
    rangeCount:ranges.length
  };
}
