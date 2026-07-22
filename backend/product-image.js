import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const BACKEND_DIR=path.dirname(fileURLToPath(import.meta.url));
// 이전 버전에서 "이미지 없음"으로 저장된 음수 캐시를 재사용하지 않습니다.
const CACHE_PATH=path.join(BACKEND_DIR,'.telegram-product-image-cache-v10.json');
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

function decodedImageText(value){
  return String(value||'')
    .trim()
    .replaceAll('&amp;','&')
    .replaceAll('&quot;','"')
    .replaceAll('&#39;',"'")
    .replace(/&#x2f;|&#47;/gi,'/')
    .replaceAll('\\/','/')
    .replace(/\\u002f/gi,'/')
    .replace(/^['"]|['"]$/g,'');
}

export function normalizeImageUrl(value,baseUrl=''){
  let url=decodedImageText(value);
  if(!url) return '';
  if(url.startsWith('//')) url=`https:${url}`;
  if(url.startsWith('/image/')) url=`https://image.coupangcdn.com${url}`;
  if(/^image\//i.test(url)) url=`https://image.coupangcdn.com/${url}`;
  if(/^(?:shop-phinf|shopping-phinf|ssl\.pstatic|shopping\.phinf)\.pstatic\.net\//i.test(url)) url=`https://${url}`;
  if(/^(?:image\d*[a-z]?|img\d*[a-z]?|thumbnail\d*|static)\.coupangcdn\.com\//i.test(url)) url=`https://${url}`;
  if(/^(?:gdimg\.gmarket|image\.auction|image\d+\.auction|contents\.lotteon|static\.11st|cdn\.11st)\.(?:co\.kr|com|net)\//i.test(url)) url=`https://${url}`;
  if(baseUrl&&!/^https?:\/\//i.test(url)){
    try{url=new URL(url,baseUrl).toString();}catch{}
  }
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
    const raw=decodedImageText(value);
    if((raw.startsWith('{')||raw.startsWith('['))&&raw.length<1000000){
      try{
        const parsed=JSON.parse(raw);
        const found=imageFromObject(parsed,depth+1,parentKey);
        if(found) return found;
      }catch{}
    }
    const htmlPatterns=[
      /<img[^>]+(?:src|data-src|data-original)=["']([^"']+)["']/ig,
      /(?:"|')?(?:imageUrl|representativeImageUrl|thumbnailUrl|mainImageUrl|prdImgUrl|spdImgUrl|goodsImage|vendorPath|cdnPath)(?:"|')?\s*[:=]\s*["']([^"']+)["']/ig
    ];
    for(const pattern of htmlPatterns){
      let match;
      while((match=pattern.exec(raw))){
        const normalized=normalizeImageUrl(match[1]);
        if(normalized) return normalized;
      }
    }
    const normalized=normalizeImageUrl(raw);
    if(!normalized) return '';
    // 상세페이지 URL을 이미지로 오인하지 않도록 이미지 문맥 또는 이미지 확장자를 요구합니다.
    if(/image|thumb|photo|picture|vendorpath|cdnpath|representative|content/i.test(parentKey)) return normalized;
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
    'productImageUrl','mainImageUrl','prdImgUrl','spdImgUrl','prdImg','thumbUrl',
    'goodsImage','goodsImageUrl','mainImg','rprsImgUrl','repImgUrl','imgFullPthNm',
    'thumbnail','images','image','imageList','imgList','vendorPath','cdnPath','content','detailContent','htmlContent'
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
  return imageFromObject(order)||imageFromObject({
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

function isRejectedCoupangImageUrl(value){
  const url=normalizeImageUrl(value);
  if(!url) return true;
  try{
    const parsed=new URL(url);
    const target=`${parsed.pathname}${parsed.search}`.toLowerCase();
    // 쿠팡 상세설명/공지/프로모션 이미지는 상품 대표 썸네일로 사용하지 않습니다.
    return [
      '/product/content/','/content/vendoritem/','banner','notice','promotion',
      'shipping-guide','delivery-guide','seller-guide','wing-guide','cmg/content'
    ].some(token=>target.includes(token));
  }catch{
    return true;
  }
}

function coupangImageEntryUrl(entry={}){
  // 상품조회 응답의 vendorPath는 파일명만 들어오는 사례가 많고 cdnPath는
  // 실제 쿠팡 CDN 경로입니다. 따라서 cdnPath를 먼저 확인해야 합니다.
  const candidates=[
    entry.cdnPath,entry.vendorPath,entry.imageUrl,entry.thumbnailUrl,
    entry.productImageUrl,entry.representativeImageUrl,entry.url
  ];
  for(const candidate of candidates){
    let raw=decodedImageText(candidate);
    if(!raw) continue;
    try{raw=decodeURIComponent(raw);}catch{}
    if(raw.startsWith('//')) raw=`https:${raw}`;
    if(raw.startsWith('/')) raw=`https://image.coupangcdn.com${raw}`;
    if(!/^https?:\/\//i.test(raw)&&/^image\//i.test(raw)) raw=`https://image.coupangcdn.com/${raw}`;
    if(!/^https?:\/\//i.test(raw)&&/^(?:vendor_inventory|product|retail)\//i.test(raw)){
      // cdnPath 예: vendor_inventory/images/... 는 /image/ 접두사가 있어야
      // 공개 CDN 주소가 됩니다. 원격 썸네일 주소를 사용하면 용량도 안정적입니다.
      raw=`https://thumbnail.coupangcdn.com/thumbnails/remote/q89/image/${raw.replace(/^\/+/, '')}`;
    }
    if(!/^https?:\/\//i.test(raw)&&/^thumbnails\//i.test(raw)) raw=`https://thumbnail.coupangcdn.com/${raw}`;
    const url=normalizeImageUrl(raw);
    if(url&&!isRejectedCoupangImageUrl(url)) return url;
  }
  return '';
}

function isTrustedCoupangDirectUrl(value){
  const url=normalizeImageUrl(value);
  if(!url||isRejectedCoupangImageUrl(url)) return false;
  try{
    const parsed=new URL(url);
    const host=parsed.hostname.toLowerCase();
    const target=parsed.pathname.toLowerCase();
    if(!host.includes('coupangcdn.com')) return false;
    return [
      '/image/product/image/','/image/retail/','/image/vendor_inventory/',
      '/thumbnails/remote/','/thumbnails/remote/q89/'
    ].some(token=>target.includes(token));
  }catch{
    return false;
  }
}

function coupangImagesFromObject(value){
  if(!value||typeof value!=='object') return '';
  const images=Array.isArray(value.images)?value.images:[];
  const typeOf=item=>String(
    item?.imageType||item?.type||item?.imageTypeName||item?.imageRole||''
  ).trim().toUpperCase();
  const preferred=images
    .filter(item=>['REPRESENTATION','REPRESENTATIVE','MAIN','대표'].includes(typeOf(item)))
    .sort((a,b)=>Number(a?.imageOrder??a?.order??999)-Number(b?.imageOrder??b?.order??999));
  const primary=images
    .filter(item=>!typeOf(item)&&Number(item?.imageOrder??item?.order??-1)===0);
  // 상세 이미지(DETAIL/CONTENTS)는 절대 후보로 넣지 않습니다.
  for(const item of [...preferred,...primary]){
    const url=coupangImageEntryUrl(item);
    if(url) return url;
  }
  return '';
}

function collectCoupangObjects(value,depth=0,out=[]){
  if(depth>10||value==null) return out;
  if(Array.isArray(value)){
    for(const item of value) collectCoupangObjects(item,depth+1,out);
    return out;
  }
  if(typeof value!=='object') return out;
  out.push(value);
  for(const item of Object.values(value)){
    if(item&&typeof item==='object') collectCoupangObjects(item,depth+1,out);
  }
  return out;
}

export function coupangRepresentativeImage(value,order={}){
  const objects=collectCoupangObjects(value?.data??value);
  const vendorItemId=String(order?.vendorItemId||'').trim();
  const sellerProductItemId=String(order?.sellerProductItemId||'').trim();
  const matching=objects.filter(item=>{
    if(vendorItemId&&String(item?.vendorItemId||'').trim()===vendorItemId) return true;
    if(sellerProductItemId&&String(item?.sellerProductItemId||'').trim()===sellerProductItemId) return true;
    return false;
  });
  for(const item of matching){
    const found=coupangImagesFromObject(item);
    if(found) return found;
  }
  for(const item of objects){
    const found=coupangImagesFromObject(item);
    if(found) return found;
  }
  return '';
}

export function directCoupangOrderImage(order={}){
  const fromImages=coupangRepresentativeImage({items:[order]},order);
  if(fromImages) return fromImages;
  const explicit=[
    order.representativeImageUrl,order.productImageUrl,order.thumbnailUrl,
    order.mainImageUrl,order.imageUrl
  ];
  for(const value of explicit){
    const url=normalizeImageUrl(value);
    if(url&&isTrustedCoupangDirectUrl(url)) return url;
  }
  return '';
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

async function coupangGet(config,pathName,params={}){
  const query=new URLSearchParams();
  for(const [key,value] of Object.entries(params||{})){
    if(value==null||String(value)==='') continue;
    query.append(key,String(value));
  }
  const queryText=query.toString();
  const suffix=queryText?`?${queryText}`:'';
  const response=await fetch(`https://api-gateway.coupang.com${pathName}${suffix}`,{
    method:'GET',
    signal:AbortSignal.timeout(20000),
    headers:{
      Accept:'application/json',
      Authorization:coupangAuthorization(config,'GET',pathName,queryText),
      'X-Requested-By':String(config.vendorId||'')
    }
  });
  if(!response.ok){
    const detail=(await response.text()).slice(0,300);
    throw new Error(`쿠팡 상품이미지 HTTP ${response.status}: ${detail}`);
  }
  return response.json();
}

function findValues(value,keyPattern,depth=0,found=[]){
  if(depth>10||value==null) return found;
  if(Array.isArray(value)){
    value.forEach(item=>findValues(item,keyPattern,depth+1,found));
    return found;
  }
  if(typeof value!=='object') return found;
  for(const [key,item] of Object.entries(value)){
    if(keyPattern.test(key)&&item!=null&&['string','number'].includes(typeof item)) found.push(String(item));
    if(item&&typeof item==='object') findValues(item,keyPattern,depth+1,found);
  }
  return found;
}

function normalizedProductName(value){
  return String(value||'').toLowerCase().replace(/[^0-9a-z가-힣]+/g,' ').replace(/\s+/g,' ').trim();
}

async function coupangSellerProductCandidates(order,config){
  const ids=[];
  const add=value=>{
    const id=String(value||'').trim();
    if(id&&/^\d+$/.test(id)&&!ids.includes(id)) ids.push(id);
  };
  add(order?.sellerProductId);

  const sku=String(order?.externalVendorSkuCode||order?.externalVendorSku||order?.sellerProductCode||'').trim();
  if(sku){
    try{
      const pathName=`/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/external-vendor-sku-codes/${encodeURIComponent(sku)}`;
      const body=await coupangGet(config,pathName);
      for(const value of findValues(body,/^sellerProductId$/i)) add(value);
    }catch(error){
      console.warn('쿠팡 판매자상품코드 이미지 조회 건너뜀:',error?.message||error);
    }
  }

  // 발주서에 sellerProductId가 없는 상품은 상품명(최대 20자)으로 등록상품 목록을 찾습니다.
  if(ids.length===0&&config?.vendorId&&order?.product){
    try{
      const pathName='/v2/providers/seller_api/apis/api/v1/marketplace/seller-products';
      const searchName=String(order.product).replace(/\s+/g,' ').trim().slice(0,20);
      const body=await coupangGet(config,pathName,{
        vendorId:config.vendorId,maxPerPage:100,nextToken:1,sellerProductName:searchName
      });
      const rows=Array.isArray(body?.data)?body.data:[];
      const targetProductId=String(order?.productId||'').trim();
      const targetName=normalizedProductName(order?.product);
      rows.sort((a,b)=>{
        const score=item=>
          (targetProductId&&String(item?.productId||'')===targetProductId?100:0)+
          (normalizedProductName(item?.sellerProductName)===targetName?50:0)+
          (normalizedProductName(item?.sellerProductName).includes(targetName.slice(0,12))?10:0);
        return score(b)-score(a);
      });
      for(const row of rows.slice(0,12)) add(row?.sellerProductId);
    }catch(error){
      console.warn('쿠팡 상품명 이미지 검색 건너뜀:',error?.message||error);
    }
  }
  return ids;
}

async function resolveCoupang(order,config){
  if(!config?.accessKey||!config?.secretKey) return '';
  const candidates=await coupangSellerProductCandidates(order,config);
  const pathBase='/v2/providers/seller_api/apis/api/v1/marketplace/seller-products';
  for(const sellerProductId of candidates){
    try{
      const body=await coupangGet(config,`${pathBase}/${encodeURIComponent(sellerProductId)}`);
      const image=coupangRepresentativeImage(body,order);
      if(image) return image;
    }catch(error){
      console.warn(`쿠팡 등록상품 ${sellerProductId} 이미지 조회 건너뜀:`,error?.message||error);
    }
  }
  return '';
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
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    /<meta[^>]+itemprop=["']image["'][^>]+content=["']([^"']+)["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
    /<img[^>]+(?:id|class)=["'][^"']*(?:product|main|representative)[^"']*["'][^>]+src=["']([^"']+)["']/i
  ];
  for(const pattern of patterns){
    const match=html.match(pattern);
    if(match?.[1]){
      const image=normalizeImageUrl(match[1],response.url||url);
      if(image&&!isRejectedGenericImageUrl(image)) return image;
    }
  }
  // 일부 마켓은 대표 이미지를 JSON-LD Product 데이터에만 넣습니다.
  for(const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/ig)){
    try{
      const parsed=JSON.parse(match[1].trim());
      const image=imageFromObject({image:parsed?.image,images:parsed?.images});
      if(image&&!isRejectedGenericImageUrl(image)) return normalizeImageUrl(image,response.url||url);
    }catch{}
  }
  return '';
}

function isRejectedGenericImageUrl(value){
  const url=normalizeImageUrl(value);
  if(!url) return true;
  try{
    const target=`${new URL(url).pathname}${new URL(url).search}`.toLowerCase();
    return [
      'favicon','logo','sprite','icon','blank.gif','spacer.gif','no_image','noimage',
      'placeholder','loading.gif','common/banner','header/banner','footer/banner'
    ].some(token=>target.includes(token));
  }catch{return true;}
}

function cacheKey(order={},marketName=''){
  return [
    marketName,
    order.sellerProductId||order.channelProductNo||order.productId||order.originProductNo||order.originalProductId||order.productNo||order.goodsNo||order.itemNo||order.spdNo||order.sellerProductCode||'',
    order.vendorItemId||order.orderProductSequence||order.productOrderId||order.orderNo||''
  ].join('|');
}

export function invalidateTelegramProductImageCache(order={},marketName=''){
  const key=cacheKey(order,marketName);
  const current=loadCache();
  if(Object.prototype.hasOwnProperty.call(current,key)){
    delete current[key];
    saveCache();
  }
}

function publicProductUrl(order={},marketName=''){
  for(const key of ['productUrl','productPageUrl','mallProductUrl','detailUrl','itemUrl','goodsUrl','url']){
    const direct=normalizeImageUrl(order?.[key]);
    if(direct) return direct;
  }
  if(marketName==='쿠팡'&&order.productId){
    const query=order.vendorItemId?`?vendorItemId=${encodeURIComponent(order.vendorItemId)}`:'';
    return `https://www.coupang.com/vp/products/${encodeURIComponent(order.productId)}${query}`;
  }
  if(marketName==='11번가'&&order.productNo){
    return `https://www.11st.co.kr/products/${encodeURIComponent(order.productNo)}`;
  }
  if(marketName==='스마트스토어'&&(order.channelProductNo||order.productId||order.productNo)){
    return `https://smartstore.naver.com/main/products/${encodeURIComponent(order.channelProductNo||order.productId||order.productNo)}`;
  }
  if(marketName==='롯데온'&&(order.productNo||order.productId)){
    return `https://www.lotteon.com/p/product/${encodeURIComponent(order.productNo||order.productId)}`;
  }
  if(['G마켓','지마켓'].includes(marketName)&&(order.goodsNo||order.productNo||order.productId)){
    return `https://item.gmarket.co.kr/Item?goodscode=${encodeURIComponent(order.goodsNo||order.productNo||order.productId)}`;
  }
  if(marketName==='옥션'&&(order.itemNo||order.productNo||order.productId)){
    return `https://itempage3.auction.co.kr/DetailView.aspx?itemno=${encodeURIComponent(order.itemNo||order.productNo||order.productId)}`;
  }
  return '';
}

export async function resolveTelegramProductImage(order={},marketName='',options={}){
  const direct=marketName==='쿠팡'?directCoupangOrderImage(order):directOrderImage(order);
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
    }else if(marketName==='롯데온'&&typeof options.lotteonResolver==='function'){
      url=await options.lotteonResolver(options.lotteonConfig,order);
    }
    if(!url) url=await resolveOpenGraph(publicProductUrl(order,marketName));
  }catch(error){
    console.warn('텔레그램 상품 썸네일 조회 생략:',error?.message||error);
  }

  url=normalizeImageUrl(url);
  loadCache()[key]={url,checkedAt:Date.now()};
  saveCache();
  if(!url){
    console.warn(
      '텔레그램 상품 썸네일 최종 미확인 ·',
      `${marketName} · 채널상품 ${order.channelProductNo||order.productId||'-'} · 원상품 ${order.originProductNo||order.originalProductId||'-'} · 판매자코드 ${order.sellerProductCode||'-'}`
    );
  }
  return url;
}

export const productImageTestHelpers={
  imageFromObject,publicProductUrl,cacheKey,findValues,isRejectedCoupangImageUrl,
  isTrustedCoupangDirectUrl,coupangImagesFromObject,coupangImageEntryUrl,
  coupangSellerProductCandidates,normalizedProductName,isRejectedGenericImageUrl,resolveOpenGraph
};
