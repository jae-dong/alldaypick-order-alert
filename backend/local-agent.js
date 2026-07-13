import crypto from 'node:crypto';
import {
  lotteonConfigFromEnv,
  isLotteonConfigured,
  testLotteonConnection,
  syncLotteonOrders,
  saveLotteonIntegration,
  saveLotteonError
} from './lotteon.js';

import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';
import dotenv from 'dotenv';
import {
  esmConfigFromEnv,
  updateEsmConnectionStatus
} from './esm.js';

import { pollCoupangStatuses } from './coupang.js';
import { syncSmartstore } from './smartstore.js';

const fastPollMinutes=Number(process.env.FAST_POLL_MINUTES||3);
const fullSyncEvery=Number(process.env.FULL_SYNC_EVERY||4);
import {
  elevenstConfigFromEnv,
  isElevenstConfigured,
  syncElevenstOrders,
  syncElevenstStatuses
} from './elevenst.js';
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
const commandRef=db.collection('system').doc('commands').collection('requests').doc('coupang');
const intervalMinutes=Math.max(1,Number(process.env.POLL_INTERVAL_MINUTES||10));

let running=false;
let fastRunning=false;
let fastLoopCount=0;
let lastRequestId='';
let slowIndex=0;
let smartstoreRunning=false;
let claimIndex=0;
const CLAIM_TYPES=['cancel','return','exchange'];


function telegramConfigured(){
  return Boolean(
    String(process.env.TELEGRAM_BOT_TOKEN||'').trim() &&
    String(process.env.TELEGRAM_CHAT_ID||'').trim()
  );
}

async function sendTelegram(title,body,options={}){
  if(!telegramConfigured()){
    return {enabled:false,sent:0,failed:0};
  }

  const token=String(process.env.TELEGRAM_BOT_TOKEN||'').trim();
  const chatId=String(process.env.TELEGRAM_CHAT_ID||'').trim();
  const attempts=Math.max(1,Number(options.attempts||3));

  let lastError='';

  for(let attempt=1;attempt<=attempts;attempt+=1){
    try{
      const response=await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method:'POST',
          headers:{
            'Content-Type':'application/json'
          },
          body:JSON.stringify({
            chat_id:chatId,
            text:`${title}\n\n${body}`,
            disable_web_page_preview:true
          })
        }
      );

      const result=await response.json().catch(()=>({}));

      if(!response.ok||result.ok===false){
        throw new Error(
          result.description||
          `HTTP ${response.status}`
        );
      }

      return {
        enabled:true,
        sent:1,
        failed:0
      };
    }catch(error){
      lastError=
        error instanceof Error
          ? error.message
          : String(error);

      if(attempt<attempts){
        const waitMs=[1500,3500,7000][attempt-1]||7000;
        console.log(
          `텔레그램 전송 재시도 ${attempt}/${attempts} · `+
          `${waitMs/1000}초 대기`
        );
        await new Promise(resolve=>setTimeout(resolve,waitMs));
      }
    }
  }

  console.error('텔레그램 전송 최종 실패:',lastError);

  return {
    enabled:true,
    sent:0,
    failed:1,
    error:lastError
  };
}









function isTelegramAlertOrder(order){
  const eventType=String(order.eventType||'order').toLowerCase();
  const status=String(order.status||'').toLowerCase();
  const sourceStatus=String(order.sourceStatus||'').toUpperCase();

  if(
    eventType==='inquiry' ||
    status.includes('inquiry')
  ){
    return true;
  }

  if(
    eventType==='cancel' ||
    status.includes('cancel') ||
    sourceStatus.includes('CANCEL') ||
    sourceStatus.includes('취소')
  ){
    return true;
  }

  if(
    eventType==='return' ||
    status.includes('return') ||
    sourceStatus.includes('RETURN') ||
    sourceStatus.includes('반품')
  ){
    return true;
  }

  if(
    eventType==='exchange' ||
    status.includes('exchange') ||
    sourceStatus.includes('EXCHANGE') ||
    sourceStatus.includes('교환')
  ){
    return true;
  }

  return (
    eventType==='order' &&
    (
      status==='new' ||
      sourceStatus==='ACCEPT' ||
      sourceStatus.includes('PAYED')
    )
  );
}

