import assert from 'node:assert/strict';
import {coupangTestHelpers} from '../backend/coupang.js';
import {smartstoreTestHelpers} from '../backend/smartstore.js';
import {elevenstTestHelpers} from '../backend/elevenst.js';
import {lotteonTestHelpers} from '../backend/lotteon.js';

{
  const rows=coupangTestHelpers.normalize([{
    orderId:'202607220001',status:'ACCEPT',orderedAt:'2026-07-22T01:00:00Z',
    orderItems:[{vendorItemId:'V1',vendorItemName:'상품',shippingCount:1,orderPrice:110000,discountPrice:10500}]
  }],'ACCEPT');
  assert.equal(rows.length,1);
  assert.equal(rows[0].amount,99500);
  assert.equal(rows[0].discountAmount,10500);
}

{
  const parsed=smartstoreTestHelpers.conditionOrderPage({data:[{productOrderId:'P1'},{productOrderId:'P2'}]});
  assert.equal(parsed.items.length,2);
  assert.equal(smartstoreTestHelpers.productOrderIdOf('P3'),'P3');
}

{
  const source={response:{orders:[
    {ordNo:'20260722001',ordPrdSeq:'1',prdNm:'A',ordQty:'1',prdAmt:'10000',child:{status:'OK'}},
    {ordNo:'20260722002',ordPrdSeq:'1',prdNm:'B',ordQty:'1',prdAmt:'20000',child:{status:'OK'}}
  ]}};
  const rows=elevenstTestHelpers.collectOrderRows(source);
  assert.ok(rows.some(row=>String(row.ordNo)==='20260722001'));
  assert.ok(rows.some(row=>String(row.ordNo)==='20260722002'));
  assert.ok(elevenstTestHelpers.dateFromOrderNumber('20260722001').startsWith('2026-07-22'));
}

{
  const row={
    ordNo:'L1',ordDtlSeq:'1',ordQty:'1',prdNm:'롯데 상품',ordDttm:'20260722120000',
    payment:{finalPayAmt:'39250'},deliveryStatus:'DELIVERED'
  };
  const order=lotteonTestHelpers.normalizeOrder(row,'SELLER');
  assert.equal(order.amount,39250);
  assert.equal(order.orderTotalAmount,39250);
}

console.log('v7.7.18 market recovery tests passed');
