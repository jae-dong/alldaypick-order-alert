import { getCachedDocuments } from './order-store.js';

function normalized(value=''){
  return String(value||'').trim();
}

function normalizedProduct(value=''){
  return normalized(value)
    .toLowerCase()
    .replace(/\s+/g,' ')
    .replace(/[^0-9a-z가-힣 ]/g,'')
    .trim();
}

function positiveMoney(...values){
  for(const value of values.flat(Infinity)){
    if(value==null||value==='') continue;
    let number;
    if(typeof value==='object'&&value){
      number=Number(value.units||0)+Number(value.nanos||0)/1e9;
    }else{
      number=Number(String(value).replace(/[^0-9.-]/g,''));
    }
    if(Number.isFinite(number)&&number>0) return Math.round(number);
  }
  return 0;
}

function identityValues(item={}){
  return [
    item.productOrderId,item.vendorItemId,item.orderItemId,
    item.orderProductSequence,item.productNo,item.productId,
    item.channelProductNo,item.originProductNo,item.originalProductId,
    item.spdNo,item.sitmNo,item.itemNo,item.goodsNo,
    item.sellerProductId,item.sellerProductCode,item.externalVendorSkuCode
  ].map(normalized).filter(Boolean);
}

function relatedScore(document={},candidate={}){
  let score=0;
  const documentOrderNo=normalized(document.orderNo||document.orderId);
  const candidateOrderNo=normalized(candidate.orderNo||candidate.orderId);

  if(documentOrderNo&&candidateOrderNo){
    if(documentOrderNo!==candidateOrderNo) return -1;
    score+=1000;
  }

  const left=new Set(identityValues(document));
  for(const value of identityValues(candidate)){
    if(left.has(value)) score+=150;
  }

  const documentProduct=normalizedProduct(document.product);
  const candidateProduct=normalizedProduct(candidate.product);
  if(documentProduct&&candidateProduct){
    if(documentProduct===candidateProduct) score+=80;
    else if(documentProduct.includes(candidateProduct)||candidateProduct.includes(documentProduct)) score+=25;
  }

  return score;
}

function genericProductName(value=''){
  const product=normalized(value);
  if(!product) return true;
  return [
    '쿠팡 상품','쿠팡 상품문의','쿠팡 고객센터 문의',
    '주문취소 상품','반품요청 상품','교환요청 상품',
    '상품명 없음'
  ].some(token=>product===token||product.startsWith(`${token} `));
}

function mergeParentContext(document,parent){
  if(!parent) return {...document};
  const merged={...document};
  const fields=[
    'option','imageUrl','productOrderId','vendorItemId','orderItemId',
    'orderProductSequence','productNo','productId','channelProductNo',
    'originProductNo','originalProductId','spdNo','sitmNo','itemNo','goodsNo',
    'sellerProductId','sellerProductCode','externalVendorSkuCode',
    'productUrl','productPageUrl','mallProductUrl','detailUrl'
  ];

  for(const field of fields){
    if((merged[field]==null||normalized(merged[field])==='')&&parent[field]!=null){
      merged[field]=parent[field];
    }
  }

  if(genericProductName(merged.product)&&!genericProductName(parent.product)){
    merged.product=parent.product;
  }

  merged.amount=positiveMoney(
    document.amount,document.salePrice,document.itemAmount,document.lineAmount,
    parent.amount,parent.salePrice,parent.itemAmount,parent.lineAmount,
    parent.orderTotalAmount,parent.totalAmount,parent.paymentAmount
  );
  merged.unitPrice=positiveMoney(
    document.unitPrice,document.itemPrice,document.orderItemUnitPrice,
    parent.unitPrice,parent.itemPrice,parent.orderItemUnitPrice
  );
  merged.orderTotalAmount=positiveMoney(
    document.orderTotalAmount,document.totalAmount,document.paymentAmount,
    parent.orderTotalAmount,parent.totalAmount,parent.paymentAmount
  );
  merged.parentOrderId=parent.id||'';
  return merged;
}

export async function enrichWithParentOrderContext(
  db,
  documents=[],
  {source=''}={}
){
  if(!documents.length||!source) return documents.map(item=>({...item}));
  const cached=await getCachedDocuments(db,{
    source,eventType:'order',activeOnly:false,hydrate:false
  });
  const parents=cached.documents||[];
  if(!parents.length) return documents.map(item=>({...item}));

  return documents.map(document=>{
    const parent=parents
      .map(candidate=>({candidate,score:relatedScore(document,candidate)}))
      .filter(item=>item.score>0)
      .sort((a,b)=>b.score-a.score)[0]?.candidate||null;
    return mergeParentContext(document,parent);
  });
}

export const parentOrderContextTestHelpers={
  positiveMoney,identityValues,relatedScore,genericProductName,mergeParentContext
};
