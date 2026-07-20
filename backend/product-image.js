import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const BACKEND_DIR=path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH=path.join(BACKEND_DIR,'.telegram-product-image-cache.json');
const POSITIVE_TTL_MS=30*24*60*60*1000;
const NEGATIVE_TTL_MS=6*60*60*1000;
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
  let url=String(value||'').trim();
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

function imageFromObject(value,depth=0){
  if(depth>7||value==null) return '';
  if(typeof value==='string') return normalizeImageUrl(value);
  if(Array.isArray(value)){
    for(const item of value){
      const found=imageFromObject(item,depth+1);
      if(found) return found;
    }
    return '';
  }
  if(typeof value!=='object') return '';

  const preferred=[
    'imageUrl','thumbnailUrl','productImageUrl','representativeImageUrl',
    'mainImageUrl','prdImgUrl','prdImg','thumbUrl','thumbnail','image',
    'vendorPath','cdnPath','url'
  ];
  for(const key of preferred){
    if(value[key]!=null){
      const found=imageFromObject(value[key],depth+1);
      if(found) return found;
    }
  }
  for(const [key,item] of Object.entries(value)){
    if(!/image|thumb|photo|picture|vendorpath|cdnpath/i.test(key)) continue;
    const found=imageFromObject(item,depth+1);
    if(found) return found;
  }
  return '';
}

export function directOrderImage(order={}){
  return imageFromObject({
    imageUrl:order.imageUrl,
    thumbnailUrl:order.thumbnailUrl,
    productImageUrl:order.productImageUrl,
    representativeImageUrl:order.representativeImageUrl,
    mainImageUrl:order.mainImageUrl,
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

async function resolveCoupang(order,config){
  const sellerProductId=String(order?.sellerProductId||'').trim();
  if(!sellerProductId||!config?.accessKey||!config?.secretKey) return '';
  const pathName=`/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${encodeURIComponent(sellerProductId)}`;
  const response=await fetch(`https://api-gateway.coupang.com${pathName}`,{
    method:'GET',
    signal:AbortSignal.timeout(12000),
    headers:{
      Accept:'application/json',
      Authorization:coupangAuthorization(config,'GET',pathName,''),
      'X-Requested-By':String(config.vendorId||'')
    }
  });
  if(!response.ok) throw new Error(`쿠팡 상품이미지 HTTP ${response.status}`);
  const body=await response.json();
  return imageFromObject(body?.data||body);
}

async function resolveOpenGraph(url){
  if(!url) return '';
  const response=await fetch(url,{
    signal:AbortSignal.timeout(10000),
    headers:{
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
      Accept:'text/html,application/xhtml+xml'
    }
  });
  if(!response.ok) return '';
  const html=(await response.text()).slice(0,700000);
  const patterns=[
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i
  ];
  for(const pattern of patterns){
    const match=html.match(pattern);
    if(match?.[1]) return normalizeImageUrl(match[1].replaceAll('&amp;','&'));
  }
  return '';
}

function cacheKey(order={},marketName=''){
  return [
    marketName,
    order.sellerProductId||order.productId||order.productNo||order.channelProductNo||'',
    order.vendorItemId||order.orderProductSequence||order.productOrderId||order.orderNo||''
  ].join('|');
}

function publicProductUrl(order={},marketName=''){
  if(marketName==='쿠팡'&&order.productId){
    const item=order.vendorItemId?`?itemId=${encodeURIComponent(order.vendorItemId)}`:'';
    return `https://www.coupang.com/vp/products/${encodeURIComponent(order.productId)}${item}`;
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
      url=await options.smartstoreResolver(options.smartstoreConfig,order.productId||order.channelProductNo||'');
    }
    if(!url){
      url=await resolveOpenGraph(publicProductUrl(order,marketName));
    }
  }catch(error){
    console.warn('텔레그램 상품 썸네일 조회 생략:',error?.message||error);
  }

  url=normalizeImageUrl(url);
  loadCache()[key]={url,checkedAt:Date.now()};
  saveCache();
  return url;
}

export const productImageTestHelpers={imageFromObject,publicProductUrl,cacheKey};
