import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import admin from 'firebase-admin';
import { isClaimTerminal } from './workflow-model.js';

const DELETE=admin.firestore.FieldValue.delete();
const CACHE_VERSION=3;
const CACHE_PATH=path.resolve(
  process.env.FIRESTORE_MIRROR_CACHE_FILE||'.firestore-mirror-cache.json'
);
const ACTIVE_CACHE_MAX_AGE_MS=6*60*60*1000;
const CACHE_RETENTION_MS=120*24*60*60*1000;
const MAX_CACHE_DOCUMENTS=5000;

let mirrorCache=null;

export function sanitizeFirestoreValue(value){
  if(value===undefined) return undefined;
  if(value===null||typeof value!=='object') return value;

  if(Array.isArray(value)){
    return value
      .map(sanitizeFirestoreValue)
      .filter(item=>item!==undefined);
  }

  if(
    value instanceof Date ||
    typeof value?.toDate==='function' ||
    value?.constructor?.name==='FieldValue' ||
    value?.constructor?.name==='Timestamp' ||
    value?.constructor?.name==='GeoPoint' ||
    value?.constructor?.name==='DocumentReference'
  ){
    return value;
  }

  return Object.entries(value).reduce((clean,[key,item])=>{
    const sanitized=sanitizeFirestoreValue(item);
    if(sanitized!==undefined) clean[key]=sanitized;
    return clean;
  },{});
}

function valueTime(value){
  if(!value) return 0;
  if(typeof value?.toDate==='function') return value.toDate().getTime();
  const time=new Date(value).getTime();
  return Number.isFinite(time)?time:0;
}

const NON_SEMANTIC_FIELDS=new Set([
  'syncedAt','sourceUpdatedAt','updatedAt','createdAt',
  'resolvedAt','resolvedReason','lastSeen','lastRun','checkedAt',
  'telegramCheckedAt','telegramLastSuccess','generatedAt','generatedAtIso',
  'stateVerifiedAt','verifiedAt','lastVerifiedAt','imageCheckedAt'
]);

function comparable(value){
  if(value===undefined) return undefined;
  if(value===null||typeof value!=='object') return value;
  if(Array.isArray(value)) return value.map(comparable);
  if(typeof value?.toDate==='function') return value.toDate().toISOString();
  if(value instanceof Date) return value.toISOString();
  if(value?.constructor?.name==='FieldValue') return '[FieldValue]';
  return Object.keys(value).sort().reduce((result,key)=>{
    if(NON_SEMANTIC_FIELDS.has(key)) return result;
    const clean=comparable(value[key]);
    if(clean!==undefined) result[key]=clean;
    return result;
  },{});
}

function stableJson(value){
  return JSON.stringify(comparable(value));
}

