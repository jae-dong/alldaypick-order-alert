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
import {fileURLToPath} from 'node:url';
import admin from 'firebase-admin';
import dotenv from 'dotenv';
import {
  esmConfigFromEnv,
  updateEsmConnectionStatus
} from './esm.js';

import { pollCoupangStatuses } from './coupang.js';
import { syncSmartstore,syncSmartstoreInquiries,retireLegacySmartstoreInquiryCache,resolveSmartstoreProductImage } from './smartstore.js';
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
import { migrateLegacyDocuments,getCachedDocuments } from './order-store.js';
import { quotaExceeded,nextFirestoreFreeResetMs } from './quota-utils.js';
import { telegramOrderBody } from './telegram-format.js';
import { resolveTelegramProductImage } from './product-image.js';

const BACKEND_DIR=path.dirname(fileURLToPath(import.meta.url));
dotenv.config({path:path.join(BACKEND_DIR,'.env.local')});

const fastPollMinutes=Number(process.env.FAST_POLL_MINUTES||10);
const fullSyncEvery=Number(process.env.FULL_SYNC_EVERY||4);
const FAST=['ACCEPT','INSTRUCT'];
const SLOW=['DEPARTURE','DELIVERING','FINAL_DELIVERY','NONE_TRACKING'];

function serviceAccount(){
  if(process.env.FIREBASE_SERVICE_ACCOUNT_FILE){
    const configured=String(process.env.FIREBASE_SERVICE_ACCOUNT_FILE).trim().replace(/^['"]|['"]$/g,'');
    const candidates=path.isAbsolute(configured)
      ? [configured]
      : [path.resolve(BACKEND_DIR,configured),path.resolve(process.cwd(),configured)];
    const fallback=path.join(BACKEND_DIR,'firebase-service-account.json');
    if(!candidates.includes(fallback)) candidates.push(fallback);
    const found=candidates.find(candidate=>fs.existsSync(candidate));
    if(!found){
      throw new Error(`Firebase 인증파일을 찾을 수 없습니다: ${candidates.join(' | ')}`);
    }
    return JSON.parse(fs.readFileSync(found,'utf8'));
  }
  if(process.env.FIREBASE_SERVICE_ACCOUNT_JSON){
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  const fallback=path.join(BACKEND_DIR,'firebase-service-account.json');
  if(fs.existsSync(fallback)) return JSON.parse(fs.readFileSync(fallback,'utf8'));
  throw new Error('Firebase 서비스 계정 정보가 없습니다. backend\firebase-service-account.json을 확인하세요.');
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


const HEARTBEAT_INTERVAL_MS=5*60*1000;
const QUOTA_STATE_PATH=path.join(BACKEND_DIR,'.firestore-quota-cooldown.json');
const SYSTEM_WRITE_CACHE_PATH=path.join(BACKEND_DIR,'.firestore-system-write-cache.json');
const SMARTSTORE_INQUIRY_STATE_PATH=path.join(BACKEND_DIR,'.smartstore-inquiry-state.json');
const SMARTSTORE_INQUIRY_INTERVAL_MS=Math.max(
  30,
  Number(process.env.SMARTSTORE_INQUIRY_INTERVAL_MINUTES||60)
)*60*1000;
const SMARTSTORE_INQUIRY_429_COOLDOWN_MS=Math.max(
  60,
  Number(process.env.SMARTSTORE_INQUIRY_429_COOLDOWN_MINUTES||120)
)*60*1000;
let quotaBlockedUntil=0;
let quotaResumeTimer=null;
let quotaSkipLoggedAt=0;
let agentLockReleased=false;

function defaultSmartstoreInquiryState(){
  return {
    version:1,
    lastAttemptAt:0,
    lastSuccessAt:0,
    blockedUntil:0,
    lastFound:0,
    lastError:''
  };
}

function loadSmartstoreInquiryState(){
  try{
    if(!fs.existsSync(SMARTSTORE_INQUIRY_STATE_PATH)){
      return defaultSmartstoreInquiryState();
    }
    const parsed=JSON.parse(fs.readFileSync(SMARTSTORE_INQUIRY_STATE_PATH,'utf8'));
    return {...defaultSmartstoreInquiryState(),...(parsed||{})};
  }catch{
    return defaultSmartstoreInquiryState();
  }
}

let smartstoreInquiryState=loadSmartstoreInquiryState();

function saveSmartstoreInquiryState(){
  try{
    fs.writeFileSync(
      SMARTSTORE_INQUIRY_STATE_PATH,
      JSON.stringify(smartstoreInquiryState,null,2),
      'utf8'
    );
  }catch(error){
    console.warn('스마트스토어 문의 제한상태 저장 실패:',error?.message||error);
  }
}

function smartstoreInquiryDue(){
  const now=Date.now();
  if(Number(smartstoreInquiryState.blockedUntil||0)>now) return false;
  const lastAttempt=Number(smartstoreInquiryState.lastAttemptAt||0);
  return !lastAttempt||now-lastAttempt>=SMARTSTORE_INQUIRY_INTERVAL_MS;
}

function smartstoreInquiryWaitLabel(){
  const now=Date.now();
  const blocked=Number(smartstoreInquiryState.blockedUntil||0);
  const dueAt=blocked>now
    ?blocked
    :Number(smartstoreInquiryState.lastAttemptAt||0)+SMARTSTORE_INQUIRY_INTERVAL_MS;
  return Math.max(1,Math.ceil((dueAt-now)/60000));
}

async function cachedSmartstoreInquiryResult(reason='간격 보호'){
  const cached=await getCachedDocuments(db,{
    source:'smartstore',eventType:'inquiry',activeOnly:true,hydrate:false
  });
  const documents=cached.documents||[];
  const found=documents.length||Number(smartstoreInquiryState.lastFound||0);
  return {
    found,created:0,statusChanged:0,createdClaims:[],changedClaims:[],
    complete:false,skipped:true,cached:true,reason,
    quota:{cloudReads:0,cloudWrites:0,cacheHits:documents.length}
  };
}


function loadQuotaState(){
  try{
    if(!fs.existsSync(QUOTA_STATE_PATH)) return 0;
    const parsed=JSON.parse(fs.readFileSync(QUOTA_STATE_PATH,'utf8'));
    const until=Number(parsed?.blockedUntil||0);
    return Number.isFinite(until)&&until>Date.now()?until:0;
  }catch{
    return 0;
  }
}

function saveQuotaState(){
  try{
    if(quotaBlockedUntil>Date.now()){
      fs.writeFileSync(QUOTA_STATE_PATH,JSON.stringify({
        blockedUntil:quotaBlockedUntil,
        blockedUntilIso:new Date(quotaBlockedUntil).toISOString(),
        reason:'Firestore RESOURCE_EXHAUSTED'
      },null,2),'utf8');
    }else if(fs.existsSync(QUOTA_STATE_PATH)){
      fs.unlinkSync(QUOTA_STATE_PATH);
    }
  }catch{}
}

function quotaResumeLabel(){
  return new Date(quotaBlockedUntil).toLocaleString('ko-KR',{
    timeZone:'Asia/Seoul',hour12:false
  });
}

function scheduleQuotaResume(){
  clearTimeout(quotaResumeTimer);
  if(quotaBlockedUntil<=Date.now()) return;
  const delay=Math.min(quotaBlockedUntil-Date.now()+3000,2147480000);
  quotaResumeTimer=setTimeout(()=>{
    if(Date.now()<quotaBlockedUntil){
      scheduleQuotaResume();
      return;
    }
    quotaBlockedUntil=0;
    saveQuotaState();
    console.log('[무료 한도 복구 예상 시각 도달] 자동 동기화를 다시 시작합니다.');
    run('startup').catch(error=>{
      console.error('한도 복구 후 재시작 실패:',error instanceof Error?error.message:String(error));
    });
  },Math.max(1000,delay));
}

function inQuotaCooldown(){
  if(quotaBlockedUntil&&Date.now()>=quotaBlockedUntil){
    quotaBlockedUntil=0;
    saveQuotaState();
  }
  return Date.now()<quotaBlockedUntil;
}

function markQuotaCooldown(error){
  if(!quotaExceeded(error)) return false;

  quotaBlockedUntil=Math.max(
    quotaBlockedUntil,
    nextFirestoreFreeResetMs(Date.now())
  );
  saveQuotaState();
  scheduleQuotaResume();

  console.error(
    `[Firestore 무료 한도 초과] 반복 재시도를 중단합니다. `+
    `${quotaResumeLabel()} 이후 자동 재시도합니다.`
  );

  return true;
}

function logQuotaSkip(label='수집'){
  if(Date.now()-quotaSkipLoggedAt<5*60*1000) return;
  quotaSkipLoggedAt=Date.now();
  console.log(
    `[무료 한도 보호 중] ${label} 건너뜀 · 재개 예정 ${quotaResumeLabel()}`
  );
}

quotaBlockedUntil=loadQuotaState();
if(quotaBlockedUntil){
  console.log(
    `[Firestore 무료 한도 보호 상태] ${quotaResumeLabel()} 이후 자동 재개 예정`
  );
  scheduleQuotaResume();
}

function stableObject(value){
  if(value===undefined) return undefined;
  if(value===null||typeof value!=='object') return value;
  if(Array.isArray(value)){
    return value.map(stableObject).filter(item=>item!==undefined);
  }
  if(
    value instanceof Date ||
    typeof value?.toDate==='function' ||
    value?.constructor?.name==='FieldValue'
  ){
    return value;
  }
  return Object.keys(value).sort().reduce((result,key)=>{
    const clean=stableObject(value[key]);
    if(clean!==undefined) result[key]=clean;
    return result;
  },{});
}

const SYSTEM_VOLATILE_FIELDS=new Set([
  'lastRun','lastSuccess','updatedAt','checkedAt','generatedAt',
  'generatedAtIso','startedAt','completedAt','lastSeen','lastSeenIso',
  'lastSeenEpoch','telegramCheckedAt','telegramLastSuccess'
]);

function meaningfulSystemObject(value){
  if(value===undefined) return undefined;
  if(value===null||typeof value!=='object') return value;
  if(Array.isArray(value)){
    return value.map(meaningfulSystemObject).filter(item=>item!==undefined);
  }
  if(
    value instanceof Date ||
    typeof value?.toDate==='function' ||
    value?.constructor?.name==='FieldValue'
  ){
    return '[timestamp]';
  }
  return Object.keys(value).sort().reduce((result,key)=>{
    if(SYSTEM_VOLATILE_FIELDS.has(key)) return result;
    const clean=meaningfulSystemObject(value[key]);
    if(clean!==undefined) result[key]=clean;
    return result;
  },{});
}

function stableJson(value){
  return JSON.stringify(stableObject(value));
}

function loadSystemWriteCache(){
  try{
    if(!fs.existsSync(SYSTEM_WRITE_CACHE_PATH)) return {};
    const parsed=JSON.parse(fs.readFileSync(SYSTEM_WRITE_CACHE_PATH,'utf8'));
    return parsed&&typeof parsed==='object'?parsed:{};
  }catch{
    return {};
  }
}

function saveSystemWriteCache(){
  try{
    const temporary=`${SYSTEM_WRITE_CACHE_PATH}.tmp`;
    fs.writeFileSync(temporary,JSON.stringify(systemWriteCache),{encoding:'utf8',flag:'w'});
    fs.renameSync(temporary,SYSTEM_WRITE_CACHE_PATH);
  }catch{}
}

const systemWriteCache=loadSystemWriteCache();

async function setOnlyWhenChanged(reference,data,options={merge:true,minRefreshMs:30*60*1000}){
  if(inQuotaCooldown()){
    return {skipped:true,reason:'quota-cooldown'};
  }

  const clean=stableObject(data);
  const topKeys=Object.keys(clean||{}).sort().join(',');
  const cacheKey=`${reference.path}|${topKeys}`;
  const hash=JSON.stringify(meaningfulSystemObject(clean));
  const previous=systemWriteCache[cacheKey]||{};
  const elapsed=Date.now()-Number(previous.lastWriteAt||0);

  if(previous.hash===hash&&elapsed<Math.max(60*1000,Number(options.minRefreshMs||0))){
    return {skipped:true,reason:'unchanged'};
  }

  try{
    await reference.set(clean,{merge:options.merge!==false});
    systemWriteCache[cacheKey]={hash,lastWriteAt:Date.now()};
    saveSystemWriteCache();
    return {skipped:false};
  }catch(error){
    markQuotaCooldown(error);
    throw error;
  }
}

function quotaLog(...results){
  const totals=results.reduce((sum,result)=>{
    const quota=result?.quota||{};
    sum.reads+=Number(quota.cloudReads||0);
    sum.writes+=Number(quota.cloudWrites||0);
    sum.cache+=Number(quota.cacheHits||0);
    return sum;
  },{reads:0,writes:0,cache:0});
  return `DB읽기 ${totals.reads} · DB쓰기 ${totals.writes} · 로컬캐시 ${totals.cache}`;
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
    // Windows may leave the lock file behind when the black console is closed.
    // Remove it only when the recorded PID is no longer alive, then retry once.
    try{
      const savedPid=Number(fs.readFileSync(lockPath,'utf8').trim());
      let alive=Number.isInteger(savedPid)&&savedPid>0;
      if(alive){
        try{process.kill(savedPid,0);}catch{alive=false;}
      }
      if(!alive){
        fs.unlinkSync(lockPath);
        const fd=fs.openSync(lockPath,'wx');
        fs.writeFileSync(fd,String(process.pid),'utf8');
        fs.closeSync(fd);
        agentLockReleased=false;
        const release=()=>{
          if(agentLockReleased)return;
          agentLockReleased=true;
          try{fs.unlinkSync(lockPath);}catch{}
        };
        process.on('exit',release);
        process.on('SIGINT',()=>{release();process.exit(0);});
        process.on('SIGTERM',()=>{release();process.exit(0);});
        return true;
      }
    }catch{}
    console.error(
      '이미 다른 PC 수집기가 실행 중입니다. START_AGENT.cmd가 이전 수집기를 자동 정리한 뒤 다시 실행합니다.'
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
let backgroundClaimsRunning=false;
let backgroundCurrentOrdersRunning=false;
const CLAIM_TYPES=['cancel','return','exchange','inquiry'];

function isManualCollectSource(source){
  return source==='immediate'||source==='reconcile';
}

async function updateCollectProgress(source,percent,step){
  if(!isManualCollectSource(source)) return;

  const progressPercent=Math.max(0,Math.min(100,Math.round(Number(percent)||0)));
  const payload={
    status:progressPercent>=100?'success':'running',
    action:source==='reconcile'?'reconcile':'collect',
    progressPercent,
    remainingPercent:Math.max(0,100-progressPercent),
    progressStep:String(step||''),
    progressUpdatedAt:admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:admin.firestore.FieldValue.serverTimestamp()
  };

  try{
    await commandRef.set(payload,{merge:true});
  }catch(error){
    if(markQuotaCooldown(error)) throw error;
    console.warn(
      '수집 진행률 저장 실패:',
      error instanceof Error?error.message:String(error)
    );
  }
}



const TELEGRAM_LEDGER_PATH=path.join(BACKEND_DIR,'.telegram-alert-ledger.json');
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

  let photoUrl='';
  if(telegramAlertType(order)==='new_order'){
    photoUrl=await resolveTelegramProductImage(order,marketName,{
      coupangConfig:marketName==='쿠팡'?coupang():null,
      smartstoreConfig:marketName==='스마트스토어'?smartstoreConfig():null,
      smartstoreResolver:resolveSmartstoreProductImage
    });
  }

  const result=await sendTelegram(
    telegramAlertTitle(order,marketName),
    telegramOrderBody(order),
    {
      attempts:2,
      alert:true,
      photoUrl
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

async function telegramApiRequest(token,method,payload,timeoutMs=15000){
  const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{
    method:'POST',
    signal:AbortSignal.timeout(timeoutMs),
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload)
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok||result.ok===false){
    throw new Error(result.description||`Telegram HTTP ${response.status}`);
  }
  return result;
}

function telegramPhotoFilename(contentType,url=''){
  const extensionByType={
    'image/jpeg':'jpg',
    'image/jpg':'jpg',
    'image/png':'png',
    'image/webp':'webp',
    'image/gif':'gif'
  };
  const normalized=String(contentType||'').split(';')[0].trim().toLowerCase();
  let extension=extensionByType[normalized]||'';
  if(!extension){
    try{
      const match=new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
      extension=match?.[1]?.toLowerCase()||'jpg';
    }catch{extension='jpg';}
  }
  return `product-thumbnail.${extension}`;
}

async function downloadTelegramPhoto(photoUrl){
  const parsed=new URL(photoUrl);
  const response=await fetch(photoUrl,{
    redirect:'follow',
    signal:AbortSignal.timeout(20000),
    headers:{
      Accept:'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language':'ko-KR,ko;q=0.9,en;q=0.8',
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
      Referer:`${parsed.protocol}//${parsed.host}/`
    }
  });
  if(!response.ok) throw new Error(`상품 이미지 다운로드 HTTP ${response.status}`);
  const contentType=String(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  if(!contentType.startsWith('image/')) throw new Error(`상품 이미지 형식 오류: ${contentType||'unknown'}`);
  const bytes=await response.arrayBuffer();
  if(!bytes.byteLength) throw new Error('상품 이미지 파일이 비어 있습니다.');
  if(bytes.byteLength>9.5*1024*1024) throw new Error(`상품 이미지가 너무 큽니다: ${Math.ceil(bytes.byteLength/1024/1024)}MB`);
  return {
    blob:new Blob([bytes],{type:contentType}),
    filename:telegramPhotoFilename(contentType,response.url||photoUrl),
    size:bytes.byteLength,
    contentType
  };
}

async function telegramPhotoUpload(token,payload,photo,timeoutMs=30000){
  const form=new FormData();
  for(const [key,value] of Object.entries(payload)){
    if(value==null) continue;
    form.append(key,String(value));
  }
  form.append('photo',photo.blob,photo.filename);
  const response=await fetch(`https://api.telegram.org/bot${token}/sendPhoto`,{
    method:'POST',
    signal:AbortSignal.timeout(timeoutMs),
    body:form
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok||result.ok===false){
    throw new Error(result.description||`Telegram HTTP ${response.status}`);
  }
  return result;
}

async function sendTelegram(title,body,options={}){
  if(inQuotaCooldown()&&!options.test){
    return {enabled:telegramConfigured(),sent:0,failed:0,skipped:1,reason:'quota-cooldown'};
  }
  if(!telegramConfigured()){
    const error='TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID가 없습니다.';
    await db.collection('system').doc('agent').set({
      telegramConfigured:false,telegramLastError:error,telegramCheckedAt:new Date().toISOString()
    },{merge:true}).catch(()=>{});
    return {enabled:false,sent:0,failed:1,error};
  }

  const token=String(process.env.TELEGRAM_BOT_TOKEN||'').trim();
  const chatId=String(process.env.TELEGRAM_CHAT_ID||'').trim();
  const attempts=Math.max(1,Number(options.attempts||3));
  const text=`${title}\n\n${body}`;
  const photoUrl=String(options.photoUrl||'').trim();
  let lastError='';
  let photoFailed=false;

  if(photoUrl){
    const photoPayload={
      chat_id:chatId,
      caption:text.slice(0,1024),
      show_caption_above_media:false
    };
    try{
      // 쇼핑몰 CDN은 텔레그램 서버의 원격 다운로드를 막는 경우가 있어
      // PC 수집기가 이미지를 내려받은 뒤 실제 파일로 업로드합니다.
      const photo=await downloadTelegramPhoto(photoUrl);
      await telegramPhotoUpload(token,photoPayload,photo,30000);
      console.log(`텔레그램 상품 썸네일 전송 성공 · ${Math.ceil(photo.size/1024)}KB`);
      await db.collection('system').doc('agent').set({
        telegramConfigured:true,telegramLastSuccess:new Date().toISOString(),
        telegramLastError:'',telegramCheckedAt:new Date().toISOString()
      },{merge:true}).catch(()=>{});
      return {enabled:true,sent:1,failed:0,withPhoto:true,uploaded:true};
    }catch(uploadError){
      lastError=uploadError instanceof Error?uploadError.message:String(uploadError);
      console.warn('텔레그램 썸네일 파일 업로드 실패 · URL 전송 재시도:',lastError);
      try{
        await telegramApiRequest(token,'sendPhoto',{
          ...photoPayload,
          photo:photoUrl
        },20000);
        console.log('텔레그램 상품 썸네일 URL 전송 성공');
        await db.collection('system').doc('agent').set({
          telegramConfigured:true,telegramLastSuccess:new Date().toISOString(),
          telegramLastError:'',telegramCheckedAt:new Date().toISOString()
        },{merge:true}).catch(()=>{});
        return {enabled:true,sent:1,failed:0,withPhoto:true,uploaded:false};
      }catch(error){
        photoFailed=true;
        lastError=error instanceof Error?error.message:String(error);
        console.warn('텔레그램 썸네일 전송 실패 · 텍스트로 재전송:',lastError);
      }
    }
  }else if(options.alert){
    console.log('텔레그램 상품 썸네일 주소 없음 · 텍스트 알림 전송');
  }

  for(let attempt=1;attempt<=attempts;attempt+=1){
    try{
      await telegramApiRequest(token,'sendMessage',{
        chat_id:chatId,text,disable_web_page_preview:true
      });
      await db.collection('system').doc('agent').set({
        telegramConfigured:true,telegramLastSuccess:new Date().toISOString(),
        telegramLastError:'',telegramCheckedAt:new Date().toISOString()
      },{merge:true}).catch(()=>{});
      return {enabled:true,sent:1,failed:0,withPhoto:false,photoFailed};
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
    telegramConfigured:true,telegramLastError:lastError,telegramCheckedAt:new Date().toISOString()
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
      maxPages:reconcile?15:2,
      // 무료 한도에서는 Firestore를 다시 읽지 않고 로컬 캐시로만
      // 현재 ACCEPT/INSTRUCT 목록을 대조해 상태 이동을 10분 안에 반영합니다.
      reconcile:true
    }),
    reconcile?180000:45000
  );
  return {...result,push:await sendPush(result.createdOrders||[],'쿠팡',source)};
}


async function quickCurrentCoupangSync(source='immediate'){
  const days=Math.max(3,Math.min(14,Number(process.env.MANUAL_FAST_LOOKBACK_DAYS||7)));
  const maxPages=Math.max(2,Math.min(8,Number(process.env.MANUAL_FAST_MAX_PAGES||4)));

  const result=await withTimeout(
    '쿠팡 현재 미처리 주문조회',
    pollCoupangStatuses(db,coupang(),{
      statuses:FAST,
      days,
      maxPages,
      // 수동 수집은 현재 신규/발송대기 목록만 정확히 대조합니다.
      // 배송완료 등 과거 상태 전체를 다시 훑지 않아 훨씬 빠릅니다.
      reconcile:true
    }),
    90000
  );

  return {
    ...result,
    quickCurrent:true,
    push:await sendPush(result.createdOrders||[],'쿠팡',source)
  };
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
    if(inQuotaCooldown()) throw new Error('Firestore quota cooldown');
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

    // 수동 수집은 버튼 완료 후 백그라운드에서 진행하므로 짧은 간격만 둡니다.
    // 정기 수집은 기존과 같이 API 제한을 피하도록 여유를 둡니다.
    await new Promise(r=>setTimeout(
      r,
      source==='interval'?3500:900
    ));
  }

  return results;
}


function refreshClaimsInBackground(source='immediate'){
  if(backgroundClaimsRunning||inQuotaCooldown()) return;
  backgroundClaimsRunning=true;

  setTimeout(async()=>{
    try{
      console.log('취소·반품·교환·문의 백그라운드 확인 시작');
      const results=await withTimeout(
        '쿠팡 CS 백그라운드 전체조회',
        syncAllClaimTypes(source),
        600000
      );
      console.log('취소·반품·교환·문의 백그라운드 확인 완료');

      return results;
    }catch(error){
      if(!markQuotaCooldown(error)){
        console.error(
          '백그라운드 CS 확인 실패:',
          error instanceof Error?error.message:String(error)
        );
      }
    }finally{
      backgroundClaimsRunning=false;
    }
  },300);
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

    if(source!=='immediate') await new Promise(r=>setTimeout(r,1200));

    const statusResult=await syncElevenstStatuses(
      db,
      config,
      {repair:['startup','immediate','reconcile'].includes(source)}
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
      `상태푸시 ${statusPush.sent} · ${quotaLog(result)}`
    );

    return result;
  }catch(error){
    const message=error instanceof Error
      ? error.message
      : String(error);

    if(markQuotaCooldown(error)) return null;

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

    if(['startup','reconcile'].includes(source)){
      const retired=await retireLegacySmartstoreInquiryCache(db);
      if(Number(retired.deactivated||0)>0){
        console.log(`스마트스토어 이전 문의 캐시 정리: ${retired.deactivated}건 · 다음 정상 조회 시 미답변 건 자동 복구`);
      }
    }

    let inquiryResult;
    if(source==='immediate'){
      inquiryResult=await cachedSmartstoreInquiryResult('빠른수집 · 문의는 백그라운드/정기 확인');
    }else if(smartstoreInquiryDue()){
      smartstoreInquiryState.lastAttemptAt=Date.now();
      saveSmartstoreInquiryState();
      inquiryResult=await withTimeout(
        '스마트스토어 문의조회',
        syncSmartstoreInquiries(db,smartstoreConfig(),{reconcile}),
        300000
      ).catch(async error=>{
        if(markQuotaCooldown(error)) throw error;
        const message=error instanceof Error?error.message:String(error);
        smartstoreInquiryState.lastError=message;
        saveSmartstoreInquiryState();
        console.error('스마트스토어 문의조회 실패:',message);
        return cachedSmartstoreInquiryResult('문의 API 오류 보호');
      });

      if(inquiryResult?.rateLimited){
        smartstoreInquiryState.blockedUntil=Date.now()+SMARTSTORE_INQUIRY_429_COOLDOWN_MS;
        smartstoreInquiryState.lastError=(inquiryResult.errors||[]).join(' · ')||'HTTP 429';
        const cachedResult=await cachedSmartstoreInquiryResult('429 보호');
        inquiryResult={
          ...inquiryResult,
          found:Math.max(Number(inquiryResult.found||0),Number(cachedResult.found||0)),
          cached:true,
          skipped:true,
          reason:'429 보호'
        };
        console.warn(
          `스마트스토어 문의 API 제한 보호 · ${smartstoreInquiryWaitLabel()}분 뒤 재조회`
        );
      }else if(inquiryResult?.complete!==false){
        smartstoreInquiryState.lastSuccessAt=Date.now();
        smartstoreInquiryState.blockedUntil=0;
        smartstoreInquiryState.lastFound=Number(inquiryResult?.found||0);
        smartstoreInquiryState.lastError='';
      }
      saveSmartstoreInquiryState();
    }else{
      const reason=Number(smartstoreInquiryState.blockedUntil||0)>Date.now()
        ?`429 보호 ${smartstoreInquiryWaitLabel()}분`
        :`조회간격 보호 ${smartstoreInquiryWaitLabel()}분`;
      inquiryResult=await cachedSmartstoreInquiryResult(reason);
    }

    const push=await sendMarketplacePush(result.createdOrders||[],'스마트스토어',source);
    let inquirySent=0;
    for(const inquiry of inquiryResult.createdClaims||[]){
      const sentResult=await sendOrderTelegramAlert(inquiry,'스마트스토어',source);
      inquirySent+=sentResult.sent||0;
    }

    await setOnlyWhenChanged(db.collection('system').doc('integrations'),{
      smartstore:{
        name:'스마트스토어',connected:true,lastRun:new Date().toISOString(),
        message:`정상 조회 · 주문문서 ${result.found} · 상태변경 ${result.statusChanged} · 미답변문의 ${inquiryResult.found||0}${inquiryResult.skipped?'(캐시)':''}`,
        lastResult:{
          found:result.found,created:result.created,existing:result.existing,statusChanged:result.statusChanged,
          inquiries:{found:inquiryResult.found||0,created:inquiryResult.created||0,statusChanged:inquiryResult.statusChanged||0,complete:inquiryResult.complete!==false},
          push,inquirySent
        }
      }
    },{merge:true});

    console.log(
      `스마트스토어 동기화 완료: 주문문서 ${result.found}, `+
      `상태변경 ${result.statusChanged}, 미답변문의 ${inquiryResult.found||0}`+
      `${inquiryResult.skipped?'(캐시)':''}, `+
      `조회구간 ${result.rangeCount||1} · ${quotaLog(result,inquiryResult)}`
    );

    return {...result,inquiries:inquiryResult};
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    if(markQuotaCooldown(error)) return null;
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

    const auth=source==='immediate'
      ?{identity:'빠른수집'}
      :await withTimeout(
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
      `상태푸시 ${statusPush.sent} · ${quotaLog(result)}`
    );

    return result;
  }catch(error){
    if(markQuotaCooldown(error)) return null;
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
    if(markQuotaCooldown(error)) return;
    console.error(
      'ESM 연결상태 확인 실패:',
      error instanceof Error?error.message:String(error)
    );
  }
}



let legacyMigrationDone=false;

async function ensureLegacyMigration(){
  if(legacyMigrationDone) return null;
  legacyMigrationDone=true;

  if(String(process.env.RUN_LEGACY_MIGRATION||'').trim()!=='1'){
    console.log('기존 데이터 자동정리 생략 · 필요 시 RUN_LEGACY_MIGRATION=1');
    return {scanned:0,patched:0,legacyClaimsDeactivated:0,skipped:true};
  }

  const result=await migrateLegacyDocuments(db);
  console.log(
    `기존 데이터 정리 완료: 검사 ${result.scanned}, 보정 ${result.patched}, `+
    `혼합상태 제외 ${result.legacyClaimsDeactivated}`
  );
  return result;
}


async function writeDiagnostics(reason='sync'){
  if(String(process.env.ENABLE_DIAGNOSTICS||'').trim()!=='1') return null;
  if(inQuotaCooldown()) return null;
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
      version:'FINAL-7.7.4',reason,generatedAt:admin.firestore.FieldValue.serverTimestamp(),
      generatedAtIso:new Date().toISOString(),documentCount:snapshot.size,counts
    },{merge:true});
  }catch(error){
    if(markQuotaCooldown(error)) return null;
    console.error('진단정보 저장 실패:',error instanceof Error?error.message:String(error));
  }
  return null;
}

async function writeAgentHeartbeat(reason='interval'){
  if(inQuotaCooldown()){
    logQuotaSkip('생존신호');
    return false;
  }
  const now=new Date();
  const payload={
    online:true,
    channel:'telegram',
    telegramConfigured:telegramConfigured(),
    version:'FINAL-7.7.4',
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

    if(markQuotaCooldown(error)) return false;

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
      ].join('\n'),
      {test:true}
    );

    const success=(result.sent||0)>0;

    if(inQuotaCooldown()){
      console.log(success?'텔레그램 테스트 메시지 전송 성공':'텔레그램 테스트 메시지 전송 실패');
      return;
    }

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
  if(inQuotaCooldown()){
    logQuotaSkip('빠른수집');
    return;
  }
  if(fastRunning||running) return;
  fastRunning=true;
  fastLoopCount+=1;

  try{
    const fast=await fastSync();

    await saveIntegration(fast,null);

    await new Promise(r=>setTimeout(r,1200));
    await syncSmartstoreSafe('interval');
    if(inQuotaCooldown()) throw new Error('Firestore quota cooldown');

    await new Promise(r=>setTimeout(r,1200));
    await syncElevenstSafe('interval');
    if(inQuotaCooldown()) throw new Error('Firestore quota cooldown');

    await new Promise(r=>setTimeout(r,800));
    await refreshEsmStatus();
    if(inQuotaCooldown()) throw new Error('Firestore quota cooldown');

    await new Promise(r=>setTimeout(r,800));
    await syncLotteonSafe('interval');
    if(inQuotaCooldown()) throw new Error('Firestore quota cooldown');

    console.log(
      `빠른수집 완료: 신규 ${fast.counts?.ACCEPT||0}, `+
      `발송대기 ${fast.counts?.INSTRUCT||0} · `+
      `${fastPollMinutes}분 주기`
    );

    if(fastLoopCount%fullSyncEvery===0){
      console.log('다음 정규수집에서 전체 상태 순환 확인 예정');
    }
  }catch(error){
    if(markQuotaCooldown(error)) return;
    console.error(
      '빠른수집 실패:',
      error instanceof Error?error.message:String(error)
    );
  }finally{
    fastRunning=false;
  }
}




async function syncCoupangCurrentSafe(source='immediate'){
  try{
    const fast=await quickCurrentCoupangSync(source);
    const slow=null;
    await saveIntegration(fast,slow);
    console.log(
      `쿠팡 빠른 동기화 완료: 신규 ${fast.counts?.ACCEPT||0}, `+
      `발송대기 ${fast.counts?.INSTRUCT||0} · ${quotaLog(fast)}`
    );
    return {fast,slow};
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    if(markQuotaCooldown(error)) throw error;
    console.error('쿠팡 빠른 동기화 실패:',message);
    return {error:message};
  }
}


function refreshCurrentOrdersInBackground(){
  if(backgroundCurrentOrdersRunning||inQuotaCooldown()) return;
  backgroundCurrentOrdersRunning=true;
  setTimeout(async()=>{
    try{
      const days=Math.max(14,Math.min(31,Number(process.env.MANUAL_DEEP_LOOKBACK_DAYS||31)));
      const maxPages=Math.max(5,Math.min(15,Number(process.env.MANUAL_DEEP_MAX_PAGES||10)));
      const result=await withTimeout('쿠팡 백그라운드 현재상태 보정',pollCoupangStatuses(db,coupang(),{
        statuses:FAST,days,maxPages,reconcile:true
      }),240000);
      await saveIntegration(result,null);
      console.log(`쿠팡 백그라운드 상태보정 완료: 신규 ${result.counts?.ACCEPT||0}, 발송대기 ${result.counts?.INSTRUCT||0}`);
    }catch(error){
      if(!markQuotaCooldown(error)) console.error('백그라운드 주문 상태보정 실패:',error?.message||error);
    }finally{
      backgroundCurrentOrdersRunning=false;
    }
  },1500);
}

async function runImmediateMarketCollection(summary){
  const jobs=[
    {key:'coupang',label:'쿠팡',run:()=>syncCoupangCurrentSafe('immediate')},
    {key:'smartstore',label:'스마트스토어',run:()=>syncSmartstoreSafe('immediate')},
    {key:'elevenst',label:'11번가',run:()=>syncElevenstSafe('immediate')},
    {key:'lotteon',label:'롯데온',run:()=>syncLotteonSafe('immediate')}
  ];

  let completed=0;
  let progressQueue=Promise.resolve();

  await Promise.all(jobs.map(async job=>{
    try{
      summary[job.key]=await job.run();
    }catch(error){
      if(markQuotaCooldown(error)) throw error;
      const message=error instanceof Error?error.message:String(error);
      summary[job.key]={error:message};
      console.error(`${job.label} 빠른수집 실패:`,message);
    }finally{
      completed+=1;
      const percent=Math.min(88,8+completed*20);
      progressQueue=progressQueue.then(()=>
        updateCollectProgress(
          'immediate',
          percent,
          `${job.label} 확인 완료 · ${completed}/4`
        )
      );
      await progressQueue;
    }
  }));

  if(inQuotaCooldown()) throw new Error('Firestore quota cooldown');
  summary.claims={background:true};
  await updateCollectProgress('immediate',95,'현재 주문 반영 완료');
  refreshCurrentOrdersInBackground();
  refreshClaimsInBackground('immediate');
}

async function run(source){
  if(inQuotaCooldown()){
    logQuotaSkip(source==='startup'?'시작 수집':'정규 수집');
    return;
  }
  if(running) return;

  running=true;

  if(['startup','reconcile'].includes(source)){
    try{
      await ensureLegacyMigration();
    }catch(error){
      if(markQuotaCooldown(error)){
        running=false;
        return;
      }
      console.error('기존 데이터 정리 실패:',error instanceof Error?error.message:String(error));
    }
  }

  const reconcile=source==='reconcile';
  const label=reconcile?'이번달 정밀 동기화':source;

  console.log(`[${new Date().toISOString()}] ${label} 시작`);

  if(source==='immediate'||reconcile){
    try{
      await commandRef.set({
        status:'running',
        action:reconcile?'reconcile':'collect',
        progressPercent:3,
        remainingPercent:97,
        progressStep:'수집 준비 완료',
        startedAt:admin.firestore.FieldValue.serverTimestamp(),
        progressUpdatedAt:admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:admin.firestore.FieldValue.serverTimestamp()
      },{merge:true});
    }catch(error){
      if(markQuotaCooldown(error)){
        running=false;
        return;
      }
      running=false;
      throw error;
    }
  }

  const summary={};

  try{
    if(source==='immediate'){
      await runImmediateMarketCollection(summary);
      await commandRef.set({
        status:'success',
        action:'collect',
        progressPercent:100,
        remainingPercent:0,
        progressStep:'현재 주문 반영 완료 · 요청 상태는 백그라운드 확인 중',
        result:summary,
        completedAt:admin.firestore.FieldValue.serverTimestamp(),
        progressUpdatedAt:admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:admin.firestore.FieldValue.serverTimestamp()
      },{merge:true});
      console.log('immediate 완료 · 현재 주문 우선 반영');
      return;
    }
    try{
      const deepReconcile=source==='reconcile';
      const quickCurrent=['startup','immediate'].includes(source);

      const fast=deepReconcile
        ?await fullCoupangStatusSync('reconcile')
        :quickCurrent
          ?await quickCurrentCoupangSync(source)
          :await fastSync(source);

      let slow=null;

      if(!deepReconcile&&!quickCurrent){
        try{
          slow=await withTimeout(
            '쿠팡 상태 순환조회',
            slowSync(),
            70000
          );
        }catch(error){
          if(markQuotaCooldown(error)) throw error;
          console.error('쿠팡 상태 순환조회 실패:',error.message);
        }
      }

      summary.coupang={fast,slow};
      await saveIntegration(fast,slow);

      console.log(
        `쿠팡 동기화 완료: 신규 ${fast.counts?.ACCEPT||0}, `+
        `발송대기 ${fast.counts?.INSTRUCT||0}`+
        (slow?` · ${slow.slowStatus} ${slow.counts?.[slow.slowStatus]||0}`:'')+
        ` · ${quotaLog(fast,slow)}`
      );
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      summary.coupang={error:message};
      if(markQuotaCooldown(error)) throw error;
      console.error('쿠팡 실패:',message);
    }

    await updateCollectProgress(source,22,'쿠팡 주문 확인 완료');

    const smartstoreResult=await syncSmartstoreSafe(source);
    summary.smartstore=smartstoreResult;
    if(inQuotaCooldown()) throw new Error('Firestore quota cooldown');
    await updateCollectProgress(source,42,'스마트스토어 확인 완료');

    await new Promise(resolve=>setTimeout(resolve,800));
    const elevenstResult=await syncElevenstSafe(source);
    summary.elevenst=elevenstResult;
    if(inQuotaCooldown()) throw new Error('Firestore quota cooldown');
    await updateCollectProgress(source,57,'11번가 확인 완료');

    await new Promise(resolve=>setTimeout(resolve,800));
    const lotteonResult=await syncLotteonSafe(source);
    summary.lotteon=lotteonResult;
    if(inQuotaCooldown()) throw new Error('Firestore quota cooldown');
    await updateCollectProgress(source,70,'롯데온 확인 완료');

    await refreshEsmStatus();
    if(inQuotaCooldown()) throw new Error('Firestore quota cooldown');

    if(source==='immediate'){
      // 버튼은 현재 주문 수집이 끝나는 즉시 완료 처리합니다.
      // 오래 걸리는 취소/반품/교환/문의 조회는 백그라운드에서 이어집니다.
      summary.claims={background:true};
      await updateCollectProgress(source,95,'현재 주문 반영 완료');
      refreshClaimsInBackground(source);
    }else{
      await updateCollectProgress(source,78,'취소·반품·교환·문의 확인 중');
      try{
        summary.claims=
          reconcile||source==='startup'
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
        if(markQuotaCooldown(error)) throw error;
        console.error('쿠팡 CS 실패:',error.message);
        summary.claims=[];
      }
      await updateCollectProgress(source,95,'최종 결과 정리 중');
    }

    if(source==='immediate'||reconcile){
      await commandRef.set({
        status:'success',
        action:reconcile?'reconcile':'collect',
        progressPercent:100,
        remainingPercent:0,
        progressStep:source==='immediate'
          ?'주문 수집 완료 · 요청 상태는 백그라운드 확인 중'
          :'수집 완료',
        result:summary,
        completedAt:admin.firestore.FieldValue.serverTimestamp(),
        progressUpdatedAt:admin.firestore.FieldValue.serverTimestamp(),
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

    if(markQuotaCooldown(error)||inQuotaCooldown()){
      console.error(`${label} 중단: Firestore 무료 한도 보호`);
      return;
    }

    console.error(`${label} 전체 오류:`,message);

    if(source==='immediate'||reconcile){
      await commandRef.set({
        status:'error',
        progressStep:'오류 발생',
        error:message,
        completedAt:admin.firestore.FieldValue.serverTimestamp(),
        progressUpdatedAt:admin.firestore.FieldValue.serverTimestamp(),
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
},error=>{
  if(markQuotaCooldown(error)) return;
  console.error('명령 감시 오류:',error.message);
});

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
  `스마트스토어 문의 60분(429 보호) · 텔레그램 테스트 즉시 사용 가능 · `+
  `생존신호 5분 · 무료한도 최적화`
);

run('startup').catch(error=>{
  console.error(
    '시작 수집 실패:',
    error instanceof Error?error.message:String(error)
  );
});


