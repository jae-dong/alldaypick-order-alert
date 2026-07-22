import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const BACKEND_DIR=path.dirname(fileURLToPath(import.meta.url));
export const DIRECT_AUDIT_PATH=path.join(BACKEND_DIR,'market-direct-audit.json');

function defaultAudit(){
  return {
    schemaVersion:1,
    appVersion:'FINAL v7.7.17',
    generatedAt:'',
    basis:'각 쇼핑몰 공식 API 직접조회',
    excludedMarkets:{
      gmarket:'API 승인 전 · 집계 제외',
      auction:'API 승인 전 · 집계 제외'
    },
    markets:{}
  };
}

function readAudit(){
  try{
    if(!fs.existsSync(DIRECT_AUDIT_PATH)) return defaultAudit();
    const parsed=JSON.parse(fs.readFileSync(DIRECT_AUDIT_PATH,'utf8'));
    return {...defaultAudit(),...(parsed||{}),markets:parsed?.markets||{}};
  }catch{
    return defaultAudit();
  }
}

function clean(value,depth=0){
  if(depth>8||value==null) return value==null?null:String(value);
  if(Array.isArray(value)) return value.slice(0,200).map(item=>clean(item,depth+1));
  if(typeof value==='object'){
    return Object.entries(value).reduce((result,[key,item])=>{
      if(/token|secret|access.?key|api.?key|client.?secret|phone|address|buyer|name/i.test(key)) return result;
      result[key]=clean(item,depth+1);
      return result;
    },{});
  }
  if(['string','number','boolean'].includes(typeof value)) return value;
  return String(value);
}

export function recordDirectAudit(market,section,payload={}){
  try{
    const audit=readAudit();
    const marketKey=String(market||'unknown');
    const previous=audit.markets[marketKey]||{};
    audit.markets[marketKey]={
      ...previous,
      [String(section||'latest')]:clean(payload),
      lastVerifiedAt:new Date().toISOString()
    };
    audit.generatedAt=new Date().toISOString();
    const temporary=`${DIRECT_AUDIT_PATH}.tmp`;
    fs.writeFileSync(temporary,JSON.stringify(audit,null,2),'utf8');
    fs.renameSync(temporary,DIRECT_AUDIT_PATH);
  }catch(error){
    console.warn('마켓 직접검증 파일 저장 실패:',error?.message||error);
  }
}
