import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  activeBusinessProfile,decorateBusinessDocument,documentBusinessKey,namespaceDocumentId
} from '../backend/business-profile.js';

const legacy={
  NAVER_CLIENT_ID:'old-naver',NAVER_CLIENT_SECRET:'old-secret',
  ELEVENST_API_KEY:'old-11',ELEVENST_SELLER_ID:'old-seller',
  LOTTEON_API_KEY:'old-lotte',LOTTEON_SELLER_ID:'old-lotte-seller'
};
const old=activeBusinessProfile(legacy);
assert.equal(old.key,'alldaypick');
assert.equal(old.markets.smartstore.config.clientId,'old-naver');
assert.equal(old.markets.coupang.enabled,true);
assert.equal(namespaceDocumentId('smartstore-1','alldaypick'),'smartstore-1');

const daily=activeBusinessProfile({
  ORDER_ALERT_BUSINESS_PROFILE:'DAILYPICK',
  DAILYPICK_NAVER_CLIENT_ID:'daily-naver',DAILYPICK_NAVER_CLIENT_SECRET:'daily-secret',
  DAILYPICK_ELEVENST_API_KEY:'daily-11',DAILYPICK_ELEVENST_SELLER_ID:'daily-seller',
  DAILYPICK_LOTTEON_API_KEY:'daily-lotte',DAILYPICK_LOTTEON_SELLER_ID:'daily-lotte-seller'
});
assert.equal(daily.key,'dailypick');
assert.equal(daily.name,'데일리픽');
assert.equal(daily.markets.coupang.enabled,false);
assert.equal(daily.markets.smartstore.config.clientId,'daily-naver');
assert.equal(daily.markets.gmarket.enabled,false);
assert.match(daily.markets.gmarket.reason,/API/);
assert.equal(namespaceDocumentId('smartstore-1','dailypick'),'dailypick--smartstore-1');

const previous=process.env.ORDER_ALERT_BUSINESS_PROFILE;
process.env.ORDER_ALERT_BUSINESS_PROFILE='DAILYPICK';
const doc=decorateBusinessDocument({id:'smartstore-123',source:'smartstore'});
assert.equal(doc.id,'dailypick--smartstore-123');
assert.equal(doc.businessKey,'dailypick');
assert.equal(doc.businessName,'데일리픽');
assert.equal(documentBusinessKey({}),'alldaypick');
if(previous==null) delete process.env.ORDER_ALERT_BUSINESS_PROFILE; else process.env.ORDER_ALERT_BUSINESS_PROFILE=previous;

const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
assert.match(app,/v7\.7\.34 사업자 프로필/);
assert.match(app,/isCurrentBusinessOrder/);
assert.match(app,/currentBusinessKey/);
const agent=fs.readFileSync(new URL('../backend/local-agent.js',import.meta.url),'utf8');
assert.match(agent,/ACTIVE_BUSINESS=activeBusinessProfile/);
assert.match(agent,/현재 주문 API 없음 · 미연동/);
assert.match(agent,/businessName:ACTIVE_BUSINESS\.name/);
console.log('v7.7.34 business profile contract passed');
