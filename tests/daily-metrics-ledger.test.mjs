import assert from 'node:assert/strict';
import {buildDailySnapshot,dailyMetricsTestHelpers} from '../backend/daily-metrics-ledger.js';

const day='2026-07-22';
const base={datetime:'2026-07-22T03:00:00.000Z',status:'delivered'};
const rows=[
  {...base,id:'c1',source:'coupang',market:'쿠팡',orderNo:'A',line:'1',product:'상품A',qty:1,amount:6000,orderTotalAmount:10000},
  {...base,id:'c2',source:'coupang',market:'쿠팡',orderNo:'A',line:'2',product:'상품B',qty:1,amount:6000,orderTotalAmount:10000},
  {...base,id:'s1',source:'smartstore',market:'스마트스토어',orderNo:'B',line:'P1',product:'선물',qty:1,amount:9000,excludedFromMetrics:true},
  {...base,id:'e1',source:'elevenst',market:'11번가',orderNo:'20260722-X',line:'1',product:'상품C',qty:2,amount:8000,orderTotalAmount:8000}
];
const snapshot=buildDailySnapshot(rows,{day,generatedAt:'2026-07-22T04:00:00.000Z'});
assert.equal(snapshot.count,3,'합배송이어도 상품주문 행 2개와 11번가 1개를 각각 계산해야 합니다.');
assert.equal(snapshot.markets.쿠팡.count,2);
assert.equal(snapshot.markets.스마트스토어.count,0,'선물하기 미수락은 제외해야 합니다.');
assert.equal(snapshot.markets['11번가'].count,1);
assert.equal(snapshot.markets.쿠팡.sales,10000,'반복된 주문 총액보다 상품행 합계가 크면 주문 총액으로 보정해야 합니다.');
assert.equal(snapshot.sales,18000);

const compact=dailyMetricsTestHelpers.compactRow({
  source:'elevenst',market:'11번가',eventType:'order',orderNo:'20260722-ABC',
  orderProductSequence:'7',amount:12000,qty:1,product:'복구상품'
},'elevenst');
assert.equal(compact.id,'elevenst|20260722-abc|7');
assert.equal(compact.datetime.slice(0,10),'2026-07-22');

console.log('v7.7.18 daily metrics ledger tests passed');