function telegramFingerprint(order){
  const parts=[
    order.id||'',
    order.market||order.source||'',
    order.orderNo||'',
    order.orderProductSequence||order.deliveryNo||'',
    order.eventType||'order',
    order.status||'',
    order.sourceStatus||''
  ];

  return crypto
    .createHash('sha256')
    .update(parts.map(v=>String(v||'')).join('|'))
    .digest('hex');
}

function orderEventTitle(order){
  const market=order.market||order.source||'쇼핑몰';
  const icon=telegramStatusIcon(order.status,order.eventType);
  const label=
    order.statusLabel||
    (
      order.eventType==='inquiry'
        ?'문의사항'
        :'상태변경'
    );

  return `${icon} ${market} ${label}`;
}

function orderTimestampMs(order){
  const values=[
    order.updatedAt?.toDate?.()?.getTime?.(),
    order.createdAt?.toDate?.()?.getTime?.(),
    order.syncedAt?new Date(order.syncedAt).getTime():0,
    order.datetime?new Date(order.datetime).getTime():0
  ].filter(value=>Number.isFinite(value)&&value>0);

  return values.length?Math.max(...values):0;
}

async function telegramActivationTime(){
  const ref=db.collection('system').doc('telegram');
  const snapshot=await ref.get();

  if(snapshot.exists){
    const data=snapshot.data()||{};
    const timestamp=data.activatedAt?.toDate?.()?.getTime?.();

    if(Number.isFinite(timestamp)){
      return timestamp;
    }
  }

  const now=admin.firestore.Timestamp.now();

  await ref.set({
    activatedAt:now,
    mode:'ledger',
    updatedAt:admin.firestore.FieldValue.serverTimestamp()
  },{merge:true});

  return now.toMillis();
}

async function notifyOrderOnce(order){
  if(!isTelegramAlertOrder(order)){
    return {
      enabled:telegramConfigured(),
      sent:0,
      failed:0,
      skipped:true,
      reason:'unsupported-alert-type'
    };
  }

  if(!telegramConfigured()){
    return {enabled:false,sent:0,failed:0,skipped:true};
  }

  const fingerprint=telegramFingerprint(order);
  const ref=db.collection('telegram_notifications').doc(fingerprint);
  const snapshot=await ref.get();

  if(snapshot.exists&&snapshot.data()?.status==='sent'){
    return {enabled:true,sent:0,failed:0,skipped:true};
  }

  await ref.set({
    fingerprint,
    orderId:String(order.id||''),
    market:String(order.market||order.source||''),
    orderNo:String(order.orderNo||''),
    eventType:String(order.eventType||'order'),
    status:String(order.status||''),
    statusLabel:String(order.statusLabel||''),
    status:'sending',
    attempts:admin.firestore.FieldValue.increment(1),
    updatedAt:admin.firestore.FieldValue.serverTimestamp()
  },{merge:true});

  const result=await sendTelegram(
    orderEventTitle(order),
    telegramOrderBody(order)
  );

  await ref.set({
    status:result.sent?'sent':'failed',
    lastError:result.error||'',
    sentAt:result.sent
      ?admin.firestore.FieldValue.serverTimestamp()
      :null,
    updatedAt:admin.firestore.FieldValue.serverTimestamp()
  },{merge:true});

  return result;
}

