import { isClaimTerminal } from './workflow-model.js';

const CLAIM_ALERT_TYPES=new Set(['cancel','return','exchange','inquiry']);

function classifyTelegramType(order={}){
  const eventType=String(order?.eventType||'order').trim().toLowerCase();
  const status=String(order?.status||'').trim().toLowerCase();

  if(eventType==='order') return 'new_order';
  if(eventType==='cancel'||status==='cancel'||status==='cancel_request') return 'cancel';
  if(eventType==='return'||status==='return'||status==='return_request') return 'return';
  if(eventType==='exchange'||status==='exchange'||status==='exchange_request') return 'exchange';
  if(eventType==='inquiry'||status==='inquiry') return 'inquiry';
  return '';
}

export function telegramAlertType(order={}){
  const type=classifyTelegramType(order);
  if(!CLAIM_ALERT_TYPES.has(type)) return type;

  // v7.7.32: 판매자가 이미 처리할 일이 없는 완료/철회/거부 클레임은
  // 새로 발견된 이력이라도 텔레그램 '처리 필요' 알림으로 보내지 않습니다.
  if(order?.activeState===false||isClaimTerminal(order)) return '';

  return type;
}

export function telegramClaimIsActionable(order={}){
  return CLAIM_ALERT_TYPES.has(telegramAlertType(order));
}
