import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const BACKEND_DIR=path.dirname(fileURLToPath(import.meta.url));
// 이전 버전에서 "이미지 없음"으로 저장된 음수 캐시를 재사용하지 않습니다.
const CACHE_PATH=path.join(BACKEND_DIR,'.telegram-product-image-cache-v3.json');
const POSITIVE_TTL_MS=30*24*60*60*1000;
const NEGATIVE_TTL_MS=30*60*1000;
let cache=null;

function loadCache(){
  if(cache) return cache;
  try{
    const parsed=JSON.parse(fs.readFileSync(CACHE_PATH,'utf8'));
    cache=parsed&&typeof parsed==='object'?parsed:{};
  }catch{
    cache={};
  }
  return cache;
}

function saveCache(){
  try{
    const temporary=`${CACHE_PATH}.tmp`;
    fs.writeFileSync(temporary,JSON.stringify(loadCache(),null,2),'utf8');
    fs.renameSync(temporary,CACHE_PATH);
  }catch{}
}

export function normalizeImageUrl(value){
  let url=String(value||'').trim().replaceAll('&amp;','&');
  if(!url) return '';
  if(url.startsWith('//')) url=`https:${url}`;
  if(url.startsWith('/image/')) url=`https://image.coupangcdn.com${url}`;
  if(/^image\//i.test(url)) url=`https://image.coupangcdn.com/${url}`;
  if(!/^https?:\/\//i.test(url)) return '';
  try{
    const parsed=new URL(url);
    if(!['http:','https:'].includes(parsed.protocol)) return '';
    return parsed.toString();
  }catch{
    return '';
  }
}

function imageFromObject(value,depth=0,parentKey=''){
  if(depth>9||value==null) return '';
  if(typeof value==='string'){
    const normalized=normalizeImageUrl(value);
    if(!normalized) return '';
    // 상세페이지 URL을 이미지로 오인하지 않도록 이미지 문맥 또는 이미지 확장자를 요구합니다.
    if(/image|thumb|photo|picture|vendorpath|cdnpath|representative/i.test(parentKey)) return normalized;
    if(/\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i.test(normalized)) return normalized;
    if(/coupangcdn|pstatic|naver\.net|11st|lotte/i.test(new URL(normalized).hostname)) return normalized;
    return '';
  }
  if(Array.isArray(value)){
    for(const item of value){
      const found=imageFromObject(item,depth+1,parentKey);
      if(found) return found;
    }
    return '';
  }
  if(typeof value!=='object') return '';

  if(value.url!=null&&/image|thumb|photo|picture|representative/i.test(parentKey)){
    const found=imageFromObject(value.url,depth+1,parentKey);
    if(found) return found;
  }

  const preferred=[
    'representativeImage','representativeImageUrl','imageUrl','thumbnailUrl',
    'productImageUrl','mainImageUrl','prdImgUrl','prdImg','thumbUrl',
    'thumbnail','images','image','vendorPath','cdnPath'
  ];
  for(const key of preferred){
    if(value[key]!=null){
      const found=imageFromObject(value[key],depth+1,key);
      if(found) return found;
    }
  }
  for(const [key,item] of Object.entries(value)){
    if(!/image|thumb|photo|picture|vendorpath|cdnpath|representative/i.test(key)) continue;
    const found=imageFromObject(item,depth+1,key);
    if(found) return found;
  }
  // 상품 API는 originProduct > images처럼 한 단계 바깥 래퍼를 사용하므로
  // 모든 객체를 제한 깊이 안에서 탐색하되 문자열은 이미지 문맥일 때만 채택합니다.
  for(const [key,item] of Object.entries(value)){
    if(preferred.includes(key)||/image|thumb|photo|picture|vendorpath|cdnpath|representative/i.test(key)) continue;
    if(item==null||typeof item!=='object') continue;
    const found=imageFromObject(item,depth+1,key);
    if(found) return found;
  }
  return '';
}

export function directOrderImage(order={}){
  return imageFromObject({
    representativeImage:order.representativeImage,
    imageUrl:order.imageUrl,
    thumbnailUrl:order.thumbnailUrl,
    productImageUrl:order.productImageUrl,
    representativeImageUrl:order.representativeImageUrl,
    mainImageUrl:order.mainImageUrl,
    prdImgUrl:order.prdImgUrl,
    prdImg:order.prdImg,
    images:order.images
  });
}

function signedDate(){
  return new Date().toISOString().split('.')[0].replaceAll(':','').replaceAll('-','').slice(2)+'Z';
}
function coupangAuthorization(config,method,pathName,query=''){
  const datetime=signedDate();
  const signature=crypto.createHmac('sha256',config.secretKey)
    .update(`${datetime}${method}${pathName}${query}`).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${config.accessKey}, signed-date=${datetime}, signature=${signature}`;
}

async function coupangGet(config,pathName){
  const response=await fetch(`https://api-gateway.coupang.com${pathName}`,{
    method:'GET',
    signal:AbortSignal.timeout(15000),
    headers:{
      Accept:'application/json',
      Authorization:coupangAuthorization(config,'GET',pathName,''),
      'X-Requested-By':String(config.vendorId||'')
    }
  });
  if(!response.ok) throw new Error(`쿠팡 상품이미지 HTTP ${response.status}`);
  return response.json();
}