async function replayPendingTelegram(){
  if(!telegramConfigured()) return;

  const activatedAt=await telegramActivationTime();
  const snapshot=await db.collection('orders').get();

  const candidates=snapshot.docs
    .map(doc=>({id:doc.id,...doc.data()}))
    .filter(order=>{
      const time=orderTimestampMs(order);

      return (
        time>=activatedAt &&
        isTelegramAlertOrder(order)
      );
    })
    .sort((a,b)=>orderTimestampMs(a)-orderTimestampMs(b));

  let sent=0;
  let failed=0;
  let skipped=0;

  for(const order of candidates){
    const result=await notifyOrderOnce(order);

    sent+=result.sent||0;
    failed+=result.failed||0;
    skipped+=result.skipped?1:0;

    await new Promise(resolve=>setTimeout(resolve,250));
  }

  if(candidates.length){
    console.log(
      `텔레그램 누락검사: 대상 ${candidates.length}, `+
      `전송 ${sent}, 실패 ${failed}, 이미전송 ${skipped}`
    );
  }
}

function telegramMarketIcon(market){
  const icons={
    쿠팡:'🔴',
    스마트스토어:'🟢',
    '11번가':'🟠',
    롯데온:'🟣',
    G마켓:'🟢',
    옥션:'🔴'
  };

  return icons[market]||'🛒';
}

function telegramStatusIcon(status,eventType){
  if(eventType==='cancel'||status==='cancel_request') return '❌';
  if(eventType==='return'||status==='return_request') return '↩️';
  if(eventType==='exchange'||status==='exchange_request') return '🔄';

  const icons={
    new:'🔔',
    shipping_wait:'📦',
    delivering:'🚚',
    delivered:'✅',
    purchase_confirmed:'🎉'
  };

  return icons[status]||'📌';
}

function telegramOrderBody(order){
  const lines=[
    `📦 ${String(order.product||'상품명 없음').replace(/\s+/g,' ').trim()}`,
    order.option?`⚙️ 옵션: ${order.option}`:'',
    `🔢 수량: ${Number(order.qty||1)}개`,
    `💰 금액: ${Number(order.amount||0).toLocaleString('ko-KR')}원`,
    order.buyer?`👤 구매자: ${order.buyer}`:'',
    order.orderNo?`🧾 주문번호: ${order.orderNo}`:'',
    order.reason?`📝 사유: ${order.reason}`:'',
    order.reasonDetail?`📝 상세: ${order.reasonDetail}`:''
  ].filter(Boolean);

  return lines.join('\n');
}


async function sendPush(orders){
  const recent=orders.filter(order=>{
    if(order.eventType!=='order') return false;
    if(order.status!=='new') return false;

    const time=new Date(order.datetime).getTime();

    return Number.isFinite(time)&&
      Date.now()-time<=2*60*60*1000;
  });

  let sent=0;
  let failed=0;

  for(const order of recent){
    const result=await notifyOrderOnce({
      ...order,
      market:'쿠팡',
      statusLabel:'신규주문'
    });

    sent+=result.sent||0;
    failed+=result.failed||0;
  }

  if(recent.length){
    console.log(
      `쿠팡 텔레그램 알림 완료: 성공 ${sent}, 실패 ${failed}`
    );
  }

  return {
    devices:0,
    sent,
    failed,
    channel:'telegram'
  };
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
  let sent=0;
  let failed=0;

  for(const claim of claims){
    const icon=telegramStatusIcon(
      claim.status,
      claim.eventType
    );

    const result=await notifyOrderOnce({
      ...claim,
      market:'쿠팡'
    });

    sent+=result.sent||0;
    failed+=result.failed||0;
  }

  if(claims.length){
    console.log(
      `쿠팡 CS 텔레그램 완료: 성공 ${sent}, 실패 ${failed}`
    );
  }

  return {
    devices:0,
    sent,
    failed,
    channel:'telegram'
  };
}


