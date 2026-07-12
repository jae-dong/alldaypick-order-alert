import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';
import dotenv from 'dotenv';
import { pollCoupangStatuses } from './coupang.js';
import {
  syncCancellations,
  syncReturns,
  syncExchanges
} from './coupang-claims.js';

dotenv.config({path:path.resolve('.env.local')});

const FAST=['ACCEPT','INSTRUCT'];
const SLOW=['DEPARTURE','DELIVERING','FINAL_DELIVERY','NONE_TRACKING'];

function serviceAccount(){
  if(process.env.FIREBASE_SERVICE_ACCOUNT_FILE){
    return JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_FILE,'utf8'));
  }
  if(process.env.FIREBASE_SERVICE_ACCOUNT_JSON){
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  throw new Error('Firebase 서비스 계정 정보가 없습니다.');
}

function coupang(){
  const config={
    accessKey:process.env.COUPANG_ACCESS_KEY,
    secretKey:process.env.COUPANG_SECRET_KEY,
    vendorId:process.env.COUPANG_VENDOR_ID
  };
  if(!config.accessKey||!config.secretKey||!config.vendorId){
    throw new Error('.env.local의 쿠팡 키 3개를 확인하세요.');
  }
  return config;
}

admin.initializeApp({credential:admin.credential.cert(serviceAccount())});

const db=admin.firestore();
const messaging=admin.messaging();
const commandRef=db.collection('system').doc('commands').collection('requests').doc('coupang');
const intervalMinutes=Math.max(1,Number(process.env.POLL_INTERVAL_MINUTES||10));

let running=false;
let lastRequestId='';
let slowIndex=0;
let claimIndex=0;
const CLAIM_TYPES=['cancel','return','exchange'];

async function devices(){
  const snap=await db.collection('devices').where('enabled','==',true).get();
  return snap.docs.map(d=>({id:d.id,...d.data()}))
    .filter(d=>typeof d.token==='string'&&d.token.length>20);
}

async function sendPush(orders){
  const recent=orders.filter(o=>{
    if(o.sourceStatus!=='ACCEPT') return false;
    const t=new Date(o.datetime).getTime();
    return Number.isFinite(t)&&Date.now()-t<=2*60*60*1000;
  });

  if(!recent.length) return {devices:0,sent:0,failed:0};

  const list=await devices();
  if(!list.length){
    console.log('푸시 등록된 휴대폰이 없습니다.');
    return {devices:0,sent:0,failed:0};
  }

  let sent=0,failed=0;

  for(const order of recent){
    const result=await messaging.sendEachForMulticast({
      tokens:list.map(d=>d.token),
      notification:{
        title:'쿠팡 신규주문',
        body:`${String(order.product||'상품').slice(0,90)} · ${Number(order.qty||1)}개`
      },
      data:{
        market:'쿠팡',
        orderId:String(order.id),
        url:'https://jae-dong.github.io/alldaypick-order-alert/'
      },
      webpush:{
        fcmOptions:{link:'https://jae-dong.github.io/alldaypick-order-alert/'},
        notification:{
          icon:'https://jae-dong.github.io/alldaypick-order-alert/icon.svg',
          badge:'https://jae-dong.github.io/alldaypick-order-alert/icon.svg',
          tag:String(order.id),
          renotify:true,
          vibrate:[200,100,200]
        }
      }
    });
    sent+=result.successCount;
    failed+=result.failureCount;
  }

  console.log(`푸시 전송 완료: 성공 ${sent}, 실패 ${failed}`);
  return {devices:list.length,sent,failed};
}

async function fastSync(){
  const result=await pollCoupangStatuses(db,coupang(),{
    statuses:FAST,
    days:2,
    maxPages:2
  });
  return {...result,push:await sendPush(result.createdOrders||[])};
}

async function slowSync(){
  const status=SLOW[slowIndex%SLOW.length];
  slowIndex=(slowIndex+1)%SLOW.length;

  const result=await pollCoupangStatuses(db,coupang(),{
    statuses:[status],
    days:7,
    maxPages:2
  });

  return {...result,slowStatus:status};
}

async function saveIntegration(fast,slow){
  await db.collection('system').doc('integrations').set({
    coupang:{
      name:'쿠팡',
      connected:true,
      lastRun:new Date().toISOString(),
      message:[
        `신규 ${fast.counts.ACCEPT||0}`,
        `발송대기 ${fast.counts.INSTRUCT||0}`,
        slow?`${slow.slowStatus} ${slow.counts[slow.slowStatus]||0}`:''
      ].filter(Boolean).join(' · '),
      lastResult:{
        fast:{
          found:fast.found,
          created:fast.created,
          existing:fast.existing,
          statusChanged:fast.statusChanged,
          counts:fast.counts,
          push:fast.push
        },
        slow:slow?{
          found:slow.found,
          created:slow.created,
          existing:slow.existing,
          statusChanged:slow.statusChanged,
          counts:slow.counts,
          slowStatus:slow.slowStatus
        }:null
      }
    }
  },{merge:true});
}


