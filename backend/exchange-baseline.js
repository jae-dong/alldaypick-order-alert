import admin from 'firebase-admin';
import { invalidateOrderStoreMirrorCache } from './order-store.js';

// v7.7.22 배포 시점에 판매자센터에서 실제 미처리 교환이 0건임을 확인했습니다.
// 이 시각 이전에 생성·수정된 legacy 교환 문서는 API가 오래된 PROGRESS 값을
// 되돌려 주더라도 미처리 건수로 다시 살아나지 않게 기준선으로 닫습니다.
export const EXCHANGE_BASELINE_CUTOFF_ISO='2026-07-26T00:55:00+09:00';
export const EXCHANGE_BASELINE_CUTOFF_MS=new Date(EXCHANGE_BASELINE_CUTOFF_ISO).getTime();

function valueTime(value){
  if(!value) return 0;
  if(typeof value?.toDate==='function') return value.toDate().getTime();
  const time=new Date(value).getTime();
  return Number.isFinite(time)?time:0;
}

export function exchangeBusinessTime(value={}){
  for(const candidate of [
    value.claimRequestedAt,
    value.requestDate,
    value.modifiedAt,
    value.datetime,
    value.createdAt,
    value.sourceUpdatedAt
  ]){
    const time=valueTime(candidate);
    if(time) return time;
  }
  return 0;
}

export function isBeforeExchangeBaseline(value={}){
  const time=exchangeBusinessTime(value);
  // 시각이 없는 legacy 교환 문서는 v7.7.22 이전 데이터로 간주합니다.
  return !time||time<=EXCHANGE_BASELINE_CUTOFF_MS;
}

function normalized(value){
  return String(value??'').trim().toLowerCase();
}

export function isTrackedExchangeDocument(data={},documentId=''){
  const source=[data.source,data.market,data.marketName,data.channel]
    .map(normalized).join(' ');
  const sourceMatched=
    source.includes('coupang')||source.includes('쿠팡')||
    source.includes('smartstore')||source.includes('naver')||source.includes('스마트스토어')||
    normalized(documentId).startsWith('coupang-exchange-')||
    normalized(documentId).startsWith('smartstore-exchange-');
  if(!sourceMatched) return false;

  const signals=[
    data.eventType,data.workflowType,data.status,data.statusLabel,
    data.sourceStatus,data.claimStatus,data.exchangeStatus,
    data.claimKey,documentId
  ].filter(Boolean).join(' ').toUpperCase();
  return signals.includes('EXCHANGE')||signals.includes('교환');
}

export async function closePreBaselineExchangeDocuments(db,{reason='v7.7.22 교환 0건 기준선 정리'}={}){
  const snapshot=await db.collection('orders')
    .where('activeState','==',true)
    .get();
  const stale=[];

  snapshot.forEach(doc=>{
    const data=doc.data()||{};
    if(!isTrackedExchangeDocument(data,doc.id)) return;
    if(!isBeforeExchangeBaseline(data)) return;
    stale.push(doc.ref);
  });

  for(let index=0;index<stale.length;index+=400){
    const batch=db.batch();
    stale.slice(index,index+400).forEach(ref=>batch.set(ref,{
      activeState:false,
      status:'exchanged',
      statusLabel:'교환완료',
      sourceStatus:'BASELINE_CLOSED',
      claimStatus:'BASELINE_CLOSED',
      exchangeStatus:'BASELINE_CLOSED',
      resolvedReason:reason,
      resolvedAt:admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:admin.firestore.FieldValue.serverTimestamp()
    },{merge:true}));
    await batch.commit();
  }

  if(stale.length) invalidateOrderStoreMirrorCache();
  return {deactivated:stale.length,cutoff:EXCHANGE_BASELINE_CUTOFF_ISO};
}
