import assert from 'node:assert/strict';
import { coupangClaimsTestHelpers as H } from '../backend/coupang-claims.js';

assert.equal(H.exchangeActiveState({exchangeStatus:'RECEIPT'}),true);
assert.equal(H.exchangeActiveState({exchangeStatus:'PROGRESS'}),true);
assert.equal(H.exchangeActiveState({exchangeStatus:'PROGRESS',exchangeItemDtoV1s:[{targetItemDeliveryComplete:true}]}),true,'official PROGRESS must remain active even after replacement delivery');
assert.equal(H.exchangeActiveState({exchangeStatus:'PROGRESS',deliveryStatus:'CompleteDelivery'}),true,'delivery completion must not override official exchange status');
assert.equal(H.exchangeActiveState({exchangeStatus:'SUCCESS'}),false);
assert.equal(H.exchangeActiveState({exchangeStatus:'REJECT'}),false);
assert.equal(H.exchangeActiveState({exchangeStatus:'CANCEL'}),false);
assert.equal(H.exchangeActiveState({exchangeStatus:'EXCHANGE_COMPLETED'}),false);
assert.equal(H.exchangeActiveState({exchangeStatus:'SUCCESSFUL'}),false);

const docs=H.exchangeDocuments([
  {exchangeId:1,orderId:10,exchangeStatus:'SUCCESS',exchangeItemDtoV1s:[{orderItemId:100,quantity:1}]},
  {exchangeId:2,orderId:20,exchangeStatus:'PROGRESS',exchangeItemDtoV1s:[{orderItemId:200,quantity:1}]}
]);
assert.equal(docs.find(item=>item.exchangeId==='1').activeState,false);
assert.equal(docs.find(item=>item.exchangeId==='2').activeState,true);
console.log('coupang exchange tests passed');

assert.ok(H.rangeWindows(90,6).length>=15,'startup exchange repair must support a 90-day split range');


const regularFrom=new Date('2026-07-01T00:00:00.000Z');
assert.equal(H.exchangeReconcileFrom(regularFrom,false).getTime(),regularFrom.getTime());
assert.equal(H.exchangeReconcileFrom(regularFrom).getTime(),regularFrom.getTime(),'reconciliation must only close documents inside the directly queried period');

assert.equal(H.exchangeActiveState({exchangeStatusLabel:'RECEIPT'}),true);
assert.equal(H.exchangeActiveState({exchangeStatusLabel:'PROGRESS'}),true);
assert.equal(H.exchangeActiveState({exchangeStatusLabel:'SUCCESS'}),false);
assert.equal(H.exchangeActiveState({exchangeStatus:''}),false,'empty legacy exchange status must not remain active');
assert.equal(H.exchangeActiveState({exchangeStatus:'EXCHANGE_REQUEST'}),false,'non-official legacy status must not remain active');

{
  const writes=[];
  const docs=[
    {id:'coupang-exchange-active-1',data:()=>({source:'coupang',eventType:'exchange',activeState:true}),ref:{path:'orders/active'}},
    {id:'coupang-exchange-stale-2',data:()=>({source:'coupang',eventType:'exchange',activeState:true}),ref:{path:'orders/stale'}}
  ];
  const query={where(){return this;},async get(){return {forEach(callback){docs.forEach(callback);}};}};
  const db={
    collection(){return query;},
    batch(){return {set(ref,payload){writes.push({ref,payload});},async commit(){}};}
  };
  const result=await H.forceCloseStaleCoupangExchanges(db,[{id:'coupang-exchange-active-1',activeState:true}],{complete:true});
  assert.equal(result.deactivated,1);
  assert.equal(writes.length,1);
  assert.equal(writes[0].ref.path,'orders/stale');
  assert.equal(writes[0].payload.activeState,false);
}

assert.equal(H.isCoupangExchangeDocument({source:'쿠팡',status:'exchange_request'},'legacy-1'),true);
assert.equal(H.isCoupangExchangeDocument({market:'쿠팡',eventType:'exchange'},'legacy-2'),true);
assert.equal(H.isCoupangExchangeDocument({source:'smartstore',eventType:'exchange'},'naver-1'),false);

{
  const writes=[];
  const docs=[
    {id:'legacy-korean-exchange',data:()=>({source:'쿠팡',status:'exchange_request',activeState:true,exchangeId:'OLD-1'}),ref:{path:'orders/legacy-korean'}},
    {id:'smartstore-exchange',data:()=>({source:'smartstore',market:'스마트스토어',eventType:'exchange',activeState:true}),ref:{path:'orders/naver'}}
  ];
  const query={where(){return this;},async get(){return {forEach(callback){docs.forEach(callback);}};}};
  const db={
    collection(){return query;},
    batch(){return {set(ref,payload){writes.push({ref,payload});},async commit(){}};}
  };
  const result=await H.forceCloseStaleCoupangExchanges(db,[],{complete:true});
  assert.equal(result.deactivated,1);
  assert.equal(writes[0].ref.path,'orders/legacy-korean');
  assert.equal(writes[0].payload.sourceStatus,'SUCCESS');
}
