# v10 자동수집 시작 안내

## 이번 버전에서 추가된 것

- 6개 쇼핑몰 연결상태 화면
- GitHub Actions 10분 자동 실행
- 비밀키를 GitHub Secrets에 안전하게 저장하는 구조
- Firestore에 최근 자동확인 시간 기록
- Cloud Run 없이 월 0원을 목표로 하는 구조

## 중요한 보안 원칙

쿠팡 Secret Key 등은 아래 장소에 절대 넣지 않습니다.

- index.html
- Firestore
- GitHub 소스 파일
- 채팅

모든 비밀키는 GitHub 저장소의
Settings → Secrets and variables → Actions
에 저장합니다.

## 다음 단계

먼저 `FIREBASE_SERVICE_ACCOUNT_JSON` 비밀값을 등록하고,
Actions 화면에서 `Order Poller`를 수동 실행해 자동수집 기반이 정상인지 확인합니다.

그 다음 쿠팡 키 3개를 Secrets에 등록하고 실제 쿠팡 주문 조회 어댑터를 추가합니다.
