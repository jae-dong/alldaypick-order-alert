import assert from 'node:assert/strict';
import { lotteonTestHelpers as H } from '../backend/lotteon.js';

const nested={
  returnCode:'0000',
  data:[{
    ordNo:'LO-100',
    ordDttm:'20260721090000',
    items:[{sitmNo:'S-1',spdNm:'롯데온 테스트 상품',ordQty:1,payAmt:12345}]
  }]
};
const rows=H.collectRecords(nested);
assert.equal(rows.length,1);
assert.equal(rows[0].ordNo,'LO-100');
assert.equal(rows[0].sitmNo,'S-1');
const order=H.normalizeOrder(rows[0],'SELLER');
assert.equal(order.orderNo,'LO-100');
assert.equal(order.status,'shipping_wait');
assert.equal(order.activeState,true);
assert.equal(H.splitDateWindows(7*24*60).length,3);
assert.equal(H.productImageFromResponse({data:{spdImgList:[{imgUrl:'https://contents.lotteon.com/a.jpg'}]}}),'https://contents.lotteon.com/a.jpg');

const progressNested={
  data:{orderInfos:[{
    orderNumber:'LO-200',orderDateTime:'20260721100000',
    deliveryProgressList:[{deliveryOrderNo:'D-1',productId:'P-1',productTitle:'진행상품',deliveryStatus:'상품준비'}]
  }]}
};
const progressRows=H.collectRecords(progressNested);
assert.equal(progressRows.length,1);
assert.equal(progressRows[0].orderNumber,'LO-200');
assert.equal(progressRows[0].productId,'P-1');
assert.equal(H.normalizeOrder(progressRows[0],'SELLER').status,'shipping_wait');
console.log('lotteon status tests passed');

{
  const originalFetch=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async (url,options={})=>{
    calls.push(String(url));
    return new Response(JSON.stringify({returnCode:'0000',data:[]}),{status:200,headers:{'content-type':'application/json'}});
  };
  try{
    const result=await H.queryOrderInstructions({apiKey:'test',sellerId:'SELLER'},30,{repair:false});
    assert.equal(result.instructionComplete,true);
    assert.equal(result.progressComplete,true);
    assert.ok(calls.some(url=>url.includes('SellerDeliveryOrdersSearch')));
    assert.ok(calls.some(url=>url.includes('SellerDeliveryProgressStateSearch')),'progress API must run every cycle to remove stale shipping rows');
  }finally{
    globalThis.fetch=originalFetch;
  }
}

const instructionOrder=H.normalizeOrder({
  __lotteonFeed:'instruction',ordNo:'LO-MERGE',ordDtlSeq:'1',dlvNo:'D-OLD',sitmNo:'S-10',
  spdNm:'상태대조 상품',ordQty:2,payAmt:22000,dlvStsNm:'출고지시',ordDttm:'20260722090000'
},'SELLER');
const deliveredOrder=H.normalizeOrder({
  __lotteonFeed:'progress',ordNo:'LO-MERGE',ordDtlSeq:'1',dlvNo:'D-NEW',sitmNo:'S-10',
  dlvStsNm:'배송완료',updDttm:'20260722130000'
},'SELLER');
assert.equal(instructionOrder.id,deliveredOrder.id,'stable order line ID must not depend on changing delivery number');
const mergedOrders=H.mergeLotteonOrders([instructionOrder],[deliveredOrder]);
assert.equal(mergedOrders.length,1);
assert.equal(mergedOrders[0].status,'delivered','progress state must override stale instruction state');
assert.equal(mergedOrders[0].amount,22000,'instruction amount must be preserved when progress payload omits price');
assert.equal(mergedOrders[0].product,'상태대조 상품','instruction product name must be preserved');


const unknownProgress=H.normalizeOrder({
  __lotteonFeed:'progress',ordNo:'LO-UNKNOWN-PROGRESS',ordDtlSeq:'1',sitmNo:'S-U',
  deliveryOrderNo:'D-U',updDttm:'20260722150000'
},'SELLER');
assert.equal(unknownProgress.status,'delivering','a row returned by the delivery-progress API must not fall back to stale shipping_wait');
