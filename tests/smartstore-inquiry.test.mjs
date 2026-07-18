import assert from 'node:assert/strict';
import { smartstoreTestHelpers as H } from '../backend/smartstore.js';

const product=H.inquiryDoc({
  questionId:101,
  createDate:'2026-07-19T01:00:00+09:00',
  question:'상품 문의',
  answered:false,
  productId:500,
  productName:'상품 A'
},'product');
assert.equal(product.inquiryId,'101');
assert.equal(product.activeState,true);
assert.equal(product.content,'상품 문의');
assert.equal(product.claimKey,'smartstore|inquiry|product-101');

const customer=H.inquiryDoc({
  inquiryNo:202,
  inquiryRegistrationDateTime:'2026-07-19T02:00:00+09:00',
  inquiryContent:'배송 문의',
  answered:false,
  orderId:'N100',
  productNo:'600',
  customerName:'구매자'
},'customer');
assert.equal(customer.inquiryId,'202');
assert.equal(customer.orderNo,'N100');
assert.equal(customer.activeState,true);
assert.equal(customer.content,'배송 문의');
assert.equal(customer.claimKey,'smartstore|inquiry|customer-202');

const answered=H.inquiryDoc({
  inquiryNo:203,
  inquiryRegistrationDateTime:'2026-07-19T02:00:00+09:00',
  inquiryContent:'답변된 문의',
  answered:true,
  answerContent:'답변 완료'
},'customer');
assert.equal(answered.activeState,false);
assert.equal(answered.status,'answered');

assert.deepEqual(H.inquiryPageMeta({contents:[],page:1,totalPages:3,last:false}),{
  totalPages:3,currentPage:1,last:false
});
const ranges=H.inquiryRanges(90,29);
assert.ok(ranges.length>=4);
assert.ok(ranges.every(range=>range.to-range.from<=29*86400000));
assert.match(H.inquiryIso(new Date('2026-07-19T00:00:00.123Z')),/2026-07-19T00:00:00Z/);

console.log('smartstore inquiry tests passed');
