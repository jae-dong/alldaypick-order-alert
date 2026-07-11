import crypto from 'node:crypto';
import admin from 'firebase-admin';

const REQUIRED_FIREBASE = 'FIREBASE_SERVICE_ACCOUNT_JSON';
if (!process.env[REQUIRED_FIREBASE]) {
  throw new Error(`필수 GitHub Secret이 없습니다: ${REQUIRED_FIREBASE}`);
}

const serviceAccount = JSON.parse(process.env[REQUIRED_FIREBASE]);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const integrationDefinitions = [
  ['coupang', '쿠팡', ['COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY', 'COUPANG_VENDOR_ID']],
  ['smartstore', '스마트스토어', ['SMARTSTORE_CLIENT_ID', 'SMARTSTORE_CLIENT_SECRET']],
  ['elevenst', '11번가', ['ELEVENST_API_KEY']],
  ['gmarket', 'G마켓', ['ESM_API_KEY']],
  ['auction', '옥션', ['ESM_API_KEY']],
  ['lotteon', '롯데온', ['LOTTEON_API_KEY']]
];

function hasSecrets(secretNames) {
  return secretNames.every((name) => Boolean(process.env[name]));
}

function coupangSignedDate() {
  // 공식 예제 형식: YYMMDDTHHmmssZ
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
  const datetime = coupangSignedDate();
  const message = `${datetime}${method}${path}${query}`;
  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(message)
    .digest('hex');

  return {
    datetime,
    authorization:
      `CEA algorithm=HmacSHA256, access-key=${accessKey}, ` +
      `signed-date=${datetime}, signature=${signature}`
  };
}

async function coupangRequest(path, params) {
  const method = 'GET';
  const accessKey = process.env.COUPANG_ACCESS_KEY;
  const secretKey = process.env.COUPANG_SECRET_KEY;
  const vendorId = process.env.COUPANG_VENDOR_ID;

  const query = new URLSearchParams(params).toString();
  const { authorization } = makeAuthorization({
    method,
    path,
    query,
    accessKey,
    secretKey
  });

  const response = await fetch(
    `https://api-gateway.coupang.com${path}?${query}`,
    {
      method,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        Authorization: authorization,
        'X-Requested-By': vendorId,
        'X-MARKET': 'KR',
        'X-EXTENDED-TIMEOUT': '90000'
      }
    }
  );

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`쿠팡 응답 JSON 변환 실패: HTTP ${response.status}`);
  }

  if (!response.ok) {
    const message = payload?.message || payload?.error || text;
    throw new Error(`쿠팡 API HTTP ${response.status}: ${message}`);
  }

  if (payload?.code != null && Number(payload.code) !== 200) {
    throw new Error(`쿠팡 API 오류 ${payload.code}: ${payload.message || '알 수 없는 오류'}`);
  }

  return payload;
}

function normalizeCoupangOrders(orderSheets) {
  const normalized = [];

  for (const sheet of orderSheets) {
    const items = Array.isArray(sheet.orderItems) ? sheet.orderItems : [];

    for (const item of items) {
      const shippingCount = Number(item.shippingCount || 0);
      const cancelCount = Number(item.cancelCount || 0);
      const holdCount = Number(item.holdCountForCancel || 0);
      const activeQty = Math.max(0, shippingCount - cancelCount - holdCount);

      if (activeQty <= 0) continue;

      const vendorItemId = String(item.vendorItemId || item.sellerProductId || 'item');
      const orderId = String(sheet.orderId);
      const documentId = `coupang-${orderId}-${vendorItemId}`;

      const productName =
        item.vendorItemName ||
        [item.sellerProductName, item.sellerProductItemName]
          .filter(Boolean)
          .join(' ') ||
        '쿠팡 상품';

      normalized.push({
        id: documentId,
        source: 'coupang',
        market: '쿠팡',
        eventType: 'order',
        orderNo: orderId,
        shipmentBoxId: String(sheet.shipmentBoxId || ''),
        product: productName,
        qty: activeQty,
        buyer: sheet.receiver?.name || sheet.orderer?.name || '',
        amount: Math.round(moneyUnits(item.orderPrice)),
        datetime: sheet.orderedAt || sheet.paidAt || new Date().toISOString(),
        status: 'new',
        sourceStatus: sheet.status || 'ACCEPT',
        vendorItemId,
        sellerProductId: String(item.sellerProductId || ''),
        externalVendorSkuCode: item.externalVendorSkuCode || '',
        syncedAt: new Date().toISOString()
      });
    }
  }

  return normalized;
}

