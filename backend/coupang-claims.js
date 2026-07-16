import crypto from 'node:crypto';
import admin from 'firebase-admin';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function signedDate() {
  return new Date()
    .toISOString()
    .split('.')[0]
    .replaceAll(':', '')
    .replaceAll('-', '')
    .slice(2) + 'Z';
}

function kstMinute(date) {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const min = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function kstSecond(date) {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const min = String(shifted.getUTCMinutes()).padStart(2, '0');
  const sec = String(shifted.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${sec}`;
}

function authorization({ method, path, query, accessKey, secretKey }) {
  const datetime = signedDate();
  const message = `${datetime}${method}${path}${query}`;
  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(message)
    .digest('hex');

  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;
}

async function request(config, path, params) {
  const method = 'GET';

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const query = new URLSearchParams(params).toString();

    const response = await fetch(
      `https://api-gateway.coupang.com${path}?${query}`,
      {
        signal:AbortSignal.timeout(30000),
method,
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          Authorization: authorization({
            method,
            path,
            query,
            accessKey: config.accessKey,
            secretKey: config.secretKey
          }),
          'X-Requested-By': config.vendorId,
          'X-MARKET': 'KR'
        }
      }
    );

    const text = await response.text();

    if (response.status === 429) {
      const waitMs = [10000, 20000, 40000, 60000][attempt];

      if (attempt === 3) {
        throw new Error('쿠팡 CS API 호출 제한(429)이 계속됩니다.');
      }

      console.log(`쿠팡 CS API 429 · ${waitMs / 1000}초 후 재시도`);
      await sleep(waitMs);
      continue;
    }

    let payload;

    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`쿠팡 CS 응답 변환 실패(HTTP ${response.status})`);
    }

    if (!response.ok) {
      throw new Error(
        `쿠팡 CS API HTTP ${response.status}: ${payload?.message || text}`
      );
    }

    if (payload?.code != null && Number(payload.code) !== 200) {
      throw new Error(
        `쿠팡 CS API 오류 ${payload.code}: ${payload.message || '알 수 없는 오류'}`
      );
    }

    return payload;
  }

  throw new Error('쿠팡 CS API 요청 실패');
}

function returnClaimDocuments(rows, kind) {
  const documents = [];

  for (const row of rows) {
    const items = Array.isArray(row.returnItems) && row.returnItems.length
      ? row.returnItems
      : [{}];

    for (const item of items) {
      const vendorItemId = String(item.vendorItemId || 'claim');
      const receiptId = String(row.receiptId);
      const eventType = kind === 'cancel' ? 'cancel' : 'return';
      const label = kind === 'cancel' ? '주문취소' : '반품요청';

      documents.push({
        id: `coupang-${eventType}-${receiptId}-${vendorItemId}`,
        source: 'coupang',
        market: '쿠팡',
        eventType,
        orderNo: String(row.orderId || ''),
        receiptId,
        product:
          item.vendorItemName ||
          item.sellerProductName ||
          `${label} 상품`,
        qty: Number(item.cancelCount || row.cancelCountSum || 1),
        buyer: row.requesterName || '',
        amount: 0,
        datetime: row.createdAt || new Date().toISOString(),
        status: `${eventType}_request`,
        statusLabel: label,
        sourceStatus: row.receiptStatus || '',
        reason:
          row.reasonCodeText ||
          row.cancelReason ||
          row.cancelReasonCategory2 ||
          '',
        modifiedAt: row.modifiedAt || '',
        activeState: true,
        claimStatus: row.returnStatus || row.cancelStatus || row.exchangeStatus || '',
        activeState: true,
        claimStatus: row.returnStatus || row.cancelStatus || row.exchangeStatus || '',
        syncedAt: new Date().toISOString()
      });
    }
  }

  return documents;
}

function exchangeDocuments(rows) {
  const documents = [];

  for (const row of rows) {
    const items =
      Array.isArray(row.exchangeItemDtoV1s) &&
      row.exchangeItemDtoV1s.length
        ? row.exchangeItemDtoV1s
        : [{}];

    for (const item of items) {
      const itemId = String(item.orderItemId || item.targetItemId || 'claim');
      const exchangeId = String(row.exchangeId);

      documents.push({
        id: `coupang-exchange-${exchangeId}-${itemId}`,
        source: 'coupang',
        market: '쿠팡',
        eventType: 'exchange',
        orderNo: String(row.orderId || ''),
        exchangeId,
        product:
          item.orderItemName ||
          item.targetItemName ||
          '교환요청 상품',
        qty: Number(item.quantity || 1),
        buyer: row.exchangeAddressDtoV1?.returnCustomerName || '',
        amount: Number(item.orderItemUnitPrice || 0),
        datetime: row.createdAt || new Date().toISOString(),
        status: 'exchange_request',
        statusLabel: '교환요청',
        sourceStatus: row.exchangeStatus || '',
        reason:
          row.reasonCodeText ||
          row.reasonEtcDetail ||
          '',
        modifiedAt: row.modifiedAt || '',
        activeState: true,
        claimStatus: row.returnStatus || row.cancelStatus || row.exchangeStatus || '',
        activeState: true,
        claimStatus: row.returnStatus || row.cancelStatus || row.exchangeStatus || '',
        syncedAt: new Date().toISOString()
      });
    }
  }

  return documents;
}


