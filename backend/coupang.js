import crypto from 'node:crypto';
import admin from 'firebase-admin';

function signedDate() {
  return new Date()
    .toISOString()
    .split('.')[0]
    .replaceAll(':', '')
    .replaceAll('-', '')
    .slice(2) + 'Z';
}

function toKstMinute(date) {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const min = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${min}+09:00`;
}

function moneyUnits(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  return Number(value.units || 0) + Number(value.nanos || 0) / 1_000_000_000;
}

function makeAuthorization({ method, path, query, accessKey, secretKey }) {
  const datetime = signedDate();
  const message = `${datetime}${method}${path}${query}`;
  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(message)
    .digest('hex');

  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;
}

async function coupangRequest(config, path, params) {
  const method = 'GET';
  const query = new URLSearchParams(params).toString();

  const authorization = makeAuthorization({
    method,
    path,
    query,
    accessKey: config.accessKey,
    secretKey: config.secretKey
  });

  const response = await fetch(`https://api-gateway.coupang.com${path}?${query}`, {
    method,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      Authorization: authorization,
      'X-Requested-By': config.vendorId,
      'X-MARKET': 'KR'
    }
  });

  const text = await response.text();
  let payload;

  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`쿠팡 응답 변환 실패(HTTP ${response.status})`);
  }

  if (!response.ok) {
    throw new Error(`쿠팡 API HTTP ${response.status}: ${payload?.message || text}`);
  }

  if (payload?.code != null && Number(payload.code) !== 200) {
    throw new Error(`쿠팡 API 오류 ${payload.code}: ${payload.message || '알 수 없는 오류'}`);
  }

  return payload;
}

function normalize(orderSheets) {
  const output = [];

  for (const sheet of orderSheets) {
    const items = Array.isArray(sheet.orderItems) ? sheet.orderItems : [];

    for (const item of items) {
      const shippingCount = Number(item.shippingCount || 0);
      const cancelCount = Number(item.cancelCount || 0);
      const holdCount = Number(item.holdCountForCancel || 0);
      const qty = Math.max(0, shippingCount - cancelCount - holdCount);

      if (qty <= 0) continue;

      const orderNo = String(sheet.orderId);
      const vendorItemId = String(item.vendorItemId || item.sellerProductId || 'item');
      const id = `coupang-${orderNo}-${vendorItemId}`;

      const product =
        item.vendorItemName ||
        [item.sellerProductName, item.sellerProductItemName]
          .filter(Boolean)
          .join(' ') ||
        '쿠팡 상품';

      output.push({
        id,
        source: 'coupang',
        market: '쿠팡',
        eventType: 'order',
        orderNo,
        shipmentBoxId: String(sheet.shipmentBoxId || ''),
        product,
        qty,
        buyer: sheet.receiver?.name || sheet.orderer?.name || '',
        amount: Math.round(moneyUnits(item.orderPrice)),
        datetime: sheet.orderedAt || sheet.paidAt || new Date().toISOString(),
        status: 'new',
        sourceStatus: sheet.status || 'ACCEPT',
        vendorItemId,
        syncedAt: new Date().toISOString()
      });
    }
  }

  return output;
}

async function saveWithoutDuplicates(db, orders) {
  let created = 0;
  let existing = 0;
  const createdOrders = [];

  for (const order of orders) {
    const ref = db.collection('orders').doc(order.id);

    const added = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;

      tx.create(ref, {
        ...order,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return true;
    });

    if (added) {
      created += 1;
      createdOrders.push(order);
    } else {
      existing += 1;
    }
  }

  return {
    found: orders.length,
    created,
    existing,
    createdOrders
  };
}

export async function pollCoupang(db, config, minutes = 30) {
  const now = new Date();
  const from = new Date(now.getTime() - minutes * 60 * 1000);

  const path =
    `/v2/providers/openapi/apis/api/v5/vendors/${encodeURIComponent(config.vendorId)}/ordersheets`;

  const payload = await coupangRequest(config, path, {
    createdAtFrom: toKstMinute(from),
    createdAtTo: toKstMinute(now),
    searchType: 'timeFrame',
    status: 'ACCEPT'
  });

  const sheets = Array.isArray(payload.data) ? payload.data : [];
  const orders = normalize(sheets);
  const result = await saveWithoutDuplicates(db, orders);

  return {
    ...result,
    checkedFrom: from.toISOString(),
    checkedTo: now.toISOString()
  };
}
