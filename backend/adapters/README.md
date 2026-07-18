# 쇼핑몰 API 어댑터

현재 주문 수집은 `backend`의 쇼핑몰별 모듈에서 처리합니다.

- 쿠팡: `coupang.js`, `coupang-claims.js`
- 스마트스토어: `smartstore.js`
- 11번가: `elevenst.js`
- 롯데온: `lotteon.js`
- 통합 수집 및 텔레그램 알림: `local-agent.js`

API 비밀키는 `backend/.env.local`에만 저장하며 Git에는 올리지 않습니다.
이 폴더는 향후 어댑터 분리용으로 유지합니다.
