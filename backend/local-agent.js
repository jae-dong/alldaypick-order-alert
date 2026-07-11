import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';
import dotenv from 'dotenv';
import { pollCoupang } from './coupang.js';

dotenv.config({path:path.resolve('.env.local')});

function loadServiceAccount(){
  if(process.env.FIREBASE_SERVICE_ACCOUNT_FILE){
    return JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_FILE,'utf8'));
  }
  if(process.env.FIREBASE_SERVICE_ACCOUNT_JSON){
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  throw new Error('FIREBASE_SERVICE_ACCOUNT_FILE 또는 FIREBASE_SERVICE_ACCOUNT_JSON이 필요합니다.');
}

function config(){
  const value={
    accessKey:process.env.COUPANG_ACCESS_KEY,
    secretKey:process.env.COUPANG_SECRET_KEY,
    vendorId:process.env.COUPANG_VENDOR_ID
  };
  if(!value.accessKey||!value.secretKey||!value.vendorId){
    throw new Error('.env.local의 쿠팡 키 3개를 확인하세요.');
  }
  return value;
}

admin.initializeApp({credential:admin.credential.cert(loadServiceAccount())});
const db=admin.firestore();
const commandRef=db.collection('system').doc('commands').collection('requests').doc('coupang');
const intervalMinutes=Math.max(1,Number(process.env.POLL_INTERVAL_MINUTES||10));
let running=false;
let lastRequestId='';

async function runCollect(source){
  if(running) return;
  running=true;
  const startedAt=new Date().toISOString();
  console.log(`[${startedAt}] ${source} 쿠팡 수집 시작`);

  if(source==='immediate'){
    await commandRef.set({
      status:'running',
      startedAt:admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:admin.firestore.FieldValue.serverTimestamp()
    },{merge:true});
  }

  try{
    const result=await pollCoupang(db,config(),30);
    await db.collection('system').doc('integrations').set({
      coupang:{
        name:'쿠팡',
        connected:true,
        lastRun:new Date().toISOString(),
        message:`정상 조회 · 발견 ${result.found}건 · 신규 ${result.created}건 · 중복 ${result.existing}건`,
        lastResult:result
      }
    },{merge:true});

    if(source==='immediate'){
      await commandRef.set({
        status:'success',
        result,
        completedAt:admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:admin.firestore.FieldValue.serverTimestamp()
      },{merge:true});
    }
    console.log(`수집 완료: 발견 ${result.found}, 신규 ${result.created}, 중복 ${result.existing}`);
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

commandRef.onSnapshot(snapshot=>{
  if(!snapshot.exists) return;
  const data=snapshot.data()||{};
  if(data.status!=='requested'||!data.requestId||data.requestId===lastRequestId) return;
  lastRequestId=data.requestId;
  runCollect('immediate');
},error=>console.error('즉시수집 감시 오류:',error.message));

await runCollect('startup');
setInterval(()=>runCollect('interval'),intervalMinutes*60*1000);
console.log(`로컬 수집기 실행 중 · ${intervalMinutes}분 자동수집 · 웹 즉시수집 대기`);
