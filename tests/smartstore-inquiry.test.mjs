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

const customerRange={
  from:new Date('2026-07-12T00:00:00+09:00'),
  to:new Date('2026-07-18T23:59:59+09:00')
};
const profiles=H.customerInquiryProfiles(customerRange);
const normalParams=profiles[0](1,200);
assert.equal(normalParams.startSearchDate,'2026-07-12');
assert.equal(normalParams.endSearchDate,'2026-07-18');
assert.equal(normalParams.page,'1');
assert.equal(normalParams.size,'200');
assert.equal(normalParams.answered,'false');
const typoCompatible=profiles[1](2,200);
assert.equal(typoCompatible.pgae,'2');
assert.equal(H.inquiryDateOnly(new Date('2026-07-18T16:00:00Z')),'2026-07-19');

console.log('smartstore inquiry tests passed');

const confirmedStatus=H.orderStatus({productOrderStatus:'PAYED',placeOrderStatus:'OK',placeOrderDate:'2026-07-19T10:00:00+09:00'});
assert.deepEqual(confirmedStatus,['shipping_wait','발송대기']);
const unconfirmedStatus=H.orderStatus({productOrderStatus:'PAYED',placeOrderStatus:'NOT_YET'});
assert.deepEqual(unconfirmedStatus,['new','신규주문']);

const currentClaimDocs=H.normalizeDetail({
  order:{orderId:'N-CLAIM',paymentDate:'2026-07-19T01:00:00+09:00'},
  productOrder:{
    productOrderId:'P-CLAIM',productOrderStatus:'PAYED',placeOrderStatus:'OK',
    productName:'상품',quantity:1,totalPaymentAmount:10000
  },
  currentClaim:{
    return:{claimId:'R-CURRENT',claimStatus:'RETURN_REJECT',claimRequestDate:'2026-07-19T02:00:00+09:00'}
  },
  return:{claimId:'R-LEGACY',claimStatus:'RETURN_REQUEST'}
});
assert.equal(currentClaimDocs.filter(item=>item.eventType==='return').length,1,'currentClaim must prevent deprecated duplicate claims');
assert.equal(currentClaimDocs.find(item=>item.eventType==='return').activeState,false,'RETURN_REJECT must be terminal');
