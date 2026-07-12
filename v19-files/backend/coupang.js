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

  const response = await fetch(`https://api-gateway.coupang.com${path}?${query}`, {
    method,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      Authorization: makeAuthorization({
        method,
        path,
        query,
        accessKey: config.accessKey,
        secretKey: config.secretKey
      }),
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

function statusInfo(sourceStatus) {
  if (sourceStatus === 'INSTRUCT') {
    return {
      status: 'shipping_wait',
      statusLabel: '발송대기'
    };
  }

  return {
    status: 'new',
    statusLabel: '신규주문'
  };
}

function normalize(orderSheets, requestedStatus) {
  const output = [];

  for (const sheet of orderSheets) {
    const sourceStatus = String(sheet.status || requestedStatus || 'ACCEPT');
    const mapped = statusInfo(sourceStatus);
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
        status: mapped.status,
        statusLabel: mapped.statusLabel,
        sourceStatus,
        vendorItemId,
        syncedAt: new Date().toISOString()
      });
    }
  }

  return output;
}

async function saveAndUpdate(db, orders) {
  let created = 0;
  let existing = 0;
  let statusChanged = 0;
  const createdOrders = [];

  for (const order of orders) {
    const ref = db.collection('orders').doc(order.id);

    const outcome = await db.runTransaction(async tx => {
      const snapshot = await tx.get(ref);

      if (!snapshot.exists) {
        tx.create(ref, {
          ...order,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return 'created';
      }

      const before = snapshot.data() || {};
      const changed =
        before.sourceStatus !== order.sourceStatus ||
        before.status !== order.status ||
        Number(before.qty || 0) !== Number(order.qty || 0);

      tx.set(
        ref,
        {
          ...order,
          createdAt: before.createdAt || admin.firestore.FieldValue.serverTimestamp(),
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

async function fetchStatus(config, path, from, now, sourceStatus) {
  const payload = await coupangRequest(config, path, {
    createdAtFrom: toKstMinute(from),
    createdAtTo: toKstMinute(now),
    searchType: 'timeFrame',
    status: sourceStatus
  });

  const sheets = Array.isArray(payload.data) ? payload.data : [];
  return normalize(sheets, sourceStatus);
}

export async function pollCoupang(db, config, minutes = 30) {
  const now = new Date();
  const from = new Date(now.getTime() - minutes * 60 * 1000);

  const path =
    `/v2/providers/openapi/apis/api/v5/vendors/${encodeURIComponent(config.vendorId)}/ordersheets`;

  const [acceptOrders, instructOrders] = await Promise.all([
    fetchStatus(config, path, from, now, 'ACCEPT'),
    fetchStatus(config, path, from, now, 'INSTRUCT')
  ]);

  // Same document cannot normally appear in both states, but de-duplicate defensively.
  const byId = new Map();
  for (const order of [...acceptOrders, ...instructOrders]) {
    byId.set(order.id, order);
  }

  const orders = [...byId.values()];
  const result = await saveAndUpdate(db, orders);

  return {
    ...result,
    accept: acceptOrders.length,
    instruct: instructOrders.length,
    checkedFrom: from.toISOString(),
    checkedTo: now.toISOString()
  };
}
