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
const base={source:'coupang',market:'쿠팡',orderNo:'100',vendorItemId:'A',product:'상품',qty:1,amount:10000,datetime:'2026-07-19T00:00:00+09:00',eventType:'order',activeState:true};

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
  {source:'coupang',market:'쿠팡',orderNo:'100',eventType:'inquiry',claimKey:'coupang|inquiry|Q1',claimId:'Q1',status:'inquiry',sourceStatus:'NOANSWER',activeState:true,stateVerifiedAt:new Date().toISOString(),datetime:'2026-07-19T00:04:00+09:00'}
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


// Legacy Coupang exchange documents may store the source name in Korean.
// Unknown/old exchange states must not remain in the current counter.
assert.equal(E.terminalClaim({source:'쿠팡',market:'쿠팡',eventType:'exchange',sourceStatus:'EXCHANGE_REQUEST',activeState:true}),true);
assert.equal(E.terminalClaim({source:'쿠팡',market:'쿠팡',eventType:'exchange',exchangeStatus:'PROGRESS',activeState:true}),false);

console.log('state-engine tests passed');
assert.equal(E.terminalClaim({eventType:'cancel',sourceStatus:'CANCEL_DONE'}),true);
assert.equal(E.terminalClaim({eventType:'return',sourceStatus:'RETURN_REQUEST'}),false);

// Pending workflow counters use product-order lines, while sales amount keeps orderNo grouping.
// A single combined-shipping invoice with two different products must count as two processed orders.
const coupangBoxes=[
  {source:'coupang',market:'쿠팡',orderNo:'C100',shipmentBoxId:'B1',vendorItemId:'I1',lineKey:'coupang|C100|I1',eventType:'order',status:'shipping_wait',sourceStatus:'INSTRUCT',activeState:true,sourceUpdatedAt:'2026-07-19T03:00:00+09:00'},
  {source:'coupang',market:'쿠팡',orderNo:'C100',shipmentBoxId:'B2',vendorItemId:'I2',lineKey:'coupang|C100|I2',eventType:'order',status:'shipping_wait',sourceStatus:'INSTRUCT',activeState:true,sourceUpdatedAt:'2026-07-19T03:00:01+09:00'}
];
assert.equal(E.pendingOrders(coupangBoxes,integrations).length,2,'two Coupang product-order lines must be two processing tasks');
assert.equal(E.salesGroups(coupangBoxes,integrations).length,1,'the same order number must remain one sales order');

const coupangCombinedShipping=[
  {source:'coupang',market:'쿠팡',orderNo:'C200',shipmentBoxId:'SAME-BOX',vendorItemId:'ITEM-A',lineKey:'coupang|C200|ITEM-A',eventType:'order',status:'shipping_wait',sourceStatus:'INSTRUCT',activeState:true,sourceUpdatedAt:'2026-07-19T03:01:00+09:00'},
  {source:'coupang',market:'쿠팡',orderNo:'C200',shipmentBoxId:'SAME-BOX',vendorItemId:'ITEM-B',lineKey:'coupang|C200|ITEM-B',eventType:'order',status:'shipping_wait',sourceStatus:'INSTRUCT',activeState:true,sourceUpdatedAt:'2026-07-19T03:01:01+09:00'}
];
assert.equal(E.pendingOrders(coupangCombinedShipping,integrations).length,2,'one invoice with two different products must count as two product orders');
assert.equal(E.salesUnits(coupangCombinedShipping,integrations).length,2,'today/month order count must use product-order lines, not shipmentBoxId');

const coupangDuplicateLine=[
  ...coupangCombinedShipping,
  {...coupangCombinedShipping[0],sourceUpdatedAt:'2026-07-19T03:02:00+09:00'}
];
assert.equal(E.salesUnits(coupangDuplicateLine,integrations).length,2,'the same product-order line collected twice must be deduplicated');

const coupangQuantityTwo=[
  {source:'coupang',market:'쿠팡',orderNo:'C300',shipmentBoxId:'QTY-BOX',vendorItemId:'ITEM-Q',lineKey:'coupang|C300|ITEM-Q',eventType:'order',status:'shipping_wait',sourceStatus:'INSTRUCT',activeState:true,qty:2,sourceUpdatedAt:'2026-07-19T03:03:00+09:00'}
];
assert.equal(E.salesUnits(coupangQuantityTwo,integrations).length,1,'quantity two in one product-order line must remain one order count');

// Naver PAYED becomes shipping-wait after seller confirmation.
const naverConfirmed=[{
  source:'smartstore',market:'스마트스토어',orderNo:'N200',productOrderId:'P200',
  lineKey:'smartstore|N200|P200',eventType:'order',status:'new',sourceStatus:'PAYED',
  placeOrderStatus:'OK',placeOrderDate:'2026-07-19T03:10:00+09:00',activeState:true
}];
assert.equal(E.counts(naverConfirmed,integrations).shipping_wait,1);
assert.equal(E.counts(naverConfirmed,integrations).new,0);

