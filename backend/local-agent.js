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
    const error='TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID가 없습니다.';

    await db.collection('system').doc('agent').set({
      telegramConfigured:false,
      telegramLastError:error,
      telegramCheckedAt:new Date().toISOString()
    },{merge:true}).catch(()=>{});

    return {enabled:false,sent:0,failed:1,error};
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
          signal:AbortSignal.timeout(15000),
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            chat_id:chatId,
            text:`${title}\n\n${body}`,
            disable_web_page_preview:true
          })
        }
      );

      const result=await response.json().catch(()=>({}));

      if(!response.ok||result.ok===false){
        throw new Error(result.description||`Telegram HTTP ${response.status}`);
      }

      await db.collection('system').doc('agent').set({
        telegramConfigured:true,
        telegramLastSuccess:new Date().toISOString(),
        telegramLastError:'',
        telegramCheckedAt:new Date().toISOString()
      },{merge:true}).catch(()=>{});

      return {enabled:true,sent:1,failed:0};
    }catch(error){
      lastError=error instanceof Error?error.message:String(error);

      if(attempt<attempts){
        const waitMs=[1500,3500,7000][attempt-1]||7000;
        console.log(`텔레그램 전송 재시도 ${attempt}/${attempts}`);
        await new Promise(resolve=>setTimeout(resolve,waitMs));
      }
    }
  }

  await db.collection('system').doc('agent').set({
    telegramConfigured:true,
    telegramLastError:lastError,
    telegramCheckedAt:new Date().toISOString()
  },{merge:true}).catch(()=>{});

  console.error('텔레그램 전송 최종 실패:',lastError);

  return {enabled:true,sent:0,failed:1,error:lastError};
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



function telegramAlertType(order){
  const eventType=String(order?.eventType||'order');
  const status=String(order?.status||'');

  if(eventType==='order'){
    return 'new_order';
  }

  if(
    eventType==='cancel' ||
    status==='cancel' ||
    status==='cancel_request'
  ){
    return 'cancel';
  }

  if(
    eventType==='return' ||
    status==='return' ||
    status==='return_request'
  ){
    return 'return';
  }

  if(
    eventType==='inquiry' ||
    status==='inquiry'
  ){
    return 'inquiry';
  }

  return '';
}

function telegramAlertTitle(order,marketName){
  const type=telegramAlertType(order);
  const icon=telegramMarketIcon(marketName);

  if(type==='new_order'){
    return `${icon} ${marketName} 신규주문`;
  }

  if(type==='cancel'){
    return `❌ ${marketName} 주문취소`;
  }

  if(type==='return'){
    return `↩️ ${marketName} 반품요청`;
  }

  if(type==='inquiry'){
    return `💬 ${marketName} 문의사항`;
  }

  return '';
}

async function sendPush(orders){
  let sent=0;
  let failed=0;

  for(const order of orders){
    if(telegramAlertType(order)!=='new_order'){
      continue;
    }

    const result=await sendTelegram(
      telegramAlertTitle(order,'쿠팡'),
      telegramOrderBody(order)
    );

    sent+=result.sent||0;
    failed+=result.failed||0;
  }

  return {
    devices:0,
    sent,
    failed,
    channel:'telegram'
  };
}


function monthStartMinutes(){
  const now=new Date();
  const start=new Date(now.getFullYear(),now.getMonth(),1,0,0,0,0);

  return Math.ceil(
    (now.getTime()-start.getTime())/60000
  )+60;
}

async function withTimeout(label,promise,ms=45000){
  let timer;

  try{
    return await Promise.race([
      promise,
      new Promise((_,reject)=>{
        timer=setTimeout(
          ()=>reject(
            new Error(
              `${label} ${Math.round(ms/1000)}초 응답시간 초과`
            )
          ),
          ms
        );
      })
    ]);
  }finally{
    clearTimeout(timer);
  }
}

async function fastSync(source='interval'){
  const reconcile=source==='reconcile';

  const result=await withTimeout(
    '쿠팡 주문조회',
    pollCoupangStatuses(db,coupang(),{
      statuses:FAST,
      days:reconcile?Math.max(1,new Date().getDate()):2,
      maxPages:reconcile?15:2
    }),
    reconcile?180000:45000
  );
  return {...result,push:await sendPush(result.createdOrders||[])};
}


