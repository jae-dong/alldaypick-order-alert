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



const inquiryBody=telegramOrderBody({
  eventType:'inquiry',
  product:'문의 상품',
  reason:'배송',
  content:'언제 출고되나요?\n빠른 확인 부탁드립니다.'
});
assert.match(inquiryBody,/📂 문의유형: 배송/);
assert.match(inquiryBody,/💬 문의내용: \[고객문의\] 언제 출고되나요\?/);
assert.match(inquiryBody,/빠른 확인 부탁드립니다/);

const returnBody=telegramOrderBody({
  eventType:'return',
  product:'반품 상품',
  reason:'상품 파손',
  reasonDetail:'박스 안에서 내용물이 깨져 있었습니다.'
});
assert.match(returnBody,/↩️ 반품사유: 상품 파손/);
assert.match(returnBody,/📝 상세사유: 박스 안에서 내용물이 깨져 있었습니다/);

const exchangeBody=telegramOrderBody({
  eventType:'exchange',
  product:'교환 상품',
  reason:'옵션 변경',
  reasonDetail:'M 사이즈를 L 사이즈로 바꿔 주세요.'
});
assert.match(exchangeBody,/🔄 교환사유: 옵션 변경/);
assert.match(exchangeBody,/M 사이즈를 L 사이즈로 바꿔 주세요/);

console.log('telegram-format tests passed');
