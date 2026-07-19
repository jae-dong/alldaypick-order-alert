import assert from 'node:assert/strict';
import { coupangClaimsTestHelpers as H } from '../backend/coupang-claims.js';

assert.equal(H.exchangeActiveState({exchangeStatus:'RECEIPT'}),true);
assert.equal(H.exchangeActiveState({exchangeStatus:'PROGRESS'}),true);
assert.equal(H.exchangeActiveState({exchangeStatus:'SUCCESS'}),false);
assert.equal(H.exchangeActiveState({exchangeStatus:'REJECT'}),false);
assert.equal(H.exchangeActiveState({exchangeStatus:'CANCEL'}),false);

const docs=H.exchangeDocuments([
  {exchangeId:1,orderId:10,exchangeStatus:'SUCCESS',exchangeItemDtoV1s:[{orderItemId:100,quantity:1}]},
  {exchangeId:2,orderId:20,exchangeStatus:'PROGRESS',exchangeItemDtoV1s:[{orderItemId:200,quantity:1}]}
]);
assert.equal(docs.find(item=>item.exchangeId==='1').activeState,false);
assert.equal(docs.find(item=>item.exchangeId==='2').activeState,true);
console.log('coupang exchange tests passed');
