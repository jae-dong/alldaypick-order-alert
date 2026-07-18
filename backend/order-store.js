import admin from 'firebase-admin';
import { isClaimTerminal } from './workflow-model.js';

const DELETE=admin.firestore.FieldValue.delete();

export function sanitizeFirestoreValue(value){
  if(value===undefined){
    return undefined;
  }

  if(value===null||typeof value!=='object'){
    return value;
  }

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
    if(sanitized!==undefined){
      clean[key]=sanitized;
    }
    return clean;
  },{});
}

function valueTime(value){
  if(!value) return 0;
  if(typeof value?.toDate==='function') return value.toDate().getTime();
  const time=new Date(value).getTime();
  return Number.isFinite(time)?time:0;
}

function changed(before,next){
  const keys=[
    'workflowType','eventType','status','statusLabel','sourceStatus',
    'claimStatus','activeState','qty','amount','invoiceNumber',
    'deliveryCompanyName','answered','modifiedAt','sourceUpdatedAt'
  ];
  return keys.some(key=>String(before?.[key]??'')!==String(next?.[key]??''));
}

export async function upsertDocuments(db,documents,{readUnreadOnCreate=true}={}){
  let created=0;
  let existing=0;
  let statusChanged=0;
  const createdDocuments=[];
  const changedDocuments=[];

  for(const raw of documents){
    if(!raw?.id) continue;
    const document=sanitizeFirestoreValue(raw);
    if(!document?.id) continue;
    const terminal=document.eventType!=='order'&&isClaimTerminal(document);
    if(document.eventType!=='order') document.activeState=!terminal;
    if(document.eventType==='order'&&document.activeState==null) document.activeState=true;

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
      const wasChanged=changed(before,document)||before.activeState===false&&document.activeState===true;
      transaction.set(ref,{
        ...document,
        createdAt:before.createdAt||now,
        updatedAt:now,
        resolvedAt:terminal?(before.resolvedAt||now):DELETE,
        resolvedReason:terminal?(document.resolvedReason||'마켓 API 처리완료 상태'):DELETE
      },{merge:true});
      return {type:wasChanged?'changed':'existing',before};
    });

    if(outcome.type==='created'){
      created+=1;
      createdDocuments.push(document);
    }else if(outcome.type==='changed'){
      statusChanged+=1;
      changedDocuments.push({...document,previousStatus:outcome.before?.status||'',previousEventType:outcome.before?.eventType||'order'});
    }else{
      existing+=1;
    }
  }

  return {found:documents.length,created,existing,statusChanged,createdDocuments,changedDocuments};
}

export async function reconcileOpenDocuments(db,{
  source,eventType,currentIds,from,complete=true,reason='현재 미처리 API 목록에서 제외됨',sourceStatus=''
}){
  if(!complete) return {deactivated:0,skipped:true};
  const activeIds=new Set((currentIds||[]).map(String));
  const cutoff=valueTime(from);
  const snapshot=await db.collection('orders').where('source','==',source).get();
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

      // Earlier versions overwrote the normal order document with a claim.
      // Those mixed legacy documents must not be counted as a second open claim.
      const hasStableClaimId=Boolean(
        String(data.claimId||data.receiptId||data.exchangeId||data.inquiryId||data.questionId||'').trim()
      );

      if(
        eventType!=='order'&&
        !data.claimKey&&
        !hasStableClaimId&&
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

  return {scanned:snapshot.size,patched,legacyClaimsDeactivated};
}
