import admin from 'firebase-admin';

const required = ['FIREBASE_SERVICE_ACCOUNT_JSON'];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`필수 GitHub Secret이 없습니다: ${key}`);
  }
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

const integrations = [
  ['coupang', '쿠팡', ['COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY', 'COUPANG_VENDOR_ID']],
  ['smartstore', '스마트스토어', ['SMARTSTORE_CLIENT_ID', 'SMARTSTORE_CLIENT_SECRET']],
  ['elevenst', '11번가', ['ELEVENST_API_KEY']],
  ['gmarket', 'G마켓', ['ESM_API_KEY']],
  ['auction', '옥션', ['ESM_API_KEY']],
  ['lotteon', '롯데온', ['LOTTEON_API_KEY']]
];

const now = new Date().toISOString();
const status = {};

for (const [key, name, secretNames] of integrations) {
  const connected = secretNames.every(secret => Boolean(process.env[secret]));
  status[key] = {
    name,
    connected,
    lastRun: now,
    message: connected ? '키 등록 완료, API 어댑터 연결 대기' : 'GitHub Secret 등록 필요'
  };
}

await db.collection('system').doc('integrations').set(status, { merge: true });
await db.collection('system').doc('poller').set({
  lastRun: now,
  intervalMinutes: 10,
  mode: 'setup',
  note: '현재는 연결 상태 확인 단계입니다. 실제 주문 수집 어댑터를 순차적으로 추가합니다.'
}, { merge: true });

console.log(`[${now}] 연동 상태 확인 완료`);
for (const [key, value] of Object.entries(status)) {
  console.log(`${value.name}: ${value.connected ? '키 등록됨' : '미등록'}`);
}