async function reconcileActiveClaims(db,eventType,currentDocuments,from){
  const currentIds=new Set(currentDocuments.map(item=>item.id));
  const snapshot=await db.collection('orders').where('source','==','coupang').get();
  const cutoff=from.getTime();
  const stale=[];

  snapshot.forEach(doc=>{
    const data=doc.data()||{};
    if(data.eventType!==eventType) return;
    if(data.activeState===false) return;
    const created=new Date(data.datetime||0).getTime();
    if(!Number.isFinite(created)||created<cutoff) return;
    if(currentIds.has(doc.id)) return;
    stale.push(doc.ref);
  });

  for(let i=0;i<stale.length;i+=400){
    const batch=db.batch();
    stale.slice(i,i+400).forEach(ref=>batch.set(ref,{
      activeState:false,
      status:'resolved',
      statusLabel:'처리완료',
      resolvedReason:'현재 미처리 API 목록에서 제외됨',
      resolvedAt:admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:admin.firestore.FieldValue.serverTimestamp()
    },{merge:true}));
    await batch.commit();
  }

  return stale.length;
}

async function saveClaims(db, documents) {
  let created = 0;
  let existing = 0;
  let statusChanged = 0;
  const createdClaims = [];

  for (const claim of documents) {
    const ref = db.collection('orders').doc(claim.id);

    const result = await db.runTransaction(async tx => {
      const snapshot = await tx.get(ref);

      if (!snapshot.exists) {
        tx.create(ref, {
          ...claim,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return 'created';
      }

      const before = snapshot.data() || {};
      const changed =
        before.sourceStatus !== claim.sourceStatus ||
        before.status !== claim.status ||
        before.modifiedAt !== claim.modifiedAt;

      tx.set(
        ref,
        {
          ...claim,
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
      createdClaims.push(claim);
    } else if (result === 'changed') {
      statusChanged += 1;
    } else {
      existing += 1;
    }
  }

  return {
    found: documents.length,
    created,
    existing,
    statusChanged,
    createdClaims
  };
}

async function fetchReturnStatus(config, status) {
  const now = new Date();
  const from = new Date(now.getTime() - (23 * 60 + 59) * 60 * 1000);
  const path =
    `/v2/providers/openapi/apis/api/v6/vendors/${encodeURIComponent(config.vendorId)}/returnRequests`;

  const payload = await request(config, path, {
    searchType: 'timeFrame',
    createdAtFrom: kstMinute(from),
    createdAtTo: kstMinute(now),
    status,
    cancelType: 'RETURN'
  });

  return Array.isArray(payload.data) ? payload.data : [];
}

export async function syncCancellations(db, config) {
  const now = new Date();
  const from = new Date(now.getTime() - (23 * 60 + 59) * 60 * 1000);
  const path =
    `/v2/providers/openapi/apis/api/v6/vendors/${encodeURIComponent(config.vendorId)}/returnRequests`;

  const payload = await request(config, path, {
    searchType: 'timeFrame',
    createdAtFrom: kstMinute(from),
    createdAtTo: kstMinute(now),
    cancelType: 'CANCEL'
  });

  const paymentCancelled = Array.isArray(payload.data) ? payload.data : [];

  await sleep(1800);

  const releaseStop = await fetchReturnStatus(config, 'RU');
  const documents = returnClaimDocuments(
    [...paymentCancelled, ...releaseStop],
    'cancel'
  );

  const saved=await saveClaims(db, documents);
  saved.deactivated=await reconcileActiveClaims(db,'cancel',documents,from);
  return saved;
}

export async function syncReturns(db, config) {
  const now=new Date();
  const from=new Date(now.getTime()-(23*60+59)*60*1000);
  const received = await fetchReturnStatus(config, 'UC');
  const documents = returnClaimDocuments(received, 'return');
  const saved=await saveClaims(db, documents);
  saved.deactivated=await reconcileActiveClaims(db,'return',documents,from);
  return saved;
}

export async function syncExchanges(db, config) {
  const now = new Date();
  const from = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
  const path =
    `/v2/providers/openapi/apis/api/v4/vendors/${encodeURIComponent(config.vendorId)}/exchangeRequests`;

  const documents = [];
  let nextToken = '';

  for (let page = 0; page < 2; page += 1) {
    const params = {
      createdAtFrom: kstSecond(from),
      createdAtTo: kstSecond(now),
      maxPerPage: '50'
    };

    if (nextToken) params.nextToken = nextToken;

    const payload = await request(config, path, params);
    const rows = Array.isArray(payload.data) ? payload.data : [];
    documents.push(...exchangeDocuments(rows));

    nextToken = payload.nextToken || '';
    if (!nextToken || rows.length === 0) break;

    await sleep(1500);
  }

  const saved=await saveClaims(db, documents);
  saved.deactivated=await reconcileActiveClaims(db,'exchange',documents,from);
  return saved;
}