async function coupangSellerProductId(order,config){
  const direct=String(order?.sellerProductId||'').trim();
  if(direct) return direct;
  const sku=String(order?.externalVendorSkuCode||order?.externalVendorSku||order?.sellerProductCode||'').trim();
  if(!sku) return '';
  const pathName=`/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/external-vendor-sku-codes/${encodeURIComponent(sku)}`;
  const body=await coupangGet(config,pathName);
  const rows=Array.isArray(body?.data)?body.data:body?.data?[body.data]:[];
  const matching=rows.find(item=>String(item?.vendorItemId||'')===String(order?.vendorItemId||''))||rows[0];
  return String(matching?.sellerProductId||'').trim();
}

async function resolveCoupang(order,config){
  if(!config?.accessKey||!config?.secretKey) return '';
  const sellerProductId=await coupangSellerProductId(order,config);
  if(!sellerProductId) return '';
  const pathName=`/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${encodeURIComponent(sellerProductId)}`;
  const body=await coupangGet(config,pathName);
  return imageFromObject(body?.data||body);
}

async function resolveOpenGraph(url){
  if(!url) return '';
  const response=await fetch(url,{
    redirect:'follow',
    signal:AbortSignal.timeout(12000),
    headers:{
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
      Accept:'text/html,application/xhtml+xml',
      'Accept-Language':'ko-KR,ko;q=0.9,en;q=0.8'
    }
  });
  if(!response.ok) return '';
  const html=(await response.text()).slice(0,900000);
  const patterns=[
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<img[^>]+(?:id|class)=["'][^"']*(?:product|main|representative)[^"']*["'][^>]+src=["']([^"']+)["']/i
  ];
  for(const pattern of patterns){
    const match=html.match(pattern);
    if(match?.[1]) return normalizeImageUrl(match[1]);
  }
  return '';
}

function cacheKey(order={},marketName=''){
  return [
    marketName,
    order.sellerProductId||order.productId||order.originalProductId||order.productNo||order.channelProductNo||order.sellerProductCode||'',
    order.vendorItemId||order.orderProductSequence||order.productOrderId||order.orderNo||''
  ].join('|');
}

function publicProductUrl(order={},marketName=''){
  if(marketName==='쿠팡'&&order.productId){
    const query=order.vendorItemId?`?vendorItemId=${encodeURIComponent(order.vendorItemId)}`:'';
    return `https://www.coupang.com/vp/products/${encodeURIComponent(order.productId)}${query}`;
  }
  if(marketName==='11번가'&&order.productNo){
    return `https://www.11st.co.kr/products/${encodeURIComponent(order.productNo)}`;
  }
  if(marketName==='롯데온'&&(order.productNo||order.productId)){
    return `https://www.lotteon.com/p/product/${encodeURIComponent(order.productNo||order.productId)}`;
  }
  return '';
}

export async function resolveTelegramProductImage(order={},marketName='',options={}){
  const direct=directOrderImage(order);
  if(direct) return direct;

  const key=cacheKey(order,marketName);
  const stored=loadCache()[key];
  if(stored&&Date.now()-Number(stored.checkedAt||0)<(stored.url?POSITIVE_TTL_MS:NEGATIVE_TTL_MS)){
    return String(stored.url||'');
  }

  let url='';
  try{
    if(marketName==='쿠팡'){
      url=await resolveCoupang(order,options.coupangConfig);
    }else if(marketName==='스마트스토어'&&typeof options.smartstoreResolver==='function'){
      url=await options.smartstoreResolver(options.smartstoreConfig,order);
    }
    if(!url) url=await resolveOpenGraph(publicProductUrl(order,marketName));
  }catch(error){
    console.warn('텔레그램 상품 썸네일 조회 생략:',error?.message||error);
  }

  url=normalizeImageUrl(url);
  loadCache()[key]={url,checkedAt:Date.now()};
  saveCache();
  return url;
}

export const productImageTestHelpers={imageFromObject,publicProductUrl,cacheKey};
