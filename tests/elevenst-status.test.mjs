import assert from 'node:assert/strict';
import { elevenstTestHelpers as H } from '../backend/elevenst.js';

assert.equal(H.mapElevenOrderStatus({ordPrdStatNm:'배송중',invoiceNo:'123'}).status,'delivering');
assert.equal(H.mapElevenOrderStatus({ordPrdStat:'COMPLETE'}).status,'shipping_wait');
assert.equal(H.mapElevenOrderStatus({ordPrdStatNm:'결제완료'}).status,'new');
assert.equal(H.mapElevenOrderStatus({ordNo:'1'}).status,'shipping_wait');

const rows=H.collectRows({
  response:{
    order:{
      ordNo:'100',
      products:{product:{ordPrdSeq:'1',ordPrdStatNm:'배송중',invoiceNo:'ABC'}}
    }
  }
});
assert.equal(rows.length,1);
assert.equal(rows[0].ordNo,'100');
assert.equal(rows[0].ordPrdSeq,'1');
assert.equal(H.mapElevenOrderStatus(rows[0]).status,'delivering');
console.log('elevenst status tests passed');
