import crypto from 'node:crypto';
import admin from 'firebase-admin';

const ORDER_STATUSES = [
  'ACCEPT',
  'INSTRUCT',
  'DEPARTURE',
  'DELIVERING',
  'FINAL_DELIVERY',
  'NONE_TRACKING'
];

const STATUS_MAP = {
  ACCEPT: { status: 'new', statusLabel: '신규주문' },
  INSTRUCT: { status: 'shipping_wait', statusLabel: '발송대기' },
  DEPARTURE: { status: 'departure', statusLabel: '배송지시' },
  DELIVERING: { status: 'delivering', statusLabel: '배송중' },
  FINAL_DELIVERY: { status: 'delivered', statusLabel: '배송완료' },
  NONE_TRACKING: { status: 'none_tracking', statusLabel: '직접배송' }
};

function signedDate() {
  return new Date()
    .toISOString()
    .split('.')[0]
    .replaceAll(':', '')
    .replaceAll('-', '')
    .slice(2) + 'Z';
}

function kstDateString(date) {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}+09:00`;
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

function normalize(orderSheets, requestedStatus) {
  const output = [];

  for (const sheet of orderSheets) {
    const sourceStatus = String(sheet.status || requestedStatus || 'ACCEPT');
    const mapped = STATUS_MAP[sourceStatus] || {
      status: sourceStatus.toLowerCase(),
      statusLabel: sourceStatus
    };

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
        deliveryCompanyName:
          item.deliveryCompanyName ||
          sheet.deliveryCompanyName ||
          '',
        invoiceNumber:
          item.invoiceNumber ||
          sheet.invoiceNumber ||
          '',
        syncedAt: new Date().toISOString()
      });
    }
  }

  return output;
}

async function fetchStatusPages(config, path, from, to, sourceStatus) {
  const orders = [];
  let nextToken = '';

  for (let page = 0; page < 100; page += 1) {
    const params = {
      createdAtFrom: kstDateString(from),
      createdAtTo: kstDateString(to),
      maxPerPage: '50',
      status: sourceStatus
    };

    if (nextToken) params.nextToken = nextToken;

    const payload = await coupangRequest(config, path, params);
    const sheets = Array.isArray(payload.data) ? payload.data : [];
    orders.push(...normalize(sheets, sourceStatus));

    nextToken =
      payload.nextToken ||
      payload.pagination?.nextToken ||
      '';

    if (!nextToken || sheets.length === 0) break;
  }

  return orders;
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
        Number(before.qty || 0) !== Number(order.qty || 0) ||
        String(before.invoiceNumber || '') !== String(order.invoiceNumber || '');

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

function resolveDays(scope) {
  if (typeof scope === 'object' && scope !== null) {
    return Math.min(31, Math.max(1, Number(scope.days || 7)));
  }

  if (typeof scope === 'number') {
    // Backward compatibility with old callers:
    // 30 minutes -> 7 days, 1439 minutes -> 31 days.
    return scope >= 1000 ? 31 : 7;
  }

  return 7;
}

export async function pollCoupang(db, config, scope = { days: 7 }) {
  const days = resolveDays(scope);
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const path =
    `/v2/providers/openapi/apis/api/v5/vendors/${encodeURIComponent(config.vendorId)}/ordersheets`;

  const groups = await Promise.all(
    ORDER_STATUSES.map(status =>
      fetchStatusPages(config, path, from, now, status)
    )
  );

  const byId = new Map();

  for (const group of groups) {
    for (const order of group) {
      byId.set(order.id, order);
    }
  }

  const orders = [...byId.values()];
  const result = await saveAndUpdate(db, orders);

  const counts = Object.fromEntries(
    ORDER_STATUSES.map(status => [
      status,
      orders.filter(order => order.sourceStatus === status).length
    ])
  );

  return {
    ...result,
    ...counts,
    days,
    checkedFrom: from.toISOString(),
    checkedTo: now.toISOString()
  };
}