async function syncAllClaimTypes(){
  const results=[];

  for(const type of CLAIM_TYPES){
    let result;

    if(type==='cancel'){
      result=await syncCancellations(db,coupang());
    }else if(type==='return'){
      result=await syncReturns(db,coupang());
    }else{
      result=await syncExchanges(db,coupang());
    }

    const push=await sendClaimPush(result.createdClaims||[]);
    results.push({...result,claimType:type,push});

    // Avoid Coupang rate limiting between claim API calls.
    await new Promise(r=>setTimeout(r,3500));
  }

  return results;
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



function smartstoreConfig(){
  return {
    clientId:process.env.NAVER_CLIENT_ID||'',
    clientSecret:process.env.NAVER_CLIENT_SECRET||''
  };
}

function smartstoreConfigured(){
  const config=smartstoreConfig();
  return Boolean(config.clientId&&config.clientSecret);
}


async function sendMarketplacePush(orders,marketName){
  const recent=orders.filter(order=>{
    if(order.eventType!=='order') return false;
    if(order.status!=='new') return false;

    const time=new Date(order.datetime).getTime();

    return Number.isFinite(time)&&
      Date.now()-time<=2*60*60*1000;
  });

  let sent=0;
  let failed=0;

  for(const order of recent){
    const result=await notifyOrderOnce({
      ...order,
      market:marketName,
      statusLabel:'신규주문'
    });

    sent+=result.sent||0;
    failed+=result.failed||0;
  }

  if(recent.length){
    console.log(
      `${marketName} 텔레그램 알림 완료: `+
      `성공 ${sent}, 실패 ${failed}`
    );
  }

  return {
    devices:0,
    sent,
    failed,
    channel:'telegram'
  };
}





async function sendElevenstStatusPush(changes){
  changes=changes.filter(isTelegramAlertOrder);

  let sent=0;
  let failed=0;

  for(const order of changes){
    const icon=telegramStatusIcon(
      order.status,
      order.eventType
    );

    const result=await notifyOrderOnce({
      ...order,
      market:'11번가'
    });

    sent+=result.sent||0;
    failed+=result.failed||0;
  }

  if(changes.length){
    console.log(
      `11번가 상태 텔레그램 완료: `+
      `성공 ${sent}, 실패 ${failed}`
    );
  }

  return {
    devices:0,
    sent,
    failed,
    channel:'telegram'
  };
}


let elevenstRunning=false;

async function syncElevenstSafe(source){
  if(elevenstRunning) return null;
  elevenstRunning=true;

  try{
    const config=elevenstConfigFromEnv(process.env);

    if(!isElevenstConfigured(config)){
      await db.collection('system').doc('integrations').set({
        elevenst:{
          name:'11번가',
          connected:false,
          lastRun:new Date().toISOString(),
          message:'Open API 키 등록 필요'
        }
      },{merge:true});

      console.log('11번가 Open API 키가 아직 등록되지 않았습니다.');
      return null;
    }

    const minutes=
      source==='startup'||source==='immediate'
        ? 24*60
        : 30;

    const result=await syncElevenstOrders(
      db,
      config,
      minutes
    );

    await new Promise(r=>setTimeout(r,1800));

    const statusResult=await syncElevenstStatuses(
      db,
      config
    );

    const push=await sendMarketplacePush(
      result.createdOrders||[],
      '11번가'
    );

    const statusPush=await sendElevenstStatusPush(
      statusResult.changedOrders||[]
    );

    await db.collection('system').doc('integrations').set({
      elevenst:{
        name:'11번가',
        connected:true,
        lastRun:new Date().toISOString(),
        message:
          `주문 ${result.found} · 신규 ${result.created} · `+
          `상태확인 ${statusResult.checked} · 상태변경 ${statusResult.changed}`,
        lastResult:{
          found:result.found,
          created:result.created,
          existing:result.existing,
          statusChanged:result.statusChanged,
          statusChecked:statusResult.checked,
          externalStatusChanged:statusResult.changed,
          statusFailed:statusResult.failed,
          push,
          statusPush
        }
      }
    },{merge:true});

    console.log(
      `11번가 동기화 완료: 발견 ${result.found}, `+
      `신규 ${result.created}, 상태확인 ${statusResult.checked}, `+
      `상태변경 ${statusResult.changed}, `+
      `상태푸시 ${statusPush.sent}`
    );

    return result;
  }catch(error){
    const message=error instanceof Error
      ? error.message
      : String(error);

    console.error('11번가 동기화 실패:',message);

    await db.collection('system').doc('integrations').set({
      elevenst:{
        name:'11번가',
        connected:false,
        lastRun:new Date().toISOString(),
        message
      }
    },{merge:true});

    return null;
  }finally{
    elevenstRunning=false;
  }
}


async function syncSmartstoreSafe(source){
  if(smartstoreRunning) return null;
  smartstoreRunning=true;

  try{
    if(!smartstoreConfigured()){
      await db.collection('system').doc('integrations').set({
        smartstore:{
          name:'스마트스토어',
          connected:false,
          lastRun:new Date().toISOString(),
          message:'API 키 등록 필요'
        }
      },{merge:true});
      return null;
    }

    const minutes=source==='startup'||source==='immediate'?24*60:30;
    const result=await syncSmartstore(
      db,
      smartstoreConfig(),
      minutes
    );

    const push=await sendMarketplacePush(
      result.createdOrders||[],
      '스마트스토어'
    );

    await db.collection('system').doc('integrations').set({
      smartstore:{
        name:'스마트스토어',
        connected:true,
        lastRun:new Date().toISOString(),
        message:`정상 조회 · 발견 ${result.found} · 신규 ${result.created} · 상태변경 ${result.statusChanged}`,
        lastResult:{
          found:result.found,
          created:result.created,
          existing:result.existing,
          statusChanged:result.statusChanged,
          push
        }
      }
    },{merge:true});

    console.log(
      `스마트스토어 동기화 완료: 발견 ${result.found}, `+
      `신규 ${result.created}, 상태변경 ${result.statusChanged}`
    );

    return result;
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    console.error('스마트스토어 동기화 실패:',message);

    await db.collection('system').doc('integrations').set({
      smartstore:{
        name:'스마트스토어',
        connected:false,
        lastRun:new Date().toISOString(),
        message
      }
    },{merge:true});

    return null;
  }finally{
    smartstoreRunning=false;
  }
}






async function sendLotteonStatusPush(changes){
  changes=changes.filter(isTelegramAlertOrder);

  let sent=0;
  let failed=0;

  for(const order of changes){
    const icon=telegramStatusIcon(
      order.status,
      order.eventType
    );

    const result=await notifyOrderOnce({
      ...order,
      market:'롯데온'
    });

    sent+=result.sent||0;
    failed+=result.failed||0;
  }

  if(changes.length){
    console.log(
      `롯데온 상태 텔레그램 완료: `+
      `성공 ${sent}, 실패 ${failed}`
    );
  }

  return {
    devices:0,
    sent,
    failed,
    channel:'telegram'
  };
}


let lotteonRunning=false;

async function syncLotteonSafe(source){
  if(lotteonRunning) return null;
  lotteonRunning=true;

  const config=lotteonConfigFromEnv(process.env);

  try{
    if(!isLotteonConfigured(config)){
      await saveLotteonError(
        db,
        config,
        new Error('API 키와 거래처번호 등록 필요')
      );

      console.log(
        '롯데온 API 키와 거래처번호가 아직 등록되지 않았습니다.'
      );

      return null;
    }

    const minutes=
      source==='startup'||source==='immediate'
        ? 24*60
        : 30;

    const auth=await testLotteonConnection(config);

    const result=await syncLotteonOrders(
      db,
      config,
      minutes
    );

    result.identity=auth.identity;
    result.sellerId=config.sellerId;

    const push=await sendMarketplacePush(
      result.createdOrders||[],
      '롯데온'
    );

    const statusPush=await sendLotteonStatusPush(
      result.changedOrders||[]
    );

    result.push=push;
    result.statusPush=statusPush;

    await saveLotteonIntegration(db,result);

    console.log(
      `롯데온 동기화 완료: 발견 ${result.found}, `+
      `신규 ${result.created}, `+
      `상태변경 ${result.statusChanged}, `+
      `신규푸시 ${push.sent}, `+
      `상태푸시 ${statusPush.sent}`
    );

    return result;
  }catch(error){
    await saveLotteonError(db,config,error);

    console.error(
      '롯데온 동기화 실패:',
      error instanceof Error
        ? error.message
        : String(error)
    );

    return null;
  }finally{
    lotteonRunning=false;
  }
}

async function refreshEsmStatus(){
  try{
    await updateEsmConnectionStatus(
      db,
      esmConfigFromEnv(process.env)
    );
  }catch(error){
    console.error(
      'ESM 연결상태 확인 실패:',
      error instanceof Error?error.message:String(error)
    );
  }
}


async function runFastSync(){
  if(fastRunning||running) return;
  fastRunning=true;
  fastLoopCount+=1;

  try{
    const fast=await fastSync();

    await saveIntegration(fast,null);

    await new Promise(r=>setTimeout(r,1200));
    await syncSmartstoreSafe('interval');

    await new Promise(r=>setTimeout(r,1200));
    await syncElevenstSafe('interval');

    await new Promise(r=>setTimeout(r,800));
    await refreshEsmStatus();

    await new Promise(r=>setTimeout(r,800));
    await syncLotteonSafe('interval');

    console.log(
      `빠른수집 완료: 신규 ${fast.counts?.ACCEPT||0}, `+
      `발송대기 ${fast.counts?.INSTRUCT||0} · `+
      `${fastPollMinutes}분 주기`
    );

    await replayPendingTelegram();

    if(fastLoopCount%fullSyncEvery===0){
      console.log('다음 정규수집에서 전체 상태 순환 확인 예정');
    }
  }catch(error){
    console.error(
      '빠른수집 실패:',
      error instanceof Error?error.message:String(error)
    );
  }finally{
    fastRunning=false;
  }
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
    let claims=[];

    if(source==='interval'){
      await new Promise(r=>setTimeout(r,5000));
      slow=await slowSync();

      await new Promise(r=>setTimeout(r,5000));
      claim=await syncOneClaimType();
      claims=[claim];
    }else{
      // Startup and web immediate collection check all three claim categories.
      await new Promise(r=>setTimeout(r,5000));
      claims=await syncAllClaimTypes();
    }

    await saveIntegration(fast,slow);

    await new Promise(r=>setTimeout(r,2500));
    await syncSmartstoreSafe(source);

    await new Promise(r=>setTimeout(r,1800));
    await syncElevenstSafe(source);

    await new Promise(r=>setTimeout(r,800));
    await refreshEsmStatus();

    await new Promise(r=>setTimeout(r,800));
    await syncLotteonSafe(source);

    if(claims.length){
      const claimSummary={};

      for(const item of claims){
        claimSummary[item.claimType]={
          found:item.found,
          created:item.created,
          existing:item.existing,
          statusChanged:item.statusChanged,
          push:item.push
        };
      }

      await db.collection('system').doc('integrations').set({
        coupangCs:{
          connected:true,
          lastRun:new Date().toISOString(),
          lastMode:source==='interval'?'rotation':'all',
          claims:claimSummary
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

    for(const item of claims){
      const label=
        item.claimType==='cancel' ? '주문취소' :
        item.claimType==='return' ? '반품요청' :
        '교환요청';

      console.log(
        `CS동기화 완료: ${label} 발견 ${item.found}, `+
        `신규 ${item.created}, 상태변경 ${item.statusChanged}`
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


function koreaParts(date=new Date()){
  const parts=new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone:'Asia/Seoul',
      year:'numeric',
      month:'2-digit',
      day:'2-digit',
      hour:'2-digit',
      minute:'2-digit',
      hour12:false
    }
  ).formatToParts(date);

  return Object.fromEntries(
    parts
      .filter(part=>part.type!=='literal')
      .map(part=>[part.type,part.value])
  );
}

function koreaDateKey(date=new Date()){
  const p=koreaParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

async function sendDailyTelegramSummary(kind){
  if(!telegramConfigured()) return;

  const today=koreaDateKey();
  const ref=db.collection('system').doc('telegramDailySummary');
  const snap=await ref.get();
  const state=snap.exists?snap.data()||{}:{};
  const sentKey=`${today}-${kind}`;

  if(state.lastSentKey===sentKey) return;

  const ordersSnap=await db.collection('orders').get();
  const rows=ordersSnap.docs
    .map(doc=>({id:doc.id,...doc.data()}))
    .filter(order=>{
      const raw=
        order.datetime ||
        order.createdAt?.toDate?.()?.toISOString?.() ||
        '';

      if(!raw) return false;

      const date=new Date(raw);
      return !Number.isNaN(date.getTime())&&koreaDateKey(date)===today;
    });

  const saleRows=rows.filter(order=>
    !['cancel','return','exchange','inquiry'].includes(
      String(order.eventType||'order').toLowerCase()
    )
  );

  const sales=saleRows.reduce(
    (sum,order)=>sum+Number(order.amount||0),
    0
  );

  const waiting=rows.filter(order=>
    ['new','shipping_wait'].includes(
      String(order.status||'').toLowerCase()
    )
  ).length;

  const claims=rows.filter(order=>
    ['cancel','return','exchange'].includes(
      String(order.eventType||'').toLowerCase()
    )
  ).length;

  const marketMap={};
  saleRows.forEach(order=>{
    const market=order.market||'기타';
    marketMap[market]=(marketMap[market]||0)+1;
  });

  const marketLines=Object.entries(marketMap)
    .sort((a,b)=>b[1]-a[1])
    .map(([market,count])=>`• ${market}: ${count}건`)
    .join('\n');

  const title=
    kind==='morning'
      ? '☀️ 오늘 주문 현황'
      : '🌙 오늘 마감 요약';

  const body=[
    `📅 ${today}`,
    `🛒 주문: ${saleRows.length}건`,
    `💰 매출: ${sales.toLocaleString('ko-KR')}원`,
    `📦 미처리: ${waiting}건`,
    `⚠️ 취소·반품·교환: ${claims}건`,
    marketLines?`\n쇼핑몰별\n${marketLines}`:''
  ].filter(Boolean).join('\n');

  const result=await sendTelegram(title,body);

  if(result.sent){
    await ref.set({
      lastSentKey:sentKey,
      lastSentAt:admin.firestore.FieldValue.serverTimestamp(),
      lastKind:kind,
      lastDate:today
    },{merge:true});

    console.log(`텔레그램 ${kind} 일일요약 전송 완료`);
  }
}

async function checkDailySummaries(){
  try{
    const p=koreaParts();
    const hour=Number(p.hour);
    const minute=Number(p.minute);

    if(hour===9&&minute<5){
      await sendDailyTelegramSummary('morning');
    }

    if(hour===23&&minute<5){
      await sendDailyTelegramSummary('evening');
    }
  }catch(error){
    console.error(
      '텔레그램 일일요약 실패:',
      error instanceof Error?error.message:String(error)
    );
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
await checkDailySummaries();
setInterval(checkDailySummaries,60*1000);
setInterval(
  ()=>runFastSync(),
  Math.max(1,Number.isFinite(fastPollMinutes)?fastPollMinutes:3)*60*1000
);

setInterval(
  ()=>run('interval'),
  Math.max(5,Number.isFinite(intervalMinutes)?intervalMinutes:10)*60*1000
);

console.log(
  `로컬 수집기 실행 중 · ${intervalMinutes}분 자동수집 · `+
  `쿠팡 전체동기화 · 스마트스토어 자동동기화 · 429 자동대기`
);

setInterval(
  ()=>replayPendingTelegram().catch(error=>
    console.error(
      '텔레그램 누락 재검사 실패:',
      error instanceof Error?error.message:String(error)
    )
  ),
  60*60*1000
);
