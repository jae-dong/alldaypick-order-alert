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
assert.equal(H.publicProductUrl({productId:'456',vendorItemId:'789'},'쿠팡'),'https://www.coupang.com/vp/products/456?vendorItemId=789');
assert.equal(H.imageFromObject({originProduct:{images:{representativeImage:{url:'https://shop-phinf.pstatic.net/a.jpg'}}}}),'https://shop-phinf.pstatic.net/a.jpg');
assert.equal(H.imageFromObject({content:'<div><img src=\"https://image.coupangcdn.com/vendor/a.jpg\"></div>'}),'https://image.coupangcdn.com/vendor/a.jpg');
assert.deepEqual(H.findValues({data:{sellerProductId:123}},/^sellerProductId$/i),['123']);
console.log('product image tests passed');
