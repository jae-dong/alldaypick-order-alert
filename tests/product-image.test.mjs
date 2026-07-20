import assert from 'node:assert/strict';
import {
  normalizeImageUrl,
  directOrderImage,
  productImageTestHelpers as H
} from '../backend/product-image.js';

assert.equal(normalizeImageUrl('//image.example.com/a.jpg'),'https://image.example.com/a.jpg');
assert.equal(normalizeImageUrl('/image/product/a.jpg'),'https://image.coupangcdn.com/image/product/a.jpg');
assert.equal(directOrderImage({thumbnailUrl:'https://img.example.com/thumb.jpg'}),'https://img.example.com/thumb.jpg');
assert.equal(H.publicProductUrl({productNo:'123'},'11번가'),'https://www.11st.co.kr/products/123');
assert.equal(H.publicProductUrl({productId:'456',vendorItemId:'789'},'쿠팡'),'https://www.coupang.com/vp/products/456?itemId=789');
console.log('product image tests passed');