async function sendClaimPush(claims){
  if(!claims.length) return {devices:0,sent:0,failed:0};

  const list=await devices();
  if(!list.length){
    console.log('CS 푸시 등록된 휴대폰이 없습니다.');
    return {devices:0,sent:0,failed:0};
  }

  let sent=0,failed=0;

  for(const claim of claims){
    const title=
      claim.eventType==='cancel' ? '쿠팡 주문취소' :
      claim.eventType==='return' ? '쿠팡 반품요청' :
      '쿠팡 교환요청';

    const result=await messaging.sendEachForMulticast({
      tokens:list.map(d=>d.token),
      notification:{
        title,
        body:`${String(claim.product||'상품').slice(0,90)} · ${Number(claim.qty||1)}개`
      },
      data:{
        market:'쿠팡',
        eventType:String(claim.eventType||''),
        claimId:String(claim.id),
        url:'https://jae-dong.github.io/alldaypick-order-alert/'
      },
      webpush:{
        fcmOptions:{link:'https://jae-dong.github.io/alldaypick-order-alert/'},
        notification:{
          icon:'https://jae-dong.github.io/alldaypick-order-alert/icon.svg',
          badge:'https://jae-dong.github.io/alldaypick-order-alert/icon.svg',
          tag:String(claim.id),
          renotify:true,
          vibrate:[200,100,200]
        }
      }
    });

    sent+=result.successCount;
    failed+=result.failureCount;
  }

  console.log(`CS 푸시 전송 완료: 성공 ${sent}, 실패 ${failed}`);
  return {devices:list.length,sent,failed};
}

async function syncOneClaimType(){
  const type=CLAIM_TYPES[claimIndex%CLAIM_TYPES.length];
  claimIndex=(claimIndex+1)%CLAIM_TYPES.length;

  let result;

  if(type==='cancel'){
    result=await syncCancellations(db,coupang());
  }else if(type==='return'){
    result=await syncReturns(db,coupang());
  }else{
    result=await syncExchanges(db,coupang());
  }

  const push=await sendClaimPush(result.createdClaims||[]);

  return {
    ...result,
    claimType:type,
    push
  };
}


async function run(source){
  if(running) return;
  running=true;

  console.log(`[${new Date().toISOString()}] ${source} 쿠팡 안정화 동기화 시작`);

  if(source==='immediate'){
    await commandRef.set({
      status:'running',
      startedAt:admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:admin.firestore.FieldValue.serverTimestamp()
    },{merge:true});
  }

  try{
    const fast=await fastSync();
    let slow=null;

    let claim=null;

    if(source==='interval'){
      await new Promise(r=>setTimeout(r,5000));
      slow=await slowSync();

      await new Promise(r=>setTimeout(r,5000));
      claim=await syncOneClaimType();
    }

    await saveIntegration(fast,slow);

    if(claim){
      await db.collection('system').doc('integrations').set({
        coupangCs:{
          connected:true,
          lastRun:new Date().toISOString(),
          claimType:claim.claimType,
          found:claim.found,
          created:claim.created,
          existing:claim.existing,
          statusChanged:claim.statusChanged,
          push:claim.push
        }
      },{merge:true});
    }

    if(source==='immediate'){
      await commandRef.set({
        status:'success',
        result:{
          found:fast.found,
          created:fast.created,
          existing:fast.existing,
          statusChanged:fast.statusChanged,
          counts:fast.counts,
          push:fast.push
        },
        completedAt:admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:admin.firestore.FieldValue.serverTimestamp()
      },{merge:true});
    }

    console.log(
      `빠른동기화 완료: 신규 ${fast.counts.ACCEPT||0}, `+
      `발송대기 ${fast.counts.INSTRUCT||0}, `+
      `신규저장 ${fast.created}, 상태변경 ${fast.statusChanged}`
    );

    if(slow){
      console.log(
        `저주기동기화 완료: ${slow.slowStatus} `+
        `${slow.counts[slow.slowStatus]||0}, 상태변경 ${slow.statusChanged}`
      );
    }

    if(claim){
      const label=
        claim.claimType==='cancel' ? '주문취소' :
        claim.claimType==='return' ? '반품요청' :
        '교환요청';

      console.log(
        `CS동기화 완료: ${label} 발견 ${claim.found}, `+
        `신규 ${claim.created}, 상태변경 ${claim.statusChanged}`
      );
    }
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    console.error(message);

    if(source==='immediate'){
      await commandRef.set({
        status:'error',
        error:message,
        completedAt:admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:admin.firestore.FieldValue.serverTimestamp()
      },{merge:true});
    }
  }finally{
    running=false;
  }
}

commandRef.onSnapshot(snap=>{
  if(!snap.exists) return;
  const data=snap.data()||{};
  if(data.status!=='requested'||!data.requestId||data.requestId===lastRequestId) return;
  lastRequestId=data.requestId;
  run('immediate');
},error=>console.error('즉시수집 감시 오류:',error.message));

await run('startup');
setInterval(()=>run('interval'),intervalMinutes*60*1000);

console.log(
  `로컬 수집기 실행 중 · ${intervalMinutes}분 자동수집 · `+
  `신규/발송대기 우선동기화 · 배송상태 순환동기화 · 취소/반품/교환 순환동기화 · 429 자동대기`
);
