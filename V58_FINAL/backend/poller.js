import fs from 'node:fs';
import admin from 'firebase-admin';
import { pollCoupang } from './coupang.js';

function firebaseCredential() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON Secret이 없습니다.');
  }
  return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
}

function coupangConfig() {
  const config = {
    accessKey:process.env.COUPANG_ACCESS_KEY,
    secretKey:process.env.COUPANG_SECRET_KEY,
    vendorId:process.env.COUPANG_VENDOR_ID
  };
  if (!config.accessKey || !config.secretKey || !config.vendorId) {
    throw new Error('쿠팡 GitHub Secrets 3개를 확인하세요.');
  }
  return config;
}

admin.initializeApp({credential:admin.credential.cert(firebaseCredential())});
const db=admin.firestore();
const startedAt=new Date().toISOString();

try{
  const result=await pollCoupang(db,coupangConfig(),30);
  await db.collection('system').doc('integrations').set({
    coupang:{
      name:'쿠팡',
      connected:true,
      lastRun:new Date().toISOString(),
      message:`정상 조회 · 발견 ${result.found}건 · 신규 ${result.created}건 · 중복 ${result.existing}건`,
      lastResult:result
    }
  },{merge:true});
  await db.collection('system').doc('poller').set({
    lastRun:new Date().toISOString(),
    intervalMinutes:10,
    success:true,
    mode:'coupang-live',
    result
  },{merge:true});
  console.log(`쿠팡 조회 성공: 발견 ${result.found}, 신규 ${result.created}, 중복 ${result.existing}`);
}catch(error){
  await db.collection('system').doc('integrations').set({
    coupang:{
      name:'쿠팡',
      connected:false,
      lastRun:new Date().toISOString(),
      message:error instanceof Error?error.message:String(error)
    }
  },{merge:true});
  console.error(error);
  process.exitCode=1;
}
