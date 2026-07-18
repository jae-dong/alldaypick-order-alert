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
import { syncSmartstore,syncSmartstoreInquiries } from './smartstore.js';
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
import { syncCoupangInquiries } from './coupang-inquiries.js';
import { migrateLegacyDocuments } from './order-store.js';

dotenv.config({path:path.resolve('.env.local')});

const fastPollMinutes=Number(process.env.FAST_POLL_MINUTES||10);
const fullSyncEvery=Number(process.env.FULL_SYNC_EVERY||4);
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


const QUOTA_COOLDOWN_MS=15*60*1000;
const HEARTBEAT_INTERVAL_MS=60*1000;
let quotaBlockedUntil=0;
let agentLockReleased=false;

function quotaExceeded(error){
  const message=String(
    error instanceof Error
      ?error.message
      :error
  ).toUpperCase();

  return (
    message.includes('RESOURCE_EXHAUSTED') ||
    message.includes('QUOTA EXCEEDED')
  );
}

function inQuotaCooldown(){
  return Date.now()<quotaBlockedUntil;
}

function markQuotaCooldown(error){
  if(!quotaExceeded(error)){
    return false;
  }

  quotaBlockedUntil=Date.now()+QUOTA_COOLDOWN_MS;

  console.error(
    '[무료 한도 보호] Firestore 저장을 15분 쉬고 자동 재시도합니다.'
  );

  return true;
}

function stableObject(value){
  if(value===undefined){
    return undefined;
  }

  if(value===null||typeof value!=='object'){
    return value;
  }

  if(Array.isArray(value)){
    return value
      .map(stableObject)
      .filter(item=>item!==undefined);
  }

  if(
    value instanceof Date ||
    typeof value?.toDate==='function' ||
    value?.constructor?.name==='FieldValue'
  ){
    return value;
  }

  return Object.keys(value)
    .sort()
    .reduce((result,key)=>{
      const clean=stableObject(value[key]);

      if(clean!==undefined){
        result[key]=clean;
      }

      return result;
    },{});
}

function stableJson(value){
  return JSON.stringify(stableObject(value));
}

const lastWrittenHashes=new Map();

async function setOnlyWhenChanged(reference,data,options={merge:true}){
  if(inQuotaCooldown()){
    return {
      skipped:true,
      reason:'quota-cooldown'
    };
  }

  const clean=stableObject(data);
  const hash=stableJson(clean);
  const previous=lastWrittenHashes.get(reference.path);

  if(previous===hash){
    return {
      skipped:true,
      reason:'unchanged'
    };
  }

  try{
    await reference.set(clean,options);
    lastWrittenHashes.set(reference.path,hash);

    return {
      skipped:false
    };
  }catch(error){
    markQuotaCooldown(error);
    throw error;
  }
}

function acquireSingleAgentLock(){
  const lockPath=new URL(
    './.agent-running.lock',
    import.meta.url
  );

  try{
    const fd=fs.openSync(lockPath,'wx');
    fs.writeFileSync(
      fd,
      String(process.pid),
      'utf8'
    );
    fs.closeSync(fd);

    const release=()=>{
      if(agentLockReleased){
        return;
      }

      agentLockReleased=true;

      try{
        fs.unlinkSync(lockPath);
      }catch{}
    };

    process.on('exit',release);
    process.on('SIGINT',()=>{
      release();
      process.exit(0);
    });
    process.on('SIGTERM',()=>{
      release();
      process.exit(0);
    });

    return true;
  }catch{
    console.error(
      '이미 다른 PC 수집기가 실행 중입니다. 기존 검은 창을 먼저 종료해 주세요.'
    );
    return false;
  }
}

const commandRef=db.collection('system').doc('commands').collection('requests').doc('coupang');
const intervalMinutes=Math.max(1,Number(process.env.POLL_INTERVAL_MINUTES||10));

let running=false;
let fastRunning=false;
let fastLoopCount=0;
let lastRequestId='';
let slowIndex=0;
let smartstoreRunning=false;
let claimIndex=0;
const CLAIM_TYPES=['cancel','return','exchange','inquiry'];



const TELEGRAM_LEDGER_PATH=path.resolve('.telegram-alert-ledger.json');
const AGENT_STARTED_AT=Date.now();
const TELEGRAM_NEW_EVENT_GRACE_MS=10*60*1000;
const TELEGRAM_LEDGER_MAX=5000;

let telegramBaselineMode=true;
let telegramLedger=loadTelegramLedger();

