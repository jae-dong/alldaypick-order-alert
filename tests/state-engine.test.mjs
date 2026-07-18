import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code=fs.readFileSync(new URL('../state-engine.js',import.meta.url),'utf8');
const context={console,Intl,Date,globalThis:{}};
context.globalThis=context;
vm.createContext(context);
vm.runInContext(code,context);
const E=context.OrderStateEngine;
assert.ok(E,'OrderStateEngine should load');

const integrations={coupang:{connected:true},smartstore:{connected:true},elevenst:{connected:true},lotteon:{connected:true},gmarket:{connected:false},auction:{connected:false}};
const base={source:'coupang',market:'쿠팡',orderNo:'100',vendorItemId:'A',product:'상품',qty:1,amount:10000,datetime:'2026-07-19T00:00:00+09:00',eventType:'order'};

// Same line must move, not accumulate.
let data=[
  {...base,id:'old',lineKey:'coupang|100|A',status:'new',sourceStatus:'ACCEPT',sourceUpdatedAt:'2026-07-19T00:01:00+09:00'},
  {...base,id:'new',lineKey:'coupang|100|A',status:'shipping_wait',sourceStatus:'INSTRUCT',sourceUpdatedAt:'2026-07-19T00:02:00+09:00'}
];
assert.equal(JSON.stringify(E.counts(data,integrations)),JSON.stringify({new:0,shipping_wait:1,cancel:0,return:0,exchange:0,inquiry:0}));

// Delivery removes the order from pending.
data.push({...base,id:'delivered',lineKey:'coupang|100|A',status:'delivering',sourceStatus:'DELIVERING',sourceUpdatedAt:'2026-07-19T00:03:00+09:00'});
assert.equal(E.pendingOrders(data,integrations).length,0);

// Claim/inquiry is independent from the normal order lifecycle.
data=[
  {...base,id:'order',lineKey:'coupang|100|A',status:'shipping_wait',sourceStatus:'INSTRUCT',sourceUpdatedAt:'2026-07-19T00:02:00+09:00'},
  {source:'coupang',market:'쿠팡',orderNo:'100',eventType:'return',claimKey:'coupang|return|R1',claimId:'R1',status:'return_request',sourceStatus:'UC',activeState:true,datetime:'2026-07-19T00:03:00+09:00'},
  {source:'coupang',market:'쿠팡',orderNo:'100',eventType:'inquiry',claimKey:'coupang|inquiry|Q1',claimId:'Q1',status:'inquiry',sourceStatus:'NOANSWER',activeState:true,datetime:'2026-07-19T00:04:00+09:00'}
];
assert.equal(JSON.stringify(E.counts(data,integrations)),JSON.stringify({new:0,shipping_wait:1,cancel:0,return:1,exchange:0,inquiry:1}));
assert.equal(E.pendingItems(data,integrations).length,3);

// Completed claims disappear, but the order remains.
data.push({source:'coupang',market:'쿠팡',orderNo:'100',eventType:'return',claimKey:'coupang|return|R1',claimId:'R1',status:'returned',sourceStatus:'CC',activeState:false,datetime:'2026-07-19T00:05:00+09:00'});
assert.equal(JSON.stringify(E.counts(data,integrations)),JSON.stringify({new:0,shipping_wait:1,cancel:0,return:0,exchange:0,inquiry:1}));

// Disconnected Gmarket/Auction never enter totals.
data.push({source:'gmarket',market:'G마켓',orderNo:'G1',eventType:'order',lineKey:'gmarket|G1|1',status:'new',sourceStatus:'NEW',activeState:true,datetime:'2026-07-19T00:06:00+09:00'});
assert.equal(E.counts(data,integrations).new,0);

// One order with mixed lines remains pending if any line is pending.
const mixed=[
  {source:'smartstore',market:'스마트스토어',orderNo:'N1',productOrderId:'1',lineKey:'smartstore|N1|1',eventType:'order',status:'delivered',sourceStatus:'DELIVERED',activeState:true,datetime:'2026-07-19T01:00:00+09:00'},
  {source:'smartstore',market:'스마트스토어',orderNo:'N1',productOrderId:'2',lineKey:'smartstore|N1|2',eventType:'order',status:'shipping_wait',sourceStatus:'PRODUCT_PREPARE',activeState:true,datetime:'2026-07-19T01:01:00+09:00'}
];
assert.equal(E.pendingOrders(mixed,integrations).length,1);
assert.equal(E.pendingOrders(mixed,integrations)[0].status,'shipping_wait');


// One claim request with multiple product lines is still one request count.
const multiLineClaim=[
  {source:'coupang',market:'쿠팡',orderNo:'200',eventType:'return',claimId:'R200',claimKey:'coupang|return|R200|A',status:'return_request',sourceStatus:'UC',activeState:true,vendorItemId:'A',sourceUpdatedAt:'2026-07-19T02:00:00+09:00'},
  {source:'coupang',market:'쿠팡',orderNo:'200',eventType:'return',claimId:'R200',claimKey:'coupang|return|R200|B',status:'return_request',sourceStatus:'UC',activeState:true,vendorItemId:'B',sourceUpdatedAt:'2026-07-19T02:00:01+09:00'}
];
assert.equal(E.openClaims(multiLineClaim,integrations).length,1);
assert.equal(E.counts(multiLineClaim,integrations).return,1);

console.log('state-engine tests passed');
assert.equal(E.terminalClaim({eventType:'cancel',sourceStatus:'CANCEL_DONE'}),true);
assert.equal(E.terminalClaim({eventType:'return',sourceStatus:'RETURN_REQUEST'}),false);
