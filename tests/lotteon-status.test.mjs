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
console.log('lotteon status tests passed');
