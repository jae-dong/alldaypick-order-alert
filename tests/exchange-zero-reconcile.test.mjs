import assert from 'node:assert/strict';
import { smartstoreTestHelpers as H } from '../backend/smartstore.js';

const old=H.normalizeDetail({
  productOrder:{
    productOrderId:'P-OLD',orderId:'O-OLD',productOrderStatus:'PAYED',
    productName:'old',quantity:1,
    exchange:{exchangeRequestId:'E-OLD',claimStatus:'EXCHANGE_REQUEST',requestDate:'2026-07-25T20:00:00+09:00'}
  }
});
const oldExchange=old.find(item=>item.eventType==='exchange');
assert.ok(oldExchange);
assert.equal(oldExchange.activeState,false,'기준선 이전 스마트스토어 교환은 완료 처리되어야 합니다.');

const recent=H.normalizeDetail({
  productOrder:{
    productOrderId:'P-NEW',orderId:'O-NEW',productOrderStatus:'PAYED',productName:'new',quantity:1,
    currentClaim:{exchange:{exchangeRequestId:'E-NEW',claimStatus:'EXCHANGE_REQUEST',requestDate:'2026-07-26T01:10:00+09:00'}}
  }
});
const recentExchange=recent.find(item=>item.eventType==='exchange');
assert.ok(recentExchange);
assert.equal(recentExchange.activeState,true,'기준선 이후 새 스마트스토어 교환은 정상 표시되어야 합니다.');
console.log('exchange zero reconcile tests passed');
