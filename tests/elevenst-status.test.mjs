import assert from 'node:assert/strict';
import { elevenstTestHelpers as H } from '../backend/elevenst.js';

assert.equal(H.mapElevenOrderStatus({ordPrdStatNm:'배송중',invoiceNo:'123'}).status,'delivering');
assert.equal(H.mapElevenOrderStatus({ordPrdStat:'COMPLETE'}).status,'shipping_wait');
assert.equal(H.mapElevenOrderStatus({ordPrdStatNm:'결제완료'}).status,'new');
assert.equal(H.mapElevenOrderStatus({ordNo:'1'}).status,'shipping_wait');
assert.equal(H.mapElevenOrderStatus({ordNo:'1',dlvNo:'not-a-waybill'},{status:'new',sourceStatus:'COMPLETE'}).status,'new','dlvNo alone must not turn a new order into delivering');
assert.equal(H.mapElevenOrderStatus({ordNo:'2',dlvNo:'delivery-management-no'},{status:'delivered',sourceStatus:'INVOICE_REGISTERED'}).status,'shipping_wait','recent incorrectly closed orders must be repairable');

const rows=H.collectRows({
  response:{
    order:{
      ordNo:'100',
      products:{product:{ordPrdSeq:'1',ordPrdStatNm:'배송중',invoiceNo:'ABC'}}
    }
  }
});
assert.equal(rows.length,1);
assert.equal(rows[0].ordNo,'100');
assert.equal(rows[0].ordPrdSeq,'1');
assert.equal(H.mapElevenOrderStatus(rows[0]).status,'delivering');



const now=Date.parse('2026-07-20T00:00:00+09:00');
const refreshSelection=H.statusRefreshDocuments([
  {id:'inactive-pending',eventType:'order',status:'shipping_wait',activeState:false,orderNo:'200'},
  {id:'inactive-done',eventType:'order',status:'delivered',activeState:false,orderNo:'300',datetime:'2026-07-19T00:00:00+09:00'},
  {id:'inactive-old',eventType:'order',status:'delivered',activeState:false,orderNo:'301',datetime:'2025-01-01T00:00:00+09:00'},
  {id:'active-claim',eventType:'return',activeState:true,orderNo:'400'}
],now);
assert.deepEqual(refreshSelection.normalExisting.map(item=>item.id),['inactive-pending','inactive-done']);
assert.deepEqual(refreshSelection.activeClaims.map(item=>item.id),['active-claim']);

const originalFetch=globalThis.fetch;
const called=[];
globalThis.fetch=async url=>{
  called.push(String(url));
  const isSingle200=String(url).endsWith('/200');
  const xml=isSingle200
    ?'<response><order><ordNo>200</ordNo><ordPrdSeq>1</ordPrdSeq><ordPrdStat>COMPLETE</ordPrdStat></order></response>'
    :'<response><order><ordNo>100</ordNo><ordPrdSeq>1</ordPrdSeq><ordPrdStat>COMPLETE</ordPrdStat></order></response>';
  return new Response(xml,{status:200,headers:{'content-type':'application/xml'}});
};
try{
  const partial=await H.fetchStatusRows({apiKey:'test'},['100','200']);
  assert.equal(partial.complete,true,'missing orders must be re-queried individually');
  assert.deepEqual(partial.missingOrderNos,[]);
  assert.equal(new Set(partial.rows.map(row=>row.ordNo)).size,2);
  assert.ok(called.some(url=>url.endsWith('/200')),'the missing order must be queried individually');
}finally{
  globalThis.fetch=originalFetch;
}

console.log('elevenst status tests passed');
