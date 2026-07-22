import assert from 'node:assert/strict';
import {
  formatTelegramOrderDate,
  telegramOrderBody
} from '../backend/telegram-format.js';

assert.equal(
  formatTelegramOrderDate({
    eventType:'order',
    orderDate:'2026-07-19T13:45:20+09:00'
  }),
  '2026-07-19 13:45'
);

assert.equal(
  formatTelegramOrderDate({
    eventType:'order',
    datetime:'20260719140530'
  }),
  '2026-07-19 14:05'
);

assert.equal(
  formatTelegramOrderDate({
    eventType:'order',
    orderedAt:{toDate:()=>new Date('2026-07-19T01:02:00.000Z')}
  }),
  '2026-07-19 10:02'
);

assert.equal(
  formatTelegramOrderDate({
    eventType:'return',
    datetime:'2026-07-19T13:45:20+09:00'
  }),
  '',
  'claim timestamp must not be mislabeled as order timestamp'
);

const body=telegramOrderBody({
  eventType:'order',
  product:'테스트 상품',
  qty:2,
  amount:12300,
  buyer:'홍길동',
  orderNo:'ORDER-1',
  paymentDate:'2026-07-19 18:22:10'
});

assert.match(body,/🕒 주문일시: 2026-07-19 18:22/);
assert.match(body,/🧾 주문번호: ORDER-1/);


const fallbackBody=telegramOrderBody({
  eventType:'order',
  product:'금액 대체 상품',
  qty:3,
  amount:0,
  orderTotalAmount:0,
  unitPrice:7200
});
assert.match(fallbackBody,/💰 금액: 21,600원/,'Telegram amount must fall back to unit price × quantity');

console.log('telegram-format tests passed');