async function saveOrdersWithoutDuplicates(orders) {
  if (!orders.length) return { found: 0, created: 0, existing: 0 };

  let created = 0;
  let existing = 0;

  // 월 1,000건 수준에서는 트랜잭션 단건 처리가 충분하며 중복 방지가 확실합니다.
  for (const order of orders) {
    const ref = db.collection('orders').doc(order.id);

    const wasCreated = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (snapshot.exists) return false;

      transaction.create(ref, {
        ...order,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return true;
    });

    if (wasCreated) created += 1;
    else existing += 1;
  }

  return { found: orders.length, created, existing };
}

async function pollCoupang() {
  const vendorId = process.env.COUPANG_VENDOR_ID;
  const now = new Date();

  // 예약 실행이 몇 분 늦어져도 놓치지 않도록 최근 30분을 겹쳐 조회합니다.
  const from = new Date(now.getTime() - 30 * 60 * 1000);
  const path =
    `/v2/providers/openapi/apis/api/v5/vendors/${encodeURIComponent(vendorId)}/ordersheets`;

  const payload = await coupangRequest(path, {
    createdAtFrom: toKstMinute(from),
    createdAtTo: toKstMinute(now),
    searchType: 'timeFrame',
    status: 'ACCEPT'
  });

  const sheets = Array.isArray(payload.data) ? payload.data : [];
  const orders = normalizeCoupangOrders(sheets);
  const result = await saveOrdersWithoutDuplicates(orders);

  return {
    ...result,
    checkedFrom: from.toISOString(),
    checkedTo: now.toISOString()
  };
}

async function updateIntegrationStatus(key, data) {
  await db.collection('system').doc('integrations').set(
    {
      [key]: {
        ...data,
        lastRun: new Date().toISOString()
      }
    },
    { merge: true }
  );
}

async function main() {
  const runStartedAt = new Date().toISOString();
  const status = {};

  for (const [key, name, secretNames] of integrationDefinitions) {
    status[key] = {
      name,
      connected: hasSecrets(secretNames),
      lastRun: runStartedAt,
      message: hasSecrets(secretNames)
        ? '키 등록 완료'
        : 'GitHub Secret 등록 필요'
    };
  }

  if (status.coupang.connected) {
    try {
      const result = await pollCoupang();
      status.coupang = {
        name: '쿠팡',
        connected: true,
        lastRun: new Date().toISOString(),
        message:
          `정상 조회 · 발견 ${result.found}건 · 신규 저장 ${result.created}건 · 중복 ${result.existing}건`,
        lastResult: result
      };

      console.log(
        `쿠팡 조회 성공: 발견 ${result.found}, 신규 ${result.created}, 중복 ${result.existing}`
      );
    } catch (error) {
      status.coupang = {
        name: '쿠팡',
        connected: false,
        lastRun: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error)
      };

      await db.collection('system').doc('integrations').set(status, { merge: true });
      await db.collection('system').doc('poller').set(
        {
          lastRun: new Date().toISOString(),
          intervalMinutes: 10,
          mode: 'coupang-live',
          success: false,
          error: status.coupang.message
        },
        { merge: true }
      );

      throw error;
    }
  }

  await db.collection('system').doc('integrations').set(status, { merge: true });
  await db.collection('system').doc('poller').set(
    {
      lastRun: new Date().toISOString(),
      intervalMinutes: 10,
      mode: 'coupang-live',
      success: true,
      coupang: status.coupang
    },
    { merge: true }
  );

  console.log(`[${runStartedAt}] 주문 자동수집 완료`);
}

await main();
