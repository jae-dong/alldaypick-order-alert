import assert from 'node:assert/strict';
import { telegramAlertType } from '../backend/telegram-alert-policy.js';

const markets=['coupang','smartstore','elevenst','lotteon'];
for(const source of markets){
  assert.equal(telegramAlertType({source,eventType:'cancel',status:'cancel_request',activeState:true,sourceStatus:'REQUEST'}),'cancel');
  assert.equal(telegramAlertType({source,eventType:'return',status:'return_request',activeState:true,sourceStatus:'REQUEST'}),'return');
  assert.equal(telegramAlertType({source,eventType:'exchange',status:'exchange_request',activeState:true,sourceStatus:'PROGRESS'}),'exchange');

  assert.equal(telegramAlertType({source,eventType:'cancel',status:'cancelled',activeState:false,sourceStatus:'COMPLETED'}),'');
  assert.equal(telegramAlertType({source,eventType:'return',status:'returned',activeState:false,sourceStatus:'RETURNS_COMPLETED'}),'');
  assert.equal(telegramAlertType({source,eventType:'exchange',status:'exchanged',activeState:false,sourceStatus:'SUCCESS'}),'');
  assert.equal(telegramAlertType({source,eventType:'cancel',status:'cancel_request',activeState:true,sourceStatus:'WITHDRAWN'}),'');
  assert.equal(telegramAlertType({source,eventType:'return',status:'return_request',activeState:true,sourceStatus:'REJECTED'}),'');
}

assert.equal(telegramAlertType({eventType:'order',status:'new',activeState:true}),'new_order');
assert.equal(telegramAlertType({source:'coupang',eventType:'inquiry',status:'inquiry',activeState:true,sourceStatus:'NOANSWER'}),'inquiry');
assert.equal(telegramAlertType({source:'coupang',eventType:'inquiry',status:'inquiry',activeState:false,answered:true,sourceStatus:'ANSWERED'}),'');
// 쿠팡 고객센터 TRANSFER는 상담 complete 문구가 있어도 판매자 확인이 남은 열린 문의입니다.
assert.equal(telegramAlertType({source:'coupang',eventType:'inquiry',status:'inquiry',activeState:true,sourceStatus:'COMPLETE TRANSFER',partnerCounselingStatus:'TRANSFER'}),'inquiry');

console.log('v7.7.32 terminal claim alert filter contract passed');
