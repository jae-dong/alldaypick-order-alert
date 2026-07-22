import assert from 'node:assert/strict';
import { parentOrderContextTestHelpers as helpers } from '../backend/parent-order-context.js';

assert.equal(
  helpers.positiveMoney(0,'',null,'12,300'),
  12300,
  'zero aliases must not hide a later valid amount'
);

const parent={
  id:'coupang-123-456',
  orderNo:'123',
  vendorItemId:'456',
  product:'정상 상품명',
  amount:21900,
  imageUrl:'https://example.com/product.jpg',
  sellerProductId:'789'
};
const claim={
  id:'coupang-return-r1-456',
  eventType:'return',
  orderNo:'123',
  vendorItemId:'456',
  product:'반품요청 상품',
  amount:0
};
assert.ok(helpers.relatedScore(claim,parent)>1000,'order number and vendor item must strongly match');
const merged=helpers.mergeParentContext(claim,parent);
assert.equal(merged.product,'정상 상품명');
assert.equal(merged.amount,21900);
assert.equal(merged.imageUrl,'https://example.com/product.jpg');
assert.equal(merged.sellerProductId,'789');
assert.equal(merged.eventType,'return');

const unrelated={orderNo:'999',vendorItemId:'456',product:'정상 상품명'};
assert.equal(helpers.relatedScore(claim,unrelated),-1,'different order numbers must never link');

console.log('parent-order-context tests passed');