// Rejected/withdrawn claims must not remain in unresolved counters.
assert.equal(E.terminalClaim({eventType:'return',sourceStatus:'RETURN_REJECT'}),true);
assert.equal(E.terminalClaim({eventType:'exchange',sourceStatus:'EXCHANGE_REJECT'}),true);

// Regression fixture for the 2026-07-19 connected-market comparison.
const regression=[];
for(let i=0;i<11;i++) regression.push({source:'coupang',market:'쿠팡',orderNo:`CN${i}`,shipmentBoxId:`CBN${i}`,vendorItemId:`CNI${i}`,lineKey:`coupang|CN${i}|CNI${i}`,eventType:'order',status:'new',sourceStatus:'ACCEPT',activeState:true,sourceUpdatedAt:`2026-07-19T04:${String(i).padStart(2,'0')}:00+09:00`});
for(let i=0;i<32;i++) regression.push({source:'coupang',market:'쿠팡',orderNo:`CW${Math.floor(i/2)}`,shipmentBoxId:`CBW${i}`,vendorItemId:`CWI${i}`,lineKey:`coupang|CW${Math.floor(i/2)}|CWI${i}`,eventType:'order',status:'shipping_wait',sourceStatus:'INSTRUCT',activeState:true,sourceUpdatedAt:`2026-07-19T05:${String(i%60).padStart(2,'0')}:00+09:00`});
for(let i=0;i<2;i++) regression.push({source:'smartstore',market:'스마트스토어',orderNo:`NN${i}`,productOrderId:`NPN${i}`,lineKey:`smartstore|NN${i}|NPN${i}`,eventType:'order',status:'new',sourceStatus:'PAYED',placeOrderStatus:'NOT_YET',activeState:true});
for(let i=0;i<10;i++) regression.push({source:'smartstore',market:'스마트스토어',orderNo:`NW${i}`,productOrderId:`NPW${i}`,lineKey:`smartstore|NW${i}|NPW${i}`,eventType:'order',status:'new',sourceStatus:'PAYED',placeOrderStatus:'OK',placeOrderDate:'2026-07-19T05:30:00+09:00',activeState:true});
regression.push({source:'elevenst',market:'11번가',orderNo:'E1',orderProductSequence:'1',lineKey:'elevenst|E1|1',eventType:'order',status:'shipping_wait',sourceStatus:'ORDER_CONFIRMED',activeState:true});
regression.push({source:'coupang',market:'쿠팡',eventType:'return',claimId:'CR1',claimKey:'coupang|return|CR1',sourceStatus:'UC',activeState:true});
regression.push({source:'smartstore',market:'스마트스토어',eventType:'return',claimId:'NR1',claimKey:'smartstore|return|NR1',sourceStatus:'RETURN_REQUEST',activeState:true});
regression.push({source:'smartstore',market:'스마트스토어',eventType:'exchange',claimId:'NE1',claimKey:'smartstore|exchange|NE1',sourceStatus:'EXCHANGE_REQUEST',activeState:true});
for(let i=0;i<3;i++) regression.push({source:i===0?'coupang':'smartstore',market:i===0?'쿠팡':'스마트스토어',eventType:'inquiry',claimId:`Q${i}`,claimKey:`${i===0?'coupang':'smartstore'}|inquiry|Q${i}`,sourceStatus:'NOANSWER',activeState:true,stateVerifiedAt:new Date().toISOString()});
assert.equal(JSON.stringify(E.counts(regression,integrations)),JSON.stringify({new:13,shipping_wait:43,cancel:0,return:2,exchange:1,inquiry:3}));

// Current-only guard: documents without an explicit activeState are historical/cache data.
const legacyNoActive={...base,id:'legacy-no-active',status:'new',sourceStatus:'ACCEPT'};
delete legacyNoActive.activeState;
assert.equal(E.pendingItems([legacyNoActive],integrations).length,0);

