export const ORDER_PENDING_STATUSES=new Set(['new','shipping_wait']);
export const CLAIM_TYPES=new Set(['cancel','return','exchange','inquiry']);

export function cleanText(value){
  return String(value??'').trim();
}

export function upperText(...values){
  return values.filter(Boolean).map(cleanText).join(' ').toUpperCase();
}

export function orderKey(source,orderNo){
  return `${cleanText(source).toLowerCase()}|${cleanText(orderNo)}`;
}

export function lineKey(source,orderNo,lineId){
  return `${orderKey(source,orderNo)}|${cleanText(lineId)||'item'}`;
}

export function claimKey(source,eventType,claimId){
  return `${cleanText(source).toLowerCase()}|${cleanText(eventType).toLowerCase()}|${cleanText(claimId)}`;
}

export function isClaimTerminal(value){
  const text=upperText(
    value?.sourceStatus,
    value?.status,
    value?.statusLabel,
    value?.claimStatus,
    value?.processingStatus,
    value?.resultStatus,
    value?.receiptStatus,
    value?.exchangeStatus,
    value?.inquiryStatus,
    value?.answered,
    value?.partnerCounselingStatus,
    value?.csPartnerCounselingStatus
  );

  if(value?.activeState===false||value?.answered===true){
    return true;
  }

  const exactTerminal=[
    'CC','RETURNS_COMPLETED','ANSWER','ANSWERED','COMPLETE','COMPLETED',
    'CLOSED','DONE','FINISH','FINISHED','WITHDRAW','WITHDRAWN',
    'REJECT','REJECTED','CANCELLED','CANCELED','EXCHANGED','RETURNED'
  ];

  const tokens=text.split(/[^A-Z0-9_가-힣]+/).filter(Boolean);

  if(exactTerminal.some(token=>tokens.includes(token))){
    return true;
  }

  const structuredTerminal=[
    'CANCEL_DONE','CANCEL_COMPLETE','CANCEL_COMPLETED',
    'RETURN_DONE','RETURN_COMPLETE','RETURN_COMPLETED',
    'EXCHANGE_DONE','EXCHANGE_COMPLETE','EXCHANGE_COMPLETED',
    'CLAIM_DONE','CLAIM_COMPLETE','CLAIM_COMPLETED',
    'ANSWER_DONE','ANSWER_COMPLETE','ANSWER_COMPLETED',
    'REQUEST_CANCELLED','REQUEST_CANCELED'
  ];

  if(structuredTerminal.some(token=>tokens.includes(token))){
    return true;
  }

  return [
    '처리완료','취소완료','반품완료','교환완료','답변완료',
    '철회','거부','종결','완료처리'
  ].some(token=>text.includes(token));
}

export function workflowFields({source,orderNo,lineId,eventType='order',claimId=''}){
  const workflowType=eventType==='order'
    ?'order'
    :eventType==='inquiry'
      ?'inquiry'
      :'claim';

  return {
    schemaVersion:2,
    workflowType,
    orderKey:orderKey(source,orderNo),
    lineKey:eventType==='order'
      ?lineKey(source,orderNo,lineId)
      :undefined,
    claimKey:eventType==='order'
      ?undefined
      :claimKey(source,eventType,claimId),
    claimLineKey:eventType==='order'
      ?undefined
      :lineKey(source,orderNo,lineId)
  };
}

export function activeClaimFields(document){
  const terminal=isClaimTerminal(document);
  return {
    activeState:!terminal,
    resolvedAt:terminal?new Date().toISOString():null
  };
}