async function fullCoupangStatusSync(source='interval'){
  const reconcile=source==='reconcile';
  const statuses=[...FAST,...SLOW];

  const result=await withTimeout(
    '쿠팡 전체 상태조회',
    pollCoupangStatuses(db,coupang(),{
      statuses,
      days:reconcile
        ?Math.max(1,new Date().getDate())
        :7,
      maxPages:reconcile?15:5
    }),
    reconcile?240000:150000
  );

  return {
    ...result,
    push:await sendPush(result.createdOrders||[])
  };
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
    const type=telegramAlertType(claim);

    if(!['cancel','return','inquiry'].includes(type)){
      continue;
    }

    const result=await sendTelegram(
      telegramAlertTitle(claim,'쿠팡'),
      telegramOrderBody(claim)
    );

    sent+=result.sent||0;
    failed+=result.failed||0;
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
  let sent=0;
  let failed=0;

  for(const order of orders){
    if(telegramAlertType(order)!=='new_order'){
      continue;
    }

    const result=await sendTelegram(
      telegramAlertTitle(order,marketName),
      telegramOrderBody(order)
    );

    sent+=result.sent||0;
    failed+=result.failed||0;
  }

  return {
    devices:0,
    sent,
    failed,
    channel:'telegram'
  };
}





async function sendElevenstStatusPush(changes){
  let sent=0;
  let failed=0;

  for(const order of changes){
    const type=telegramAlertType(order);

    if(!['cancel','return','inquiry'].includes(type)){
      continue;
    }

    const result=await sendTelegram(
      telegramAlertTitle(order,'11번가'),
      telegramOrderBody(order)
    );

    sent+=result.sent||0;
    failed+=result.failed||0;
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
      source==='reconcile'
        ?monthStartMinutes()
        :source==='startup'||source==='immediate'
          ?24*60
          :30;

    const result=await withTimeout(
      '11번가 주문조회',
      syncElevenstOrders(db,config,minutes),
      source==='reconcile'?180000:45000
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

    const minutes=
      source==='reconcile'
        ?monthStartMinutes()
        :source==='startup'||source==='immediate'
          ?24*60
          :30;
    const result=await withTimeout(
      '스마트스토어 주문조회',
      syncSmartstore(db,smartstoreConfig(),minutes),
      source==='reconcile'?180000:45000
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
      `신규 ${result.created}, 상태변경 ${result.statusChanged}, `+
      `조회구간 ${result.rangeCount||1}`
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
  let sent=0;
  let failed=0;

  for(const order of changes){
    const type=telegramAlertType(order);

    if(!['cancel','return','inquiry'].includes(type)){
      continue;
    }

    const result=await sendTelegram(
      telegramAlertTitle(order,'롯데온'),
      telegramOrderBody(order)
    );

    sent+=result.sent||0;
    failed+=result.failed||0;
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
      source==='reconcile'
        ?monthStartMinutes()
        :source==='startup'||source==='immediate'
          ?24*60
          :30;

    const auth=await withTimeout(
      '롯데온 인증',
      testLotteonConnection(config),
      30000
    );

    const result=await withTimeout(
      '롯데온 주문조회',
      syncLotteonOrders(db,config,minutes),
      source==='reconcile'?180000:45000
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



async function writeAgentHeartbeat(reason='interval'){
  const now=new Date();
  const payload={
    online:true,
    channel:'telegram',
    telegramConfigured:telegramConfigured(),
    version:'CLEAN-3.2.3',
    pid:process.pid,
    host:process.env.COMPUTERNAME||process.env.HOSTNAME||'unknown',
    heartbeatReason:reason,
    heartbeatIntervalSeconds:30,
    lastSeen:admin.firestore.FieldValue.serverTimestamp(),
    lastSeenIso:now.toISOString(),
    lastSeenEpoch:now.getTime()
  };

  try{
    await db.collection('system').doc('agent').set(
      payload,
      {merge:true}
    );

    console.log(
      `[생존신호 성공] ${now.toLocaleTimeString('ko-KR')} · ${reason}`
    );

    return true;
  }catch(error){
    const message=
      error instanceof Error
        ?error.message
        :String(error);

    console.error(
      `[생존신호 실패] ${now.toLocaleTimeString('ko-KR')} · ${message}`
    );

    return false;
  }
}

async function runTelegramTest(requestId=''){
  const startedAt=new Date().toISOString();

  try{
    const result=await sendTelegram(
      '✅ 올데이픽 텔레그램 테스트',
      [
        '텔레그램 주문알림 연결이 정상입니다.',
        `테스트 시각: ${new Date().toLocaleString('ko-KR')}`,
        '앞으로 신규주문·주문취소·반품요청·문의사항만 이 채팅으로 전송됩니다.'
      ].join('\n')
    );

    const success=(result.sent||0)>0;

    await commandRef.set({
      status:success?'test_success':'test_error',
      action:'telegram_test',
      requestId,
      testResult:result,
      completedAt:admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:admin.firestore.FieldValue.serverTimestamp()
    },{merge:true});

    console.log(
      success
        ? '텔레그램 테스트 메시지 전송 성공'
        : '텔레그램 테스트 메시지 전송 실패'
    );
  }catch(error){
    const message=error instanceof Error?error.message:String(error);

    await commandRef.set({
      status:'test_error',
      action:'telegram_test',
      requestId,
      error:message,
      completedAt:admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:admin.firestore.FieldValue.serverTimestamp()
    },{merge:true});

    console.error('텔레그램 테스트 실패:',message);
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

  const reconcile=source==='reconcile';
  const label=reconcile?'이번달 정밀 동기화':source;

  console.log(`[${new Date().toISOString()}] ${label} 시작`);

  if(source==='immediate'||reconcile){
    await commandRef.set({
      status:'running',
      action:reconcile?'reconcile':'collect',
      startedAt:admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:admin.firestore.FieldValue.serverTimestamp()
    },{merge:true});
  }

  const summary={};

  try{
    try{
      const fast=await fullCoupangStatusSync(reconcile?'reconcile':source);
      summary.coupang=fast;
      await saveIntegration(fast,null);

      console.log(
        `쿠팡 전체상태 완료: 발견 ${fast.found}, 신규 ${fast.created}, `+
        `상태변경 ${fast.statusChanged} · `+
        `신규 ${fast.counts?.ACCEPT||0}, 발송대기 ${fast.counts?.INSTRUCT||0}, `+
        `배송중 ${(fast.counts?.DEPARTURE||0)+(fast.counts?.DELIVERING||0)}, `+
        `배송완료 ${fast.counts?.FINAL_DELIVERY||0}`
      );
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      summary.coupang={error:message};
      console.error('쿠팡 실패:',message);
    }

    summary.smartstore=await syncSmartstoreSafe(source).catch(error=>{
      console.error('스마트스토어 실행 오류:',error.message);
      return null;
    });

    summary.elevenst=await syncElevenstSafe(source).catch(error=>{
      console.error('11번가 실행 오류:',error.message);
      return null;
    });

    await refreshEsmStatus().catch(error=>{
      console.error('ESM 상태 오류:',error.message);
    });

    summary.lotteon=await syncLotteonSafe(source).catch(error=>{
      console.error('롯데온 실행 오류:',error.message);
      return null;
    });

    try{
      summary.claims=
        reconcile||source==='immediate'
          ?await withTimeout(
              '쿠팡 CS 전체조회',
              syncAllClaimTypes(),
              180000
            )
          :source==='interval'
            ?[
                await withTimeout(
                  '쿠팡 CS 순환조회',
                  syncOneClaimType(),
                  45000
                )
              ]
            :[];
    }catch(error){
      console.error('쿠팡 CS 실패:',error.message);
      summary.claims=[];
    }

    if(source==='immediate'||reconcile){
      await commandRef.set({
        status:'success',
        action:reconcile?'reconcile':'collect',
        result:summary,
        completedAt:admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:admin.firestore.FieldValue.serverTimestamp()
      },{merge:true});
    }

    console.log(`${label} 완료`);
  }catch(error){
    const message=error instanceof Error?error.message:String(error);

    console.error(`${label} 전체 오류:`,message);

    if(source==='immediate'||reconcile){
      await commandRef.set({
        status:'error',
        error:message,
        completedAt:admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:admin.firestore.FieldValue.serverTimestamp()
      },{merge:true});
    }
  }finally{
    running=false;
    await writeAgentHeartbeat('startup');
  }
}

commandRef.onSnapshot(snap=>{
  if(!snap.exists) return;

  const data=snap.data()||{};

  if(
    data.status!=='requested' ||
    !data.requestId ||
    data.requestId===lastRequestId
  ){
    return;
  }

  lastRequestId=data.requestId;

  if(data.action==='telegram_test'){
    runTelegramTest(data.requestId);
    return;
  }

  if(data.action==='reconcile'){
    run('reconcile');
    return;
  }

  run('immediate');
},error=>console.error('명령 감시 오류:',error.message));

await writeAgentHeartbeat();

setInterval(
  ()=>writeAgentHeartbeat('interval'),
  30*1000
);

setInterval(
  ()=>runFastSync(),
  Math.max(1,Number.isFinite(fastPollMinutes)?fastPollMinutes:3)*60*1000
);

setInterval(
  ()=>run('interval'),
  Math.max(5,Number.isFinite(intervalMinutes)?intervalMinutes:10)*60*1000
);

console.log(
  `로컬 수집기 준비 완료 · ${intervalMinutes}분 자동수집 · `+
  `텔레그램 테스트 즉시 사용 가능 · 생존신호 30초`
);

run('startup').catch(error=>{
  console.error(
    '시작 수집 실패:',
    error instanceof Error?error.message:String(error)
  );
});