// 2026-07-20 ShopMoa comparison fixture (Gmarket/Auction disconnected).
const liveComparison=[];
for(let i=0;i<2;i++) liveComparison.push({source:'coupang',market:'쿠팡',orderNo:`LCN${i}`,shipmentBoxId:`LCNB${i}`,vendorItemId:`LCNI${i}`,eventType:'order',status:'new',sourceStatus:'ACCEPT',activeState:true,sourceUpdatedAt:`2026-07-20T10:0${i}:00+09:00`});
for(let i=0;i<20;i++) liveComparison.push({source:'coupang',market:'쿠팡',orderNo:`LCW${i}`,shipmentBoxId:`LCWB${i}`,vendorItemId:`LCWI${i}`,eventType:'order',status:'shipping_wait',sourceStatus:'INSTRUCT',activeState:true,sourceUpdatedAt:`2026-07-20T10:${String(i+10).padStart(2,'0')}:00+09:00`});
for(let i=0;i<2;i++) liveComparison.push({source:'smartstore',market:'스마트스토어',orderNo:`LSN${i}`,productOrderId:`LSNP${i}`,eventType:'order',status:'new',sourceStatus:'PAYED',placeOrderStatus:'NOT_YET',activeState:true,sourceUpdatedAt:`2026-07-20T10:3${i}:00+09:00`});
for(let i=0;i<5;i++) liveComparison.push({source:'smartstore',market:'스마트스토어',orderNo:`LSW${i}`,productOrderId:`LSWP${i}`,eventType:'order',status:'shipping_wait',sourceStatus:'PAYED',placeOrderStatus:'OK',activeState:true,sourceUpdatedAt:`2026-07-20T10:4${i}:00+09:00`});
for(let i=0;i<4;i++) liveComparison.push({source:'elevenst',market:'11번가',orderNo:`LEW${i}`,orderProductSequence:'1',eventType:'order',status:'shipping_wait',sourceStatus:'ORDER_CONFIRMED',activeState:true,sourceUpdatedAt:`2026-07-20T10:5${i}:00+09:00`});
liveComparison.push({source:'coupang',market:'쿠팡',eventType:'return',claimId:'LCR1',sourceStatus:'UC',activeState:true});
liveComparison.push({source:'coupang',market:'쿠팡',eventType:'return',claimId:'LCR2',sourceStatus:'PR',activeState:true});
liveComparison.push({source:'smartstore',market:'스마트스토어',eventType:'exchange',claimId:'LSE1',sourceStatus:'EXCHANGE_REQUEST',activeState:true});
liveComparison.push({source:'coupang',market:'쿠팡',eventType:'exchange',claimId:'OLD-CEX',sourceStatus:'EXCHANGE_REQUEST',activeState:true});
liveComparison.push({source:'coupang',market:'쿠팡',eventType:'inquiry',claimId:'LCQ1',sourceStatus:'NOANSWER',activeState:true,stateVerifiedAt:new Date().toISOString()});
liveComparison.push({source:'gmarket',market:'G마켓',orderNo:'G-EXCLUDED',eventType:'order',status:'new',sourceStatus:'NEW',activeState:true});
assert.equal(JSON.stringify(E.counts(liveComparison,integrations)),JSON.stringify({new:4,shipping_wait:29,cancel:0,return:2,exchange:1,inquiry:1}));


// Smartstore gifts waiting for recipient acceptance are not actionable orders or sales.
const giftPending=[{
  source:'smartstore',market:'스마트스토어',orderNo:'GIFT-WAIT',productOrderId:'GP1',
  eventType:'order',status:'gift_wait',sourceStatus:'PAYED',giftReceivingStatus:'WAIT_FOR_RECEIVING',
  giftPending:true,excludedFromMetrics:true,activeState:false,amount:30000,datetime:'2026-07-21T09:00:00+09:00'
}];
assert.equal(E.pendingItems(giftPending,integrations).length,0);
assert.equal(E.salesGroups(giftPending,integrations).length,0);

const giftAccepted=[{
  source:'smartstore',market:'스마트스토어',orderNo:'GIFT-OK',productOrderId:'GP2',
  eventType:'order',status:'new',sourceStatus:'PAYED',giftReceivingStatus:'RECEIVED',
  giftPending:false,excludedFromMetrics:false,activeState:true,amount:30000,datetime:'2026-07-21T09:10:00+09:00'
}];
assert.equal(E.pendingItems(giftAccepted,integrations).length,1);
assert.equal(E.salesGroups(giftAccepted,integrations).length,1);

{
  const oldReceipt={
    id:'old-coupang-exchange',source:'coupang',market:'쿠팡',eventType:'exchange',activeState:true,
    exchangeStatus:'RECEIPT',claimId:'OLD',claimRequestedAt:new Date(Date.now()-8*24*60*60*1000).toISOString()
  };
  const recentReceipt={
    id:'recent-coupang-exchange',source:'coupang',market:'쿠팡',eventType:'exchange',activeState:true,
    exchangeStatus:'RECEIPT',claimId:'NEW',claimRequestedAt:new Date(Date.now()-2*24*60*60*1000).toISOString()
  };
  const claims=E.openClaims([oldReceipt,recentReceipt],{coupang:{connected:true}});
  assert.equal(JSON.stringify(claims.map(item=>item.id).sort()),JSON.stringify(['old-coupang-exchange','recent-coupang-exchange']),'official RECEIPT remains open until Coupang changes the exchange status');
}

