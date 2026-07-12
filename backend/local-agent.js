import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';
import dotenv from 'dotenv';
import { pollCoupang } from './coupang.js';

dotenv.config({ path: path.resolve('.env.local') });

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_FILE) {
    return JSON.parse(
      fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_FILE, 'utf8')
    );
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }

  throw new Error(
    'FIREBASE_SERVICE_ACCOUNT_FILE 또는 FIREBASE_SERVICE_ACCOUNT_JSON이 필요합니다.'
  );
}

function coupangConfig() {
  const config = {
    accessKey: process.env.COUPANG_ACCESS_KEY,
    secretKey: process.env.COUPANG_SECRET_KEY,
    vendorId: process.env.COUPANG_VENDOR_ID
  };

  if (!config.accessKey || !config.secretKey || !config.vendorId) {
    throw new Error('.env.local의 쿠팡 키 3개를 확인하세요.');
  }

  return config;
}

admin.initializeApp({
  credential: admin.credential.cert(loadServiceAccount())
});

const db = admin.firestore();
const messaging = admin.messaging();

const commandRef = db
  .collection('system')
  .doc('commands')
  .collection('requests')
  .doc('coupang');

const intervalMinutes = Math.max(
  1,
  Number(process.env.POLL_INTERVAL_MINUTES || 10)
);

let running = false;
let lastRequestId = '';

async function getActiveDevices() {
  const snapshot = await db
    .collection('devices')
    .where('enabled', '==', true)
    .get();

  return snapshot.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(device => typeof device.token === 'string' && device.token.length > 20);
}

async function removeInvalidTokens(devices, responses) {
  const invalidCodes = new Set([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token'
  ]);

  const batch = db.batch();
  let count = 0;

  responses.forEach((response, index) => {
    if (response.success) return;

    if (invalidCodes.has(response.error?.code)) {
      batch.delete(db.collection('devices').doc(devices[index].id));
      count += 1;
    }
  });

  if (count > 0) await batch.commit();
}

async function sendPushForOrders(orders) {
  const recentNewOrders = orders.filter(order => {
    if (order.sourceStatus !== 'ACCEPT') return false;
    const createdAt = new Date(order.datetime).getTime();
    return Number.isFinite(createdAt) &&
      Date.now() - createdAt <= 2 * 60 * 60 * 1000;
  });

  if (!recentNewOrders.length) {
    return { devices: 0, sent: 0, failed: 0 };
  }

  const devices = await getActiveDevices();

  if (!devices.length) {
    console.log('푸시 등록된 휴대폰이 없습니다.');
    return { devices: 0, sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;

  for (const order of recentNewOrders) {
    const product = String(order.product || '상품')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90);

    const result = await messaging.sendEachForMulticast({
      tokens: devices.map(device => device.token),

      notification: {
        title: '쿠팡 신규주문',
        body: `${product} · ${Number(order.qty || 1)}개`
      },

      data: {
        market: '쿠팡',
        eventType: 'order',
        orderId: String(order.id),
        url: 'https://jae-dong.github.io/alldaypick-order-alert/'
      },

      webpush: {
        fcmOptions: {
          link: 'https://jae-dong.github.io/alldaypick-order-alert/'
        },
        notification: {
          icon: 'https://jae-dong.github.io/alldaypick-order-alert/icon.svg',
          badge: 'https://jae-dong.github.io/alldaypick-order-alert/icon.svg',
          tag: String(order.id),
          renotify: true,
          vibrate: [200, 100, 200]
        }
      }
    });

    sent += result.successCount;
    failed += result.failureCount;
    await removeInvalidTokens(devices, result.responses);
  }

  console.log(`푸시 전송 완료: 성공 ${sent}, 실패 ${failed}`);
  return { devices: devices.length, sent, failed };
}

async function runCollect(source) {
  const days = source === 'interval' ? 7 : 31;

  if (running) return;
  running = true;

  console.log(
    `[${new Date().toISOString()}] ${source} 쿠팡 전체상태 동기화 시작 · 최근 ${days}일`
  );

  if (source === 'immediate') {
    await commandRef.set(
      {
        status: 'running',
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  }

  try {
    const result = await pollCoupang(db, coupangConfig(), { days });
    const pushResult = await sendPushForOrders(result.createdOrders || []);

    const safeResult = {
      found: result.found,
      created: result.created,
      existing: result.existing,
      statusChanged: result.statusChanged,
      ACCEPT: result.ACCEPT,
      INSTRUCT: result.INSTRUCT,
      DEPARTURE: result.DEPARTURE,
      DELIVERING: result.DELIVERING,
      FINAL_DELIVERY: result.FINAL_DELIVERY,
      NONE_TRACKING: result.NONE_TRACKING,
      days: result.days,
      checkedFrom: result.checkedFrom,
      checkedTo: result.checkedTo,
      push: pushResult
    };

    await db.collection('system').doc('integrations').set(
      {
        coupang: {
          name: '쿠팡',
          connected: true,
          lastRun: new Date().toISOString(),
          message:
            `신규 ${result.ACCEPT} · 발송대기 ${result.INSTRUCT} · ` +
            `배송지시 ${result.DEPARTURE} · 배송중 ${result.DELIVERING} · ` +
            `배송완료 ${result.FINAL_DELIVERY} · 상태변경 ${result.statusChanged}`,
          lastResult: safeResult
        }
      },
      { merge: true }
    );

    if (source === 'immediate') {
      await commandRef.set(
        {
          status: 'success',
          result: safeResult,
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }

    console.log(
      `동기화 완료: 신규 ${result.ACCEPT}, 발송대기 ${result.INSTRUCT}, ` +
      `배송지시 ${result.DEPARTURE}, 배송중 ${result.DELIVERING}, ` +
      `배송완료 ${result.FINAL_DELIVERY}, 직접배송 ${result.NONE_TRACKING}, ` +
      `신규저장 ${result.created}, 상태변경 ${result.statusChanged}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);

    if (source === 'immediate') {
      await commandRef.set(
        {
          status: 'error',
          error: message,
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }
  } finally {
    running = false;
  }
}

commandRef.onSnapshot(
  snapshot => {
    if (!snapshot.exists) return;

    const data = snapshot.data() || {};

    if (
      data.status !== 'requested' ||
      !data.requestId ||
      data.requestId === lastRequestId
    ) {
      return;
    }

    lastRequestId = data.requestId;
    runCollect('immediate');
  },
  error => console.error('즉시수집 감시 오류:', error.message)
);

await runCollect('startup');

setInterval(
  () => runCollect('interval'),
  intervalMinutes * 60 * 1000
);

console.log(
  `로컬 수집기 실행 중 · ${intervalMinutes}분 자동수집 · ` +
  `쿠팡 전체 배송상태 자동동기화 · 휴대폰 푸시 대기`
);