function loadTelegramLedger(){
  const empty={
    version:1,
    initializedAt:'',
    sent:{}
  };

  try{
    if(!fs.existsSync(TELEGRAM_LEDGER_PATH)){
      return empty;
    }

    const raw=fs
      .readFileSync(TELEGRAM_LEDGER_PATH,'utf8')
      .replace(/^\uFEFF/,'')
      .trim();

    if(!raw){
      return empty;
    }

    const parsed=JSON.parse(raw);

    return {
      version:1,
      initializedAt:String(parsed.initializedAt||''),
      sent:
        parsed.sent&&typeof parsed.sent==='object'
          ?parsed.sent
          :{}
    };
  }catch(error){
    console.error(
      '텔레그램 중복방지 기록 자동복구:',
      error instanceof Error?error.message:String(error)
    );

    try{
      if(fs.existsSync(TELEGRAM_LEDGER_PATH)){
        fs.renameSync(
          TELEGRAM_LEDGER_PATH,
          `${TELEGRAM_LEDGER_PATH}.corrupt-${Date.now()}`
        );
      }
    }catch{}

    return empty;
  }
}

function saveTelegramLedger(){
  try{
    const entries=Object.entries(
      telegramLedger.sent||{}
    )
      .sort((a,b)=>Number(b[1]||0)-Number(a[1]||0))
      .slice(0,TELEGRAM_LEDGER_MAX);

    telegramLedger.sent=Object.fromEntries(entries);

    const temporary=`${TELEGRAM_LEDGER_PATH}.tmp`;

    fs.writeFileSync(
      temporary,
      JSON.stringify(telegramLedger,null,2),
      {
        encoding:'utf8',
        flag:'w'
      }
    );

    fs.renameSync(temporary,TELEGRAM_LEDGER_PATH);
  }catch(error){
    console.error(
      '텔레그램 중복방지 기록 저장 실패:',
      error instanceof Error?error.message:String(error)
    );
  }
}

function telegramEventTimestamp(order){
  const values=[
    order?.claimRequestedAt,
    order?.requestDate,
    order?.requestAt,
    order?.inquiryDate,
    order?.inquiryAt,
    order?.statusChangedAt,
    order?.sourceUpdatedAt,
    order?.orderDate,
    order?.orderAt,
    order?.orderedAt,
    order?.paymentDate,
    order?.paymentAt,
    order?.createdAt,
    order?.datetime
  ];

  for(const value of values){
    if(!value) continue;

    if(typeof value?.toDate==='function'){
      const time=value.toDate().getTime();

      if(Number.isFinite(time)){
        return time;
      }
    }

    const time=new Date(value).getTime();

    if(Number.isFinite(time)){
      return time;
    }
  }

  return 0;
}

function telegramAlertKey(order,marketName){
  const type=telegramAlertType(order);
  const orderNo=String(
    order?.orderNo||
    order?.orderId||
    order?.claimId||
    order?.inquiryId||
    order?.id||
    ''
  ).trim();

  const itemNo=String(
    order?.productOrderId||
    order?.orderItemId||
    order?.vendorItemId||
    order?.productNo||
    order?.itemId||
    order?.sku||
    order?.product||
    ''
  ).trim();

  return [
    marketName,
    type,
    orderNo,
    itemNo
  ].join('|');
}

function rememberTelegramAlert(order,marketName){
  const key=telegramAlertKey(order,marketName);

  if(!key||key.endsWith('||')){
    return;
  }

  telegramLedger.sent[key]=Date.now();
  saveTelegramLedger();
}

function telegramAlertAlreadySent(order,marketName){
  const key=telegramAlertKey(order,marketName);
  return Boolean(key&&telegramLedger.sent?.[key]);
}

function shouldSendTelegramAlert(order,marketName,source='interval'){
  const type=telegramAlertType(order);

  if(!['new_order','cancel','return','inquiry'].includes(type)){
    return {
      send:false,
      reason:'unsupported'
    };
  }

  if(inQuotaCooldown()){
    return {
      send:false,
      reason:'quota-cooldown'
    };
  }

  if(telegramAlertAlreadySent(order,marketName)){
    return {
      send:false,
      reason:'duplicate'
    };
  }

  if(
    telegramBaselineMode ||
    source==='startup' ||
    source==='reconcile'
  ){
    rememberTelegramAlert(order,marketName);

    return {
      send:false,
      reason:'baseline'
    };
  }

  const eventTime=telegramEventTimestamp(order);

  if(
    eventTime &&
    eventTime<AGENT_STARTED_AT-TELEGRAM_NEW_EVENT_GRACE_MS
  ){
    rememberTelegramAlert(order,marketName);

    return {
      send:false,
      reason:'old-event'
    };
  }

  return {
    send:true,
    reason:'new-event'
  };
}

