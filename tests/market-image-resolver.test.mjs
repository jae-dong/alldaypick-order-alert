import assert from 'node:assert/strict';
import {smartstoreTestHelpers as S} from '../backend/smartstore.js';
import {lotteonTestHelpers as L} from '../backend/lotteon.js';

assert.equal(
  S.firstImageUrl({
    productUrl:'https://smartstore.naver.com/main/products/100',
    originProduct:{images:{representativeImage:{url:'https://shop-phinf.pstatic.net/2026/main.jpg'}}}
  }),
  'https://shop-phinf.pstatic.net/2026/main.jpg'
);
assert.equal(
  S.firstImageUrl({productUrl:'https://smartstore.naver.com/main/products/100'}),
  ''
);
assert.deepEqual(
  S.collectProductNumbers({data:{channelProductNo:123,originProduct:{originProductNo:456}}}),
  {channel:['123'],origin:['456']}
);
assert.equal(
  S.normalizeSmartstoreImageUrl('shop-phinf.pstatic.net/2026/main.jpg'),
  'https://shop-phinf.pstatic.net/2026/main.jpg'
);

assert.equal(
  L.productImageFromResponse({data:{rprsImgUrl:'https://contents.lotteon.com/item/main.jpg'}}),
  'https://contents.lotteon.com/item/main.jpg'
);
assert.equal(
  L.productImageFromResponse({data:{imageList:[
    {imgTypCd:'DETAIL',imgUrl:'https://contents.lotteon.com/item/detail.jpg'},
    {imgTypCd:'RPRS',imgUrl:'https://contents.lotteon.com/item/main.jpg'}
  ]}}),
  'https://contents.lotteon.com/item/main.jpg'
);

console.log('market image resolver tests passed');
