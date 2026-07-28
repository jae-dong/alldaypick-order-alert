import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {isClaimTerminal} from '../backend/workflow-model.js';
import {telegramOrderBody} from '../backend/telegram-format.js';

assert.equal(isClaimTerminal({
  source:'coupang',eventType:'inquiry',inquiryKind:'call_center_confirm',
  sourceStatus:'TRANSFER',inquiryStatus:'complete',activeState:true
}),false,'TRANSFER must remain open until seller confirmation');
assert.equal(isClaimTerminal({
  source:'coupang',eventType:'inquiry',inquiryKind:'call_center_answer',
  sourceStatus:'NO_ANSWER',inquiryStatus:'progress',activeState:true
}),false,'NO_ANSWER must remain open until seller answer');
assert.equal(isClaimTerminal({
  source:'coupang',eventType:'inquiry',inquiryKind:'product',
  sourceStatus:'NOANSWER',activeState:true
}),false,'customer product inquiry must remain open until answered');
assert.equal(isClaimTerminal({
  source:'coupang',eventType:'inquiry',sourceStatus:'ANSWER',activeState:true
}),true,'answered inquiry must be terminal');

const stateCode=fs.readFileSync(new URL('../state-engine.js',import.meta.url),'utf8');
const context={console,Intl,Date,globalThis:{}};context.globalThis=context;
vm.createContext(context);vm.runInContext(stateCode,context);
assert.equal(context.OrderStateEngine.terminalClaim({
  source:'coupang',market:'쿠팡',eventType:'inquiry',sourceStatus:'TRANSFER',
  inquiryStatus:'complete',activeState:true
}),false);

const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const agent=fs.readFileSync(new URL('../backend/local-agent.js',import.meta.url),'utf8');
const coupang=fs.readFileSync(new URL('../backend/coupang-inquiries.js',import.meta.url),'utf8');
assert.match(app,/return String\(order\.inquiryId\|\|order\.questionId/,'inquiry action must copy inquiry ID first');
assert.match(app,/고객센터 확인/);
assert.match(app,/고객문의 답변/);
assert.match(coupang,/inquiryChannel:'customer'/);
assert.match(coupang,/inquiryChannel:'call_center'/);
assert.match(coupang,/coupangInquiryStatus:rawInquiryStatus/);
assert.match(agent,/쿠팡 고객센터 문의 · 확인 필요/);
assert.match(agent,/쿠팡 고객문의/);

const customerBody=telegramOrderBody({eventType:'inquiry',inquiryKind:'product',content:'상품 질문'});
assert.match(customerBody,/문의구분: 쿠팡 고객문의/);
assert.match(customerBody,/\[고객문의\] 상품 질문/);
const centerBody=telegramOrderBody({
  eventType:'inquiry',inquiryKind:'call_center_confirm',sourceStatus:'TRANSFER',
  content:'고객센터 접수 내용',counselorContent:'판매자 확인 요청'
});
assert.match(centerBody,/문의구분: 쿠팡 고객센터 문의/);
assert.match(centerBody,/상담사 전달: 판매자 확인 요청/);
assert.match(centerBody,/처리방법: 판매자 확인 필요/);
console.log('v7.7.31 Coupang dual inquiry contract passed');