async function sendOrderTelegramAlert(
  order,
  marketName,
  source='interval'
){
  const decision=shouldSendTelegramAlert(
    order,
    marketName,
    source
  );

  if(!decision.send){
    return {
      enabled:telegramConfigured(),
      sent:0,
      failed:0,
      skipped:1,
      reason:decision.reason
    };
  }

  const result=await sendTelegram(
    telegramAlertTitle(order,marketName),
    telegramOrderBody(order),
    {
      attempts:2,
      alert:true
    }
  );

  if(result.sent){
    rememberTelegramAlert(order,marketName);
  }

  return {
    ...result,
    skipped:0
  };
}


function telegramConfigured(){
  return Boolean(
    String(process.env.TELEGRAM_BOT_TOKEN||'').trim() &&
    String(process.env.TELEGRAM_CHAT_ID||'').trim()
  );
}

async function sendTelegram(title,body,options={}){
  if(
    inQuotaCooldown() &&
    !options.test
  ){
    return {
      enabled:telegramConfigured(),
      sent:0,
      failed:0,
      skipped:1,
      reason:'quota-cooldown'
    };
  }
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

async function sendPush(
  orders,
  marketName='쿠팡',
  source='interval'
){
  let sent=0;
  let failed=0;
  let skipped=0;

  for(const order of orders){
    if(telegramAlertType(order)!=='new_order'){
      continue;
    }

    const result=await sendOrderTelegramAlert(
      order,
      marketName,
      source
    );

    sent+=result.sent||0;
    failed+=result.failed||0;
    skipped+=result.skipped||0;
  }

  return {
    devices:0,
    sent,
    failed,
    skipped,
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
  return {...result,push:await sendPush(result.createdOrders||[],'쿠팡',source)};
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
      maxPages:reconcile?15:5,
      reconcile
    }),
    reconcile?720000:360000
  );

  return {
    ...result,
    push:await sendPush(result.createdOrders||[],'쿠팡',source)
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
  await setOnlyWhenChanged(db.collection('system').doc('integrations'),{
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


async function sendClaimPush(
  claims,
  source='interval'
){
  let sent=0;
  let failed=0;
  let skipped=0;

  for(const claim of claims){
    const type=telegramAlertType(claim);

    if(!['cancel','return','inquiry'].includes(type)){
      continue;
    }

    const result=await sendOrderTelegramAlert(
      claim,
      '쿠팡',
      source
    );

    sent+=result.sent||0;
    failed+=result.failed||0;
    skipped+=result.skipped||0;
  }

  return {
    devices:0,
    sent,
    failed,
    skipped,
    channel:'telegram'
  };
}


async function syncAllClaimTypes(source='interval'){
  const reconcile=['reconcile','startup','immediate'].includes(source);
  const results=[];

  for(const type of CLAIM_TYPES){
    let result;

    if(type==='cancel'){
      result=await syncCancellations(db,coupang(),reconcile);
    }else if(type==='return'){
      result=await syncReturns(db,coupang(),reconcile);
    }else if(type==='exchange'){
      result=await syncExchanges(db,coupang(),reconcile);
    }else{
      result=await syncCoupangInquiries(db,coupang(),reconcile);
    }

    const push=await sendClaimPush(result.createdClaims||[],source);
    results.push({...result,claimType:type,push});

    // Avoid Coupang rate limiting between claim API calls.
    await new Promise(r=>setTimeout(r,3500));
  }

  return results;
}


async function syncOneClaimType(source='interval'){
  const reconcile=['reconcile','startup','immediate'].includes(source);
  const type=CLAIM_TYPES[claimIndex%CLAIM_TYPES.length];
  claimIndex=(claimIndex+1)%CLAIM_TYPES.length;

  let result;

  if(type==='cancel'){
    result=await syncCancellations(db,coupang(),reconcile);
  }else if(type==='return'){
    result=await syncReturns(db,coupang(),reconcile);
  }else if(type==='exchange'){
    result=await syncExchanges(db,coupang(),reconcile);
  }else{
    result=await syncCoupangInquiries(db,coupang(),reconcile);
  }

  const push=await sendClaimPush(result.createdClaims||[],source);

  return {
    ...result,
    claimType:type,
    push
  };
}



function connectedMarketLookbackMinutes(source){
  if(source==='reconcile'){
    return monthStartMinutes();
  }

  // 주문 누락 방지: PC 수집기가 중간에 꺼졌거나 API 응답이 늦어도
  // 연결된 마켓은 한국시간 오늘 00:00부터 매번 겹쳐 다시 조회한다.
  const now=new Date();
  const kstParts=new Intl.DateTimeFormat(
    'sv-SE',
    {
      timeZone:'Asia/Seoul',
      year:'numeric',
      month:'2-digit',
      day:'2-digit',
      hour:'2-digit',
      minute:'2-digit',
      second:'2-digit',
      hour12:false
    }
  ).formatToParts(now);

  const values=Object.fromEntries(
    kstParts.map(part=>[part.type,part.value])
  );
  const startOfTodayKst=new Date(
    `${values.year}-${values.month}-${values.day}T00:00:00+09:00`
  );
  const elapsed=Math.ceil(
    (now.getTime()-startOfTodayKst.getTime())/60000
  );

  // 자정 직후에도 전날 늦게 들어온 주문을 놓치지 않도록 2시간 여유를 둔다.
  return Math.min(26*60,Math.max(180,elapsed+120));
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


async function sendMarketplacePush(
  orders,
  marketName,
  source='interval'
){
  let sent=0;
  let failed=0;
  let skipped=0;

  for(const order of orders){
    if(telegramAlertType(order)!=='new_order'){
      continue;
    }

    const result=await sendOrderTelegramAlert(
      order,
      marketName,
      source
    );

    sent+=result.sent||0;
    failed+=result.failed||0;
    skipped+=result.skipped||0;
  }

  return {
    devices:0,
    sent,
    failed,
    skipped,
    channel:'telegram'
  };
}





async function sendElevenstStatusPush(
  changes,
  source='interval'
){
  let sent=0;
  let failed=0;
  let skipped=0;

  for(const order of changes){
    const type=telegramAlertType(order);

    if(!['cancel','return','inquiry'].includes(type)){
      continue;
    }

    const result=await sendOrderTelegramAlert(
      order,
      '11번가',
      source
    );

    sent+=result.sent||0;
    failed+=result.failed||0;
    skipped+=result.skipped||0;
  }

  return {
    devices:0,
    sent,
    failed,
    skipped,
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
      await setOnlyWhenChanged(db.collection('system').doc('integrations'),{
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

    const minutes=connectedMarketLookbackMinutes(source);

    const result=await withTimeout(
      '11번가 주문조회',
      syncElevenstOrders(db,config,minutes),
      source==='reconcile'?180000:90000
    );

    await new Promise(r=>setTimeout(r,1800));

    const statusResult=await syncElevenstStatuses(
      db,
      config
    );

    const push=await sendMarketplacePush(
      result.createdOrders||[],
      '11번가',
      source
    );

    const statusPush=await sendElevenstStatusPush(
      statusResult.changedOrders||[],
      source
    );

    await setOnlyWhenChanged(db.collection('system').doc('integrations'),{
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

    await setOnlyWhenChanged(db.collection('system').doc('integrations'),{
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
      await setOnlyWhenChanged(db.collection('system').doc('integrations'),{
        smartstore:{
          name:'스마트스토어',
          connected:false,
          lastRun:new Date().toISOString(),
          message:'API 키 등록 필요'
        }
      },{merge:true});
      return null;
    }

    const reconcile=source==='reconcile'||source==='startup'||source==='immediate';
    const minutes=connectedMarketLookbackMinutes(source);
    const result=await withTimeout(
      '스마트스토어 주문조회',
      syncSmartstore(db,smartstoreConfig(),minutes,{reconcile}),
      reconcile?480000:180000
    );

    const inquiryResult=await withTimeout(
      '스마트스토어 문의조회',
      syncSmartstoreInquiries(db,smartstoreConfig(),{reconcile}),
      300000
    ).catch(error=>{
      console.error('스마트스토어 문의조회 실패:',error.message);
      return {found:0,created:0,statusChanged:0,createdClaims:[],complete:false,error:error.message};
    });

    const push=await sendMarketplacePush(result.createdOrders||[],'스마트스토어',source);
    let inquirySent=0;
    for(const inquiry of inquiryResult.createdClaims||[]){
      const sentResult=await sendOrderTelegramAlert(inquiry,'스마트스토어',source);
      inquirySent+=sentResult.sent||0;
    }

    await setOnlyWhenChanged(db.collection('system').doc('integrations'),{
      smartstore:{
        name:'스마트스토어',connected:true,lastRun:new Date().toISOString(),
        message:`정상 조회 · 주문문서 ${result.found} · 상태변경 ${result.statusChanged} · 미답변문의 ${inquiryResult.found||0}`,
        lastResult:{
          found:result.found,created:result.created,existing:result.existing,statusChanged:result.statusChanged,
          inquiries:{found:inquiryResult.found||0,created:inquiryResult.created||0,statusChanged:inquiryResult.statusChanged||0,complete:inquiryResult.complete!==false},
          push,inquirySent
        }
      }
    },{merge:true});

    console.log(
      `스마트스토어 동기화 완료: 주문문서 ${result.found}, `+
      `상태변경 ${result.statusChanged}, 미답변문의 ${inquiryResult.found||0}, `+
      `조회구간 ${result.rangeCount||1}`
    );

    return {...result,inquiries:inquiryResult};
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    console.error('스마트스토어 동기화 실패:',message);

    await setOnlyWhenChanged(db.collection('system').doc('integrations'),{
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






async function sendLotteonStatusPush(
  changes,
  source='interval'
){
  let sent=0;
  let failed=0;
  let skipped=0;

  for(const order of changes){
    const type=telegramAlertType(order);

    if(!['cancel','return','inquiry'].includes(type)){
      continue;
    }

    const result=await sendOrderTelegramAlert(
      order,
      '롯데온',
      source
    );

    sent+=result.sent||0;
    failed+=result.failed||0;
    skipped+=result.skipped||0;
  }

  return {
    devices:0,
    sent,
    failed,
    skipped,
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

    const minutes=connectedMarketLookbackMinutes(source);

    const auth=await withTimeout(
      '롯데온 인증',
      testLotteonConnection(config),
      30000
    );

    const result=await withTimeout(
      '롯데온 주문조회',
      syncLotteonOrders(db,config,minutes),
      source==='reconcile'?180000:90000
    );

    result.identity=auth.identity;
    result.sellerId=config.sellerId;

    const push=await sendMarketplacePush(
      result.createdOrders||[],
      '롯데온',
      source
    );

    const statusPush=await sendLotteonStatusPush(
      result.changedOrders||[],
      source
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



let legacyMigrationDone=false;

async function ensureLegacyMigration(){
  if(legacyMigrationDone) return null;
  const result=await migrateLegacyDocuments(db);
  legacyMigrationDone=true;
  console.log(
    `기존 데이터 정리 완료: 검사 ${result.scanned}, 보정 ${result.patched}, `+
    `혼합상태 제외 ${result.legacyClaimsDeactivated}`
  );
  return result;
}

async function writeDiagnostics(reason='sync'){
  try{
    const snapshot=await db.collection('orders').get();
    const counts={};
    snapshot.forEach(doc=>{
      const data=doc.data()||{};
      const market=String(data.market||data.source||'기타');
      const event=String(data.eventType||'order');
      const status=String(data.status||'unknown');
      const active=data.activeState!==false;
      const key=`${market}|${event}|${status}|${active?'active':'closed'}`;
      counts[key]=(counts[key]||0)+1;
    });
    await db.collection('system').doc('diagnostics').set({
      version:'FINAL-7.4.2-INQUIRY-FIX',reason,generatedAt:admin.firestore.FieldValue.serverTimestamp(),
      generatedAtIso:new Date().toISOString(),documentCount:snapshot.size,counts
    },{merge:true});
  }catch(error){
    console.error('진단정보 저장 실패:',error instanceof Error?error.message:String(error));
  }
}

async function writeAgentHeartbeat(reason='interval'){
  const now=new Date();
  const payload={
    online:true,
    channel:'telegram',
    telegramConfigured:telegramConfigured(),
    version:'FINAL-7.4.2-INQUIRY-FIX',
    pid:process.pid,
    host:process.env.COMPUTERNAME||process.env.HOSTNAME||'unknown',
    heartbeatReason:reason,
    heartbeatIntervalSeconds:60,
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
  if(inQuotaCooldown()){
    console.log('[무료 한도 보호 중] 이번 수집은 건너뜁니다.');
    return;
  }
  if(running) return;

  running=true;

  if(['startup','reconcile','immediate'].includes(source)){
    try{await ensureLegacyMigration();}
    catch(error){console.error('기존 데이터 정리 실패:',error instanceof Error?error.message:String(error));}
  }

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
      const useFullStatusSync=[
        'startup',
        'immediate',
        'reconcile'
      ].includes(source);

      const fast=useFullStatusSync
        ?await fullCoupangStatusSync('reconcile')
        :await fastSync(source);

      let slow=null;

      if(!useFullStatusSync){
        try{
          slow=await withTimeout(
            '쿠팡 상태 순환조회',
            slowSync(),
            70000
          );
        }catch(error){
          console.error('쿠팡 상태 순환조회 실패:',error.message);
        }
      }

      summary.coupang={fast,slow};
      await saveIntegration(fast,slow);

      console.log(
        `쿠팡 동기화 완료: 신규 ${fast.counts?.ACCEPT||0}, `+
        `발송대기 ${fast.counts?.INSTRUCT||0}`+
        (slow?` · ${slow.slowStatus} ${slow.counts?.[slow.slowStatus]||0}`:'')
      );
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      summary.coupang={error:message};
      console.error('쿠팡 실패:',message);
    }

    const [smartstoreResult,elevenstResult,lotteonResult]=await Promise.all([
      syncSmartstoreSafe(source).catch(error=>{
        console.error('스마트스토어 실행 오류:',error.message);
        return null;
      }),
      syncElevenstSafe(source).catch(error=>{
        console.error('11번가 실행 오류:',error.message);
        return null;
      }),
      syncLotteonSafe(source).catch(error=>{
        console.error('롯데온 실행 오류:',error.message);
        return null;
      })
    ]);

    summary.smartstore=smartstoreResult;
    summary.elevenst=elevenstResult;
    summary.lotteon=lotteonResult;

    await refreshEsmStatus().catch(error=>{
      console.error('ESM 상태 오류:',error.message);
    });

    try{
      summary.claims=
        reconcile||source==='immediate'||source==='startup'
          ?await withTimeout(
              '쿠팡 CS 전체조회',
              syncAllClaimTypes(source),
              600000
            )
          :source==='interval'
            ?[
                await withTimeout(
                  '쿠팡 CS 순환조회',
                  syncOneClaimType(source),
                  180000
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

    if(['startup','reconcile','immediate'].includes(source)){
      await writeDiagnostics(source);
    }

    if(source==='startup'){
      telegramBaselineMode=false;
      telegramLedger.initializedAt=
        telegramLedger.initializedAt||
        new Date().toISOString();
      saveTelegramLedger();

      console.log(
        '텔레그램 기준설정 완료 · 이후 새 주문만 알림'
      );
    }
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
    await writeAgentHeartbeat(`sync-${source}`);
  }
}

if(!acquireSingleAgentLock()){process.exit(1);}

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

setInterval(()=>writeAgentHeartbeat('interval'),HEARTBEAT_INTERVAL_MS);

setInterval(
  ()=>runFastSync(),
  Math.max(10,Number.isFinite(fastPollMinutes)?fastPollMinutes:10)*60*1000
);

setInterval(
  ()=>run('interval'),
  Math.max(30,Number.isFinite(intervalMinutes)?intervalMinutes:30)*60*1000
);


let lastDailyReconcileDay='';

setInterval(()=>{
  const parts=new Intl.DateTimeFormat(
    'sv-SE',
    {
      timeZone:'Asia/Seoul',
      year:'numeric',
      month:'2-digit',
      day:'2-digit',
      hour:'2-digit',
      minute:'2-digit',
      hour12:false
    }
  ).formatToParts(new Date());

  const values=Object.fromEntries(
    parts.map(part=>[part.type,part.value])
  );

  const day=`${values.year}-${values.month}-${values.day}`;
  const hour=Number(values.hour);
  const minute=Number(values.minute);

  if(
    hour===3 &&
    minute>=10 &&
    minute<20 &&
    day!==lastDailyReconcileDay
  ){
    lastDailyReconcileDay=day;

    run('reconcile').catch(error=>{
      console.error(
        '일일 상태정리 실패:',
        error instanceof Error?error.message:String(error)
      );
    });
  }
},5*60*1000);


console.log(
  `로컬 수집기 준비 완료 · 신규 10분 · 전체상태 30분 · `+
  `텔레그램 테스트 즉시 사용 가능 · 생존신호 1분`
);

run('startup').catch(error=>{
  console.error(
    '시작 수집 실패:',
    error instanceof Error?error.message:String(error)
  );
});