// A zero-valued total alias must not hide a valid line amount.
{
  const priced=[{
    source:'coupang',market:'쿠팡',orderNo:'PRICE-1',vendorItemId:'P1',
    eventType:'order',status:'new',activeState:true,
    orderTotalAmount:0,amount:15900,qty:1,datetime:'2026-07-22T09:00:00+09:00'
  }];
  assert.equal(E.salesGroups(priced,integrations)[0].amount,15900);
}

// When only a unit price exists, the engine must calculate unit price × quantity.
{
  const priced=[{
    source:'elevenst',market:'11번가',orderNo:'PRICE-2',orderProductSequence:'1',
    eventType:'order',status:'shipping_wait',activeState:true,
    amount:0,unitPrice:7200,qty:3,datetime:'2026-07-22T09:10:00+09:00'
  }];
  assert.equal(E.salesGroups(priced,integrations)[0].amount,21600);
}


// Coupang's official exchange state takes priority over replacement-delivery completion.
assert.equal(E.terminalClaim({source:'coupang',market:'쿠팡',eventType:'exchange',exchangeStatus:'PROGRESS',targetItemDeliveryComplete:true,activeState:true}),false);

// Only recently verified Smartstore/Coupang inquiry documents count as current work.
{
  const now=Date.now();
  const inquiryDocs=[
    {id:'fresh-coupang-q',source:'coupang',market:'쿠팡',eventType:'inquiry',claimId:'Q1',status:'inquiry',activeState:true,stateVerifiedAt:new Date(now-30*60*1000).toISOString()},
    {id:'stale-smart-q',source:'smartstore',market:'스마트스토어',eventType:'inquiry',claimId:'Q2',status:'inquiry',activeState:true,stateVerifiedAt:new Date(now-6*60*60*1000).toISOString()}
  ];
  assert.equal(E.openClaims(inquiryDocs,integrations).length,1);
  assert.equal(E.openClaims(inquiryDocs,integrations)[0].id,'fresh-coupang-q');
}

// Sales order count uses each marketplace's product-order line, never invoice/shipment count.
{
  const units=[
    {source:'coupang',market:'쿠팡',orderNo:'UNIT-C',shipmentBoxId:'BOX-1',vendorItemId:'A',eventType:'order',status:'shipping_wait',activeState:true,amount:1000,datetime:'2026-07-22T10:00:00+09:00'},
    {source:'coupang',market:'쿠팡',orderNo:'UNIT-C',shipmentBoxId:'BOX-1',vendorItemId:'B',eventType:'order',status:'shipping_wait',activeState:true,amount:2000,datetime:'2026-07-22T10:01:00+09:00'},
    {source:'smartstore',market:'스마트스토어',orderNo:'UNIT-N',productOrderId:'PO-1',eventType:'order',status:'new',activeState:true,amount:3000,datetime:'2026-07-22T10:02:00+09:00'},
    {source:'gmarket',market:'G마켓',orderNo:'EXCLUDED',eventType:'order',status:'new',activeState:true,amount:4000,datetime:'2026-07-22T10:03:00+09:00'}
  ];
  assert.equal(E.salesGroups(units,integrations).length,2,'sales amount grouping stays at marketplace order level');
  assert.equal(E.salesUnits(units,integrations).length,3,'order count uses two Coupang product-order lines sharing one invoice plus one Smartstore product order');
}

// Product-line amounts win over a repeated order total so combined shipping is not overcounted.
{
  const lines=[
    {source:'smartstore',market:'스마트스토어',orderNo:'AMT-1',productOrderId:'P1',eventType:'order',status:'delivered',activeState:false,amount:12000,orderTotalAmount:30000,metricDate:'2026-07-22T11:00:00+09:00'},
    {source:'smartstore',market:'스마트스토어',orderNo:'AMT-1',productOrderId:'P2',eventType:'order',status:'delivered',activeState:false,amount:18000,orderTotalAmount:30000,metricDate:'2026-07-22T11:01:00+09:00'}
  ];
  assert.equal(E.salesUnits(lines,integrations).length,2);
  assert.equal(E.salesGroups(lines,integrations)[0].amount,30000);
  assert.equal(E.salesGroups(lines,integrations)[0].day,'2026-07-22');
}

// A repeated order total is used once only when the API provides no line amounts.
{
  const lines=[
    {source:'lotteon',market:'롯데온',orderNo:'AMT-2',orderItemId:'L1',eventType:'order',status:'delivered',activeState:false,amount:0,orderTotalAmount:39250,metricDate:'2026-07-22T12:00:00+09:00'},
    {source:'lotteon',market:'롯데온',orderNo:'AMT-2',orderItemId:'L2',eventType:'order',status:'delivered',activeState:false,amount:0,orderTotalAmount:39250,metricDate:'2026-07-22T12:01:00+09:00'}
  ];
  assert.equal(E.salesGroups(lines,integrations)[0].amount,39250);
}
