import assert from 'node:assert/strict';
import {
  normalizeImageUrl,
  directOrderImage,
  directCoupangOrderImage,
  coupangRepresentativeImage,
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

const coupangPayload={
  data:{
    contents:[{contentDetails:[{content:'<img src="https://image.coupangcdn.com/image/product/content/vendorItem/banner.jpg">'}]}],
    items:[{
      vendorItemId:'777',
      images:[
        {imageOrder:1,imageType:'DETAIL',vendorPath:'https://image.coupangcdn.com/image/product/content/vendorItem/detail.jpg'},
        {imageOrder:0,imageType:'REPRESENTATION',vendorPath:'https://image.coupangcdn.com/image/product/image/vendoritem/real-product.jpg'}
      ]
    }]
  }
};
assert.equal(
  coupangRepresentativeImage(coupangPayload,{vendorItemId:'777'}),
  'https://image.coupangcdn.com/image/product/image/vendoritem/real-product.jpg'
);
assert.equal(
  directCoupangOrderImage({
    imageUrl:'https://image.coupangcdn.com/image/product/content/vendorItem/shipping-guide.jpg',
    images:[{imageOrder:0,imageType:'REPRESENTATION',vendorPath:'https://image.coupangcdn.com/image/product/image/vendoritem/order-product.jpg'}]
  }),
  'https://image.coupangcdn.com/image/product/image/vendoritem/order-product.jpg'
);
assert.equal(
  directCoupangOrderImage({imageUrl:'https://image.coupangcdn.com/image/product/content/vendorItem/shipping-guide.jpg'}),
  ''
);

assert.equal(
  directCoupangOrderImage({imageUrl:'https://thumbnail.coupangcdn.com/thumbnails/remote/q89/image/product/image/vendoritem/real.jpg'}),
  'https://thumbnail.coupangcdn.com/thumbnails/remote/q89/image/product/image/vendoritem/real.jpg'
);


console.log('product image tests passed');