function fingerprint(value){
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function sameValue(left,right){
  return stableJson(left)===stableJson(right);
}

export function hasMeaningfulChange(before,next){
  for(const [key,value] of Object.entries(next||{})){
    if(NON_SEMANTIC_FIELDS.has(key)) continue;
    if(!sameValue(before?.[key],value)) return true;
  }
  return false;
}

function defaultCache(){
  return {
    version:CACHE_VERSION,
    activeHydratedAt:0,
    updatedAt:0,
    docs:{}
  };
}

function loadMirrorCache(){
  if(mirrorCache) return mirrorCache;
  try{
    if(!fs.existsSync(CACHE_PATH)){
      mirrorCache=defaultCache();
      return mirrorCache;
    }
    const parsed=JSON.parse(fs.readFileSync(CACHE_PATH,'utf8'));
    if(parsed?.version!==CACHE_VERSION||typeof parsed?.docs!=='object'){
      mirrorCache=defaultCache();
    }else{
      mirrorCache={...defaultCache(),...parsed,docs:parsed.docs||{}};
    }
  }catch(error){
    console.warn('Firestore 로컬 캐시 복구 실패 · 새 캐시로 시작:',error?.message||error);
    mirrorCache=defaultCache();
  }
  return mirrorCache;
}

function cacheBusinessTime(data={}){
  return valueTime(
    data.datetime||data.claimRequestedAt||data.inquiryAt||
    data.orderDate||data.paymentDate||data.createdAt
  );
}

function makeCacheEntry(data={}){
  const semantic=comparable(data)||{};
  return {
    fingerprint:fingerprint(semantic),
    semantic,
    source:String(data.source||''),
    eventType:String(data.eventType||'order'),
    sourceStatus:String(data.sourceStatus||''),
    activeState:data.activeState!==false,
    businessTime:cacheBusinessTime(data),
    touchedAt:Date.now()
  };
}

function pruneCache(cache){
  const now=Date.now();
  const entries=Object.entries(cache.docs||{}).filter(([,entry])=>{
    if(entry?.activeState!==false) return true;
    const time=Number(entry?.businessTime||entry?.touchedAt||0);
    return !time||now-time<=CACHE_RETENTION_MS;
  });

  entries.sort((a,b)=>Number(b[1]?.touchedAt||0)-Number(a[1]?.touchedAt||0));
  cache.docs=Object.fromEntries(entries.slice(0,MAX_CACHE_DOCUMENTS));
}

function saveMirrorCache(){
  const cache=loadMirrorCache();
  pruneCache(cache);
  cache.updatedAt=Date.now();
  const temporary=`${CACHE_PATH}.tmp`;
  try{
    fs.writeFileSync(temporary,JSON.stringify(cache),{encoding:'utf8',flag:'w'});
    fs.renameSync(temporary,CACHE_PATH);
  }catch(error){
    try{ if(fs.existsSync(temporary)) fs.unlinkSync(temporary); }catch{}
    console.warn('Firestore 로컬 캐시 저장 실패:',error?.message||error);
  }
}

function productionCacheSupported(db){
  return typeof db?.getAll==='function';
}

async function getAllSnapshots(db,refs){
  const snapshots=[];
  for(let index=0;index<refs.length;index+=250){
    snapshots.push(...await db.getAll(...refs.slice(index,index+250)));
  }
  return snapshots;
}

async function commitOperations(db,operations){
  let writes=0;
  for(let index=0;index<operations.length;index+=400){
    const batch=db.batch();
    const part=operations.slice(index,index+400);
    for(const operation of part){
      batch.set(operation.ref,operation.payload,{merge:true});
    }
    await batch.commit();
    writes+=part.length;
  }
  return writes;
}


function isOpenOrderDocument(document={}){
  const status=String(document.status||'').toLowerCase();
  const sourceStatus=String(document.sourceStatus||'').toUpperCase();
  if(status==='new'||status==='shipping_wait') return true;
  return new Set([
    'ACCEPT','INSTRUCT','PAYED','ORDER_RECEIVED',
    'PRODUCT_PREPARE','PREPARE_DELIVERY','READY_FOR_SHIPPING'
  ]).has(sourceStatus);
}

function normalizeDocument(raw){
  const document=sanitizeFirestoreValue(raw);
  if(!document?.id) return null;
  const terminal=document.eventType!=='order'&&isClaimTerminal(document);
  if(document.eventType!=='order') document.activeState=!terminal;
  if(document.eventType==='order') document.activeState=isOpenOrderDocument(document);
  return {document,terminal};
}

async function upsertDocumentsCached(db,documents,{readUnreadOnCreate=true}={}){
  let created=0;
  let existing=0;
  let statusChanged=0;
  let cloudReads=0;
  let cloudWrites=0;
  let cacheHits=0;
  const createdDocuments=[];
  const changedDocuments=[];
  const cache=loadMirrorCache();

  const unique=[...new Map(
    (documents||[])
      .filter(item=>item?.id)
      .map(item=>[String(item.id),item])
  ).values()]
    .map(normalizeDocument)
    .filter(Boolean);

  const operations=[];
  const cacheMisses=[];

  for(const item of unique){
    const id=String(item.document.id);
    const incomingEntry=makeCacheEntry(item.document);
    const cached=cache.docs[id];

    if(cached?.fingerprint===incomingEntry.fingerprint){
      existing+=1;
      cacheHits+=1;
      cached.touchedAt=Date.now();
      continue;
    }

    if(cached){
      const now=admin.firestore.FieldValue.serverTimestamp();
      const before=cached.semantic||{};
      const payload={
        ...item.document,
        updatedAt:now,
        resolvedAt:item.terminal?(before.resolvedAt||now):DELETE,
        resolvedReason:item.terminal?(item.document.resolvedReason||'마켓 API 처리완료 상태'):DELETE
      };
      operations.push({
        ref:db.collection('orders').doc(id),
        payload,
        id,
        entry:incomingEntry,
        type:'changed',
        document:item.document,
        before
      });
      continue;
    }

    cacheMisses.push({
      ...item,
      id,
      entry:incomingEntry,
      ref:db.collection('orders').doc(id)
    });
  }

  if(cacheMisses.length){
    const snapshots=await getAllSnapshots(db,cacheMisses.map(item=>item.ref));
    cloudReads+=snapshots.length;

    snapshots.forEach((snapshot,index)=>{
      const item=cacheMisses[index];
      const now=admin.firestore.FieldValue.serverTimestamp();

      if(!snapshot.exists){
        operations.push({
          ref:item.ref,
          payload:{
            ...item.document,
            ...(readUnreadOnCreate?{readStatus:'unread'}:{}),
            createdAt:now,
            updatedAt:now,
            resolvedAt:item.terminal?now:null
          },
          id:item.id,
          entry:item.entry,
          type:'created',
          document:item.document,
          before:null
        });
        return;
      }

      const before=snapshot.data()||{};
      const wasChanged=
        hasMeaningfulChange(before,item.document)||
        (before.activeState===false&&item.document.activeState===true);

      if(!wasChanged){
        existing+=1;
        cache.docs[item.id]=item.entry;
        return;
      }

      operations.push({
        ref:item.ref,
        payload:{
          ...item.document,
          updatedAt:now,
          resolvedAt:item.terminal?(before.resolvedAt||now):DELETE,
          resolvedReason:item.terminal?(item.document.resolvedReason||'마켓 API 처리완료 상태'):DELETE
        },
        id:item.id,
        entry:item.entry,
        type:'changed',
        document:item.document,
        before
      });
    });
  }

  if(operations.length){
    cloudWrites+=await commitOperations(db,operations);
    for(const operation of operations){
      cache.docs[operation.id]=operation.entry;
      if(operation.type==='created'){
        created+=1;
        createdDocuments.push(operation.document);
      }else{
        statusChanged+=1;
        changedDocuments.push({
          ...operation.document,
          previousStatus:operation.before?.status||'',
          previousEventType:operation.before?.eventType||'order'
        });
      }
    }
  }

  saveMirrorCache();

  return {
    found:unique.length,
    created,
    existing,
    statusChanged,
    createdDocuments,
    changedDocuments,
    quota:{cloudReads,cloudWrites,cacheHits}
  };
}

async function upsertDocumentsLegacy(db,documents,{readUnreadOnCreate=true}={}){
  let created=0;
  let existing=0;
  let statusChanged=0;
  const createdDocuments=[];
  const changedDocuments=[];

  const unique=[...new Map(
    (documents||[])
      .filter(item=>item?.id)
      .map(item=>[String(item.id),item])
  ).values()];

  for(const raw of unique){
    const normalized=normalizeDocument(raw);
    if(!normalized) continue;
    const {document,terminal}=normalized;
    const ref=db.collection('orders').doc(String(document.id));
    const outcome=await db.runTransaction(async transaction=>{
      const snapshot=await transaction.get(ref);
      const now=admin.firestore.FieldValue.serverTimestamp();

      if(!snapshot.exists){
        transaction.create(ref,{
          ...document,
          ...(readUnreadOnCreate?{readStatus:'unread'}:{}),
          createdAt:now,
          updatedAt:now,
          resolvedAt:terminal?now:null
        });
        return {type:'created',before:null};
      }

      const before=snapshot.data()||{};
      const wasChanged=
        hasMeaningfulChange(before,document)||
        (before.activeState===false&&document.activeState===true);

      if(!wasChanged) return {type:'existing',before};

      transaction.set(ref,{
        ...document,
        createdAt:before.createdAt||now,
        updatedAt:now,
        resolvedAt:terminal?(before.resolvedAt||now):DELETE,
        resolvedReason:terminal?(document.resolvedReason||'마켓 API 처리완료 상태'):DELETE
      },{merge:true});
      return {type:'changed',before};
    });

    if(outcome.type==='created'){
      created+=1;
      createdDocuments.push(document);
    }else if(outcome.type==='changed'){
      statusChanged+=1;
      changedDocuments.push({
        ...document,
        previousStatus:outcome.before?.status||'',
        previousEventType:outcome.before?.eventType||'order'
      });
    }else{
      existing+=1;
    }
  }

  return {
    found:unique.length,created,existing,statusChanged,
    createdDocuments,changedDocuments,
    quota:{cloudReads:unique.length,cloudWrites:created+statusChanged,cacheHits:0}
  };
}

export async function upsertDocuments(db,documents,options={}){
  return productionCacheSupported(db)
    ?upsertDocumentsCached(db,documents,options)
    :upsertDocumentsLegacy(db,documents,options);
}

async function hydrateActiveCache(db){
  const cache=loadMirrorCache();
  if(Date.now()-Number(cache.activeHydratedAt||0)<ACTIVE_CACHE_MAX_AGE_MS){
    return {reads:0,skipped:true};
  }

  let query=db.collection('orders').where('activeState','==',true);
  if(typeof query.limit==='function') query=query.limit(2000);
  const snapshot=await query.get();
  const staleActiveOrders=[];
  snapshot.forEach(doc=>{
    const data={id:doc.id,...doc.data()};
    const eventType=String(data.eventType||'order');
    const shouldCloseOrder=
      eventType==='order'&&!isOpenOrderDocument(data);
    const shouldCloseClaim=
      eventType!=='order'&&isClaimTerminal(data);

    if(shouldCloseOrder||shouldCloseClaim){
      staleActiveOrders.push({id:doc.id,ref:doc.ref,data});
      data.activeState=false;
    }
    cache.docs[doc.id]=makeCacheEntry(data);
  });

  if(staleActiveOrders.length){
    const operations=staleActiveOrders.map(item=>({
      ref:item.ref,
      payload:{
        activeState:false,
        resolvedReason:'배송 진행/완료 또는 요청 처리완료 상태로 미완료 목록에서 제외',
        resolvedAt:admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:admin.firestore.FieldValue.serverTimestamp()
      }
    }));
    await commitOperations(db,operations);
  }

  cache.activeHydratedAt=Date.now();
  saveMirrorCache();
  return {
    reads:snapshot.size||snapshot.docs?.length||0,
    writes:staleActiveOrders.length,
    skipped:false
  };
}

async function reconcileOpenDocumentsCached(db,{
  source,eventType,currentIds,from,complete=true,
  reason='현재 미처리 API 목록에서 제외됨',sourceStatus=''
}){
  if(!complete) return {deactivated:0,skipped:true,quota:{cloudReads:0,cloudWrites:0}};

  const hydration=await hydrateActiveCache(db);
  const cache=loadMirrorCache();
  const activeIds=new Set((currentIds||[]).map(String));
  const cutoff=valueTime(from);
  const stale=[];

  for(const [id,entry] of Object.entries(cache.docs||{})){
    const data=entry?.semantic||{};
    if(String(entry?.source||data.source||'')!==String(source)) continue;
    if(String(entry?.eventType||data.eventType||'order')!==String(eventType)) continue;
    if(sourceStatus&&String(entry?.sourceStatus||data.sourceStatus||'').toUpperCase()!==String(sourceStatus).toUpperCase()) continue;
    if(entry?.activeState===false||data.activeState===false) continue;
    const businessTime=Number(entry?.businessTime||cacheBusinessTime(data));
    if(cutoff&&businessTime&&businessTime<cutoff) continue;
    if(activeIds.has(id)) continue;
    stale.push({id,entry,ref:db.collection('orders').doc(id)});
  }

  const operations=stale.map(item=>({
    ...item,
    payload:{
      activeState:false,
      resolvedReason:reason,
      resolvedAt:admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:admin.firestore.FieldValue.serverTimestamp()
    }
  }));

  const cloudWrites=await commitOperations(db,operations);
  for(const item of stale){
    const semantic={...(item.entry.semantic||{}),activeState:false};
    cache.docs[item.id]={...makeCacheEntry(semantic),touchedAt:Date.now()};
  }
  if(stale.length) saveMirrorCache();

  return {
    deactivated:stale.length,
    skipped:false,
    quota:{cloudReads:hydration.reads||0,cloudWrites:cloudWrites+Number(hydration.writes||0)}
  };
}

async function reconcileOpenDocumentsLegacy(db,{
  source,eventType,currentIds,from,complete=true,
  reason='현재 미처리 API 목록에서 제외됨',sourceStatus=''
}){
  if(!complete) return {deactivated:0,skipped:true};
  const activeIds=new Set((currentIds||[]).map(String));
  const cutoff=valueTime(from);
  const collection=db.collection('orders');
  let snapshot;
  try{
    snapshot=await collection
      .where('source','==',source)
      .where('eventType','==',eventType)
      .where('activeState','==',true)
      .get();
  }catch(error){
    const message=String(error instanceof Error?error.message:error).toLowerCase();
    if(!message.includes('index')&&!message.includes('failed_precondition')) throw error;
    snapshot=await collection.where('source','==',source).get();
  }
  const stale=[];

  snapshot.forEach(doc=>{
    const data=doc.data()||{};
    if(String(data.eventType||'order')!==String(eventType)) return;
    if(sourceStatus&&String(data.sourceStatus||'').toUpperCase()!==String(sourceStatus).toUpperCase()) return;
    if(data.activeState===false) return;
    const businessTime=valueTime(data.datetime||data.claimRequestedAt||data.inquiryAt||data.createdAt);
    if(cutoff&&businessTime&&businessTime<cutoff) return;
    if(activeIds.has(doc.id)) return;
    stale.push(doc.ref);
  });

  for(let index=0;index<stale.length;index+=400){
    const batch=db.batch();
    stale.slice(index,index+400).forEach(ref=>batch.set(ref,{
      activeState:false,
      resolvedReason:reason,
      resolvedAt:admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:admin.firestore.FieldValue.serverTimestamp()
    },{merge:true}));
    await batch.commit();
  }
  return {deactivated:stale.length,skipped:false};
}

export async function reconcileOpenDocuments(db,options){
  return productionCacheSupported(db)
    ?reconcileOpenDocumentsCached(db,options)
    :reconcileOpenDocumentsLegacy(db,options);
}

export async function migrateLegacyDocuments(db){
  const snapshot=await db.collection('orders').get();
  let patched=0;
  let legacyClaimsDeactivated=0;

  for(let index=0;index<snapshot.docs.length;index+=350){
    const batch=db.batch();
    let writes=0;

    for(const doc of snapshot.docs.slice(index,index+350)){
      const data=doc.data()||{};
      const source=String(data.source||'').toLowerCase();
      const eventType=String(data.eventType||'order').toLowerCase();
      const update={};

      if(!data.schemaVersion) update.schemaVersion=2;
      if(!data.workflowType) update.workflowType=eventType==='order'?'order':eventType==='inquiry'?'inquiry':'claim';
      if(!data.activeState&&data.activeState!==false) update.activeState=true;

      if(eventType!=='order'){
        const claimId=String(data.claimId||data.receiptId||data.exchangeId||data.inquiryId||data.questionId||'').trim();
        if(claimId){
          const normalizedClaimKey=`${source}|${eventType}|${claimId}`;
          if(data.claimKey!==normalizedClaimKey) update.claimKey=normalizedClaimKey;
        }
      }

      if(eventType!=='order'&&isClaimTerminal(data)&&data.activeState!==false){
        update.activeState=false;
        update.resolvedReason='마켓 처리완료 상태 확인';
        update.resolvedAt=admin.firestore.FieldValue.serverTimestamp();
      }

      const hasStableClaimId=Boolean(
        String(data.claimId||data.receiptId||data.exchangeId||data.inquiryId||data.questionId||'').trim()
      );

      if(
        eventType!=='order'&&!data.claimKey&&!hasStableClaimId&&
        !String(doc.id).includes(`-${eventType}-`)
      ){
        update.activeState=false;
        update.resolvedReason='v7.4 legacy mixed-state document excluded';
        update.resolvedAt=admin.firestore.FieldValue.serverTimestamp();
        legacyClaimsDeactivated+=1;
      }

      if(Object.keys(update).length){
        update.updatedAt=admin.firestore.FieldValue.serverTimestamp();
        batch.set(doc.ref,update,{merge:true});
        writes+=1;
        patched+=1;
      }
    }

    if(writes) await batch.commit();
  }

  // A migration changes remote documents outside the normal cache path.
  mirrorCache=defaultCache();
  saveMirrorCache();

  return {scanned:snapshot.size,patched,legacyClaimsDeactivated};
}

export function resetOrderStoreCacheForTests(){
  mirrorCache=defaultCache();
}

export async function getCachedDocuments(db,{
  source='',eventType='',activeOnly=true,hydrate=true
}={}){
  let cloudReads=0;
  if(productionCacheSupported(db)&&hydrate){
    const result=await hydrateActiveCache(db);
    cloudReads=result.reads||0;
  }

  if(!productionCacheSupported(db)){
    let query=db.collection('orders');
    if(source) query=query.where('source','==',source);
    const snapshot=await query.get();
    const documents=[];
    snapshot.forEach(doc=>{
      const data={id:doc.id,...doc.data()};
      if(eventType&&String(data.eventType||'order')!==String(eventType)) return;
      if(activeOnly&&data.activeState===false) return;
      documents.push(data);
    });
    return {documents,cloudReads:snapshot.size||documents.length};
  }

  const cache=loadMirrorCache();
  const documents=[];
  for(const [id,entry] of Object.entries(cache.docs||{})){
    const data={id,...(entry?.semantic||{})};
    if(source&&String(data.source||'')!==String(source)) continue;
    if(eventType&&String(data.eventType||'order')!==String(eventType)) continue;
    if(activeOnly&&data.activeState===false) continue;
    documents.push(data);
  }
  return {documents,cloudReads};
}
