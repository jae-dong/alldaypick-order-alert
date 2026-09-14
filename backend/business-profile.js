function text(value){
  return String(value??'').trim();
}

function boolValue(value,defaultValue=false){
  const raw=text(value).toLowerCase();
  if(!raw) return Boolean(defaultValue);
  if(['1','true','yes','y','on','enabled','사용','활성'].includes(raw)) return true;
  if(['0','false','no','n','off','disabled','미사용','비활성'].includes(raw)) return false;
  return Boolean(defaultValue);
}

export function normalizeBusinessKey(value=''){
  const raw=text(value).toLowerCase().replace(/[\s_-]+/g,'');
  if(['dailypick','데일리픽','daily'].includes(raw)) return 'dailypick';
  return 'alldaypick';
}

function profileInfo(key){
  if(key==='dailypick') return {key:'dailypick',name:'데일리픽',prefix:'DAILYPICK'};
  return {key:'alldaypick',name:'올데이픽',prefix:'ALLDAYPICK'};
}

function profileEnabled(env,profile){
  // v7.7.35 운영 기본값: 데일리픽 ON, 올데이픽 OFF.
  // 올데이픽을 다시 쓸 때만 ALLDAYPICK_PROFILE_ENABLED=1로 명시적으로 켭니다.
  const defaultValue=profile.key==='dailypick';
  return boolValue(env[`${profile.prefix}_PROFILE_ENABLED`],defaultValue);
}

export function businessProfilesState(env=process.env){
  return {
    alldaypick:{key:'alldaypick',name:'올데이픽',enabled:profileEnabled(env,profileInfo('alldaypick'))},
    dailypick:{key:'dailypick',name:'데일리픽',enabled:profileEnabled(env,profileInfo('dailypick'))}
  };
}

function readProfileValue(env,profile,name){
  const prefixed=text(env[`${profile.prefix}_${name}`]);
  if(prefixed) return prefixed;
  // v7.7.33까지 사용하던 기존 환경변수는 올데이픽 자격증명으로 간주합니다.
  if(profile.key==='alldaypick') return text(env[name]);
  return '';
}

function marketEnabled(env,profile,market,defaultValue){
  return boolValue(env[`${profile.prefix}_${market.toUpperCase()}_ENABLED`],defaultValue);
}

export function activeBusinessProfile(env=process.env){
  const key=normalizeBusinessKey(
    env.ORDER_ALERT_BUSINESS_PROFILE||env.ACTIVE_BUSINESS||'DAILYPICK'
  );
  const profile=profileInfo(key);
  const enabled=profileEnabled(env,profile);

  const coupang={
    accessKey:readProfileValue(env,profile,'COUPANG_ACCESS_KEY'),
    secretKey:readProfileValue(env,profile,'COUPANG_SECRET_KEY'),
    vendorId:readProfileValue(env,profile,'COUPANG_VENDOR_ID')
  };
  const smartstore={
    clientId:readProfileValue(env,profile,'NAVER_CLIENT_ID'),
    clientSecret:readProfileValue(env,profile,'NAVER_CLIENT_SECRET')
  };
  const elevenst={
    apiKey:readProfileValue(env,profile,'ELEVENST_API_KEY'),
    sellerId:readProfileValue(env,profile,'ELEVENST_SELLER_ID')
  };
  const lotteon={
    apiKey:readProfileValue(env,profile,'LOTTEON_API_KEY'),
    sellerId:readProfileValue(env,profile,'LOTTEON_SELLER_ID'),
    sellerLoginId:readProfileValue(env,profile,'LOTTEON_LOGIN_ID')
  };

  // 현재 데일리픽 운영 대상은 스마트스토어/11번가/롯데온입니다.
  // 쿠팡은 사용자가 추가한다고 지정하지 않았으므로 기본 비활성입니다.
  const dailypick=profile.key==='dailypick';
  const markets={
    coupang:{
      name:'쿠팡',
      enabled:enabled&&marketEnabled(env,profile,'coupang',!dailypick),
      configured:Boolean(coupang.accessKey&&coupang.secretKey&&coupang.vendorId),
      config:coupang
    },
    smartstore:{
      name:'스마트스토어',
      enabled:enabled&&marketEnabled(env,profile,'smartstore',true),
      configured:Boolean(smartstore.clientId&&smartstore.clientSecret),
      config:smartstore
    },
    elevenst:{
      name:'11번가',
      enabled:enabled&&marketEnabled(env,profile,'elevenst',true),
      configured:Boolean(elevenst.apiKey&&elevenst.sellerId),
      config:elevenst
    },
    lotteon:{
      name:'롯데온',
      enabled:enabled&&marketEnabled(env,profile,'lotteon',true),
      configured:Boolean(lotteon.apiKey&&lotteon.sellerId),
      config:lotteon
    },
    gmarket:{
      name:'G마켓',enabled:false,configured:false,config:{},
      reason:'ESM API 승인 대기 · 미연동'
    },
    auction:{
      name:'옥션',enabled:false,configured:false,config:{},
      reason:'ESM API 승인 대기 · 미연동'
    }
  };

  return {...profile,enabled,markets};
}

export function activeBusinessKey(env=process.env){
  return activeBusinessProfile(env).key;
}

export function documentBusinessKey(value={}){
  return normalizeBusinessKey(value?.businessKey||value?.businessName||value?.business||'alldaypick');
}

export function documentBelongsToActiveBusiness(value={},env=process.env){
  return documentBusinessKey(value)===activeBusinessKey(env);
}

export function namespaceDocumentId(id,businessKey=activeBusinessKey(process.env)){
  const raw=text(id);
  if(!raw) return raw;
  const key=normalizeBusinessKey(businessKey);
  if(key==='alldaypick') return raw; // 기존 v7.7.33 문서 ID를 그대로 보존합니다.
  const prefix=`${key}--`;
  return raw.startsWith(prefix)?raw:`${prefix}${raw}`;
}

export function decorateBusinessDocument(value={},env=process.env){
  const profile=activeBusinessProfile(env);
  const originalId=text(value?.id);
  const id=namespaceDocumentId(originalId,profile.key);
  return {
    ...value,
    id,
    ...(id!==originalId&&originalId?{legacyId:originalId}:{}),
    businessKey:profile.key,
    businessName:profile.name
  };
}

export const businessProfileTestHelpers={boolValue,readProfileValue,marketEnabled};
