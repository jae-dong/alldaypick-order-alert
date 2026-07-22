import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=name=>fs.readFileSync(new URL(`../backend/${name}`,import.meta.url),'utf8');

const smartstore=read('smartstore.js');
assert.match(smartstore,/lastChangedFrom:iso\(nextFrom\)/,'Naver paging must continue with moreFrom as lastChangedFrom');
assert.match(smartstore,/params\.set\('moreSequence',moreSequence\)/,'Naver paging must pass moreSequence');
assert.doesNotMatch(smartstore,/params\.set\('moreFrom'/,'moreFrom is a response cursor, not a request parameter');
assert.match(smartstore,/\/v1\/pay-order\/seller\/product-orders\/query/,'Naver detail endpoint must be present');
assert.match(smartstore,/\/v1\/contents\/qnas/,'Naver product inquiry endpoint must be present');
assert.match(smartstore,/\/v1\/pay-user\/inquiries/,'Naver customer inquiry endpoint must be present');
assert.match(smartstore,/page:String\(page\)[\s\S]*size:String\(size\)/,'Naver product inquiry paging must use explicit page and size');
assert.match(smartstore,/fromDate:inquiryIso\(range\.from\)[\s\S]*toDate:inquiryIso\(range\.to\)/,'Naver product inquiries must include the required date range');
assert.match(smartstore,/startSearchDate:inquiryDateOnly\(range\.from\)[\s\S]*endSearchDate:inquiryDateOnly\(range\.to\)/,'Naver customer inquiries must include the required search dates');
assert.match(smartstore,/answered:'false'/,'Naver customer inquiries must request unanswered inquiries first');
assert.match(smartstore,/page:String\(page\)[\s\S]*pgae:String\(page\)/,'Naver customer inquiry paging must support both documented and gateway-compatible page keys');
assert.match(smartstore,/row\.inquiryNo/,'Naver customer inquiry IDs must use inquiryNo');
assert.match(smartstore,/row\.inquiryRegistrationDateTime/,'Naver customer inquiry timestamps must use the documented field');
assert.match(smartstore,/\/v1\/pay-order\/seller\/product-orders\?\$\{params\}/,'Naver startup repair must cross-check condition-based product orders');
assert.match(smartstore,/conditionDiscoveryComplete/,'Naver condition-order cross-check result must be reported');
assert.match(smartstore,/reconcileInquiryKind/,'Naver product and customer inquiries must reconcile independently');

const coupangInquiries=read('coupang-inquiries.js');
assert.match(coupangInquiries,/answeredType:'NOANSWER'/,'Coupang product inquiries must request unanswered items');
assert.match(coupangInquiries,/\['NO_ANSWER','TRANSFER'\]/,'Coupang call-center inquiries must include answer and confirmation queues');
assert.match(coupangInquiries,/pageSize:String\(maxPageSize\)/,'Coupang inquiries must page through results');

const coupangClaims=read('coupang-claims.js');
assert.match(coupangClaims,/rangeWindows\(days,6\)/,'Coupang exchange requests must be split into sub-seven-day windows');
assert.match(coupangClaims,/createdAtFrom:kstSecond\(window\.from\)[\s\S]*createdAtTo:kstSecond\(window\.to\)/,'Coupang exchange request dates must use each split window');


const lotteon=read('lotteon.js');
assert.match(lotteon,/\(repair\?7:3\)\*24\*60/,'Lotteon sync must cover at least three days and use a wider repair window');
assert.match(lotteon,/base14,[\s\S]*trNo: config\.sellerId/,'Lotteon must try API-key seller scope before trNo fallback');
assert.match(lotteon,/status:'shipping_wait'/,'Lotteon delivery instructions must default to shipping wait');
assert.match(lotteon,/function scalarContext/,'Lotteon nested response rows must inherit parent order fields');
assert.match(lotteon,/SellerDeliveryProgressStateSearch/,'Lotteon repair must also query current delivery progress');
assert.match(lotteon,/instructionRows[\s\S]*progressRows/,'Lotteon sync must report instruction and progress discovery separately');
assert.match(lotteon,/mergeLotteonOrders/,'Lotteon progress rows must override stale delivery-instruction rows');
assert.match(lotteon,/orderProductSequence\|\|order\.sitmNo/,'Lotteon order identity must prefer stable line identifiers');

const elevenst=read('elevenst.js');
assert.match(elevenst,/String\(item\.eventType\|\|'order'\)==='order'/,'11st order status refresh must not treat claim documents as orders');
assert.match(elevenst,/reconcileOpenDocuments/,'11st open claims must be reconciled after a complete refresh');
assert.match(elevenst,/collectOrderRows/,'11st nested order products must all be discovered');
assert.match(elevenst,/ELEVENST_REPAIR_LOOKBACK_DAYS/,'11st repair must rediscover recent missing orders');

assert.doesNotMatch(smartstore,/collection\('orders'\).*where\('source'.*get\(\)/s,'Smartstore sync must not scan Firestore orders');
assert.match(elevenst,/where\('source','==','elevenst'\)[\s\S]*limit\(500\)/,'11st startup repair must use a bounded source query');


const agent=read('local-agent.js');
const orderStore=read('order-store.js');
const directAudit=read('direct-audit-store.js');
assert.match(agent,/recordDirectAudit/,'Agent must persist marketplace-direct audit results');
assert.match(directAudit,/market-direct-audit\.json/,'Direct API audit must create a local sanitized result file');
assert.match(directAudit,/gmarket:'API 승인 전 · 집계 제외'/,'Gmarket must remain explicitly excluded until API approval');
assert.match(directAudit,/auction:'API 승인 전 · 집계 제외'/,'Auction must remain explicitly excluded until API approval');
assert.match(agent,/HEARTBEAT_INTERVAL_MS=5\*60\*1000/,'Agent heartbeat must run every five minutes in free-tier mode');
assert.match(agent,/version:'FINAL-7\.7\.16'/,'Agent diagnostics version must match release');


assert.match(agent,/SMARTSTORE_INQUIRY_INTERVAL_MS/,'Smartstore inquiries must use a protected polling interval');
assert.match(agent,/SMARTSTORE_INQUIRY_429_COOLDOWN_MS/,'Smartstore inquiries must persist a 429 cooldown');
assert.match(elevenst,/activeOnly:false/,'11st status repair must include incorrectly deactivated pending records');
assert.match(elevenst,/missingOrderNos/,'11st partial batch responses must be tracked and retried');
assert.match(coupangClaims,/exchangeStatus가 RECEIPT\/PROGRESS이면/,'Coupang official exchange status must override replacement-delivery completion');
assert.match(coupangClaims,/\['RECEIPT','PROGRESS','접수','진행'\]/,'Only official active Coupang exchange statuses may remain open');
assert.match(coupangClaims,/reconcile\?90:31/,'Startup exchange repair must scan a wider history');
assert.match(coupangClaims,/return fetchedFrom/,'Exchange reconciliation must only close records inside the directly queried range');
assert.match(smartstore,/retireLegacySmartstoreInquiryCache/,'Legacy Smartstore inquiry cache must be retired once and restored by a later successful query');
assert.match(smartstore,/searchKeywordType:'CHANNEL_PRODUCT_NO'/,'Smartstore thumbnail lookup must recover current product identity by channel product number');
assert.match(smartstore,/searchKeywordType:'SELLER_CODE'/,'Smartstore thumbnail lookup must fall back to seller management code');
assert.match(smartstore,/\/v2\/products\/origin-products\//,'Smartstore thumbnail lookup must support origin-product image fallback');
assert.match(smartstore,/sellerProductCode:String/,'Smartstore orders must preserve seller product code for thumbnail lookup');
assert.match(smartstore,/WAIT_FOR_RECEIVING/,'Smartstore gift orders must exclude recipient-acceptance waiting state');
assert.match(smartstore,/excludedFromMetrics:giftPending/,'Smartstore gift waiting must be excluded from operational metrics');
assert.doesNotMatch(elevenst,/trackingNumber','dlvNo/,'11st dlvNo must not be treated as an invoice number');
assert.match(orderStore,/FIRESTORE_MIRROR_CACHE_FILE/,'Order store must persist a local Firestore mirror cache');
assert.match(orderStore,/cacheHits/,'Order store must report cache hits');
assert.match(orderStore,/stateVerifiedAt/,'Verification timestamps must not trigger repeated Firestore writes');
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
assert.match(app,/where\('datetime','>=',monthStartIso\(\)\)/,'Web app must subscribe only to the current month');
assert.match(app,/where\('activeState','==',true\)/,'Web app must separately subscribe to unresolved items');

assert.match(agent,/quickCurrentCoupangSync/,'Manual collection must use the fast current-status Coupang path');
assert.match(agent,/refreshClaimsInBackground/,'Claims must continue in the background after current-order collection');
assert.match(agent,/refreshCurrentOrdersInBackground/,'Deep current-order reconciliation must continue after fast button completion');
assert.match(agent,/const statuses=\[\.\.\.FAST,\.\.\.SLOW\]/,'Deep Coupang reconciliation must include delivery-progress and completed states');
assert.match(agent,/refreshCurrentOrdersInBackground\('startup'\)/,'Startup must launch a deep Coupang status reconciliation');
assert.match(agent,/sendPhoto/,'Telegram new-order alerts must support product thumbnail photos');

assert.match(agent,/eventType==='exchange'[\s\S]*return 'exchange'/,'Telegram alert type must include exchange requests');
assert.match(agent,/교환요청/,'Telegram alert title and test text must include exchange requests');
assert.match(agent,/order\?\.claimId[\s\S]*order\?\.inquiryId/,'Telegram duplicate prevention must include claim or inquiry IDs');
assert.match(agent,/sendMarketplaceClaimPush\([\s\S]*result\.createdClaims\|\|\[\][\s\S]*'스마트스토어'/,'Smartstore created claims must be sent to Telegram');
assert.match(agent,/statusResult\.createdClaims[\s\S]*statusResult\.changedOrders/,'11st newly created claims must be included in Telegram status alerts');
assert.match(agent,/result\.createdClaims[\s\S]*result\.changedOrders[\s\S]*'롯데온'/,'Lotteon newly created claims must be included in Telegram status alerts');
assert.match(agent,/new FormData\(\)/,'Telegram thumbnails must upload local image files with multipart form data');
assert.match(agent,/downloadTelegramPhoto/,'Telegram thumbnails must be downloaded by the PC agent before upload');

const parentContext=read('parent-order-context.js');
assert.match(coupangClaims,/enrichWithParentOrderContext/,'Coupang claims must persist parent-order image and amount context');
assert.match(coupangInquiries,/enrichWithParentOrderContext/,'Coupang inquiries must persist parent-order image and amount context');
assert.match(smartstore,/enrichWithParentOrderContext/,'Smartstore inquiries must persist parent-order image and amount context when an order is identifiable');
assert.match(parentContext,/activeOnly:false,hydrate:false/,'Parent-order enrichment must use the free-tier local mirror cache');

const productImage=read('product-image.js');
assert.match(productImage,/sellerProductName:searchName/,'Coupang thumbnails must recover sellerProductId by product-name search');
assert.match(productImage,/telegram-product-image-cache-v10/,'Coupang negative thumbnail cache must be invalidated for the new resolver');
assert.match(agent,/lotteonResolver:resolveLotteonProductImage/,'Lotteon thumbnail lookup must use the official product detail resolver');
assert.match(agent,/source==='immediate'[\s\S]*cachedSmartstoreInquiryResult/,'Manual collection must skip slow Smartstore inquiry calls');
assert.match(agent,/Promise\.all\(jobs\.map/,'Manual current-market collection must run connected markets in parallel');
assert.match(app,/action:'collect'/,'Manual button must request fast current collection');
assert.match(app,/analysisKpis/,'Today analytics must render KPI cards');
assert.match(app,/hourlySvg/,'Today analytics must render an hourly SVG chart');
assert.match(app,/marketDonut/,'Today analytics must render a market sales donut');

const startCmd=fs.readFileSync(new URL('../START_AGENT.cmd',import.meta.url),'utf8');
assert.match(startCmd,/Stopping previous ALLDAYPICK agent automatically/,'START_AGENT must automatically stop a previous agent process');
assert.match(startCmd,/Removing a stale ALLDAYPICK agent lock/,'START_AGENT must automatically remove stale locks');
assert.match(coupangClaims,/where\('activeState','==',true\)/,'Coupang exchange cleanup must inspect all active legacy aliases');
assert.match(coupangClaims,/value==='쿠팡'/,'Coupang exchange cleanup must recognize Korean source aliases');


assert.match(agent,/enrichTelegramProductContext/,'All Telegram alert types must link to their parent order for product image and amount');
assert.doesNotMatch(agent,/telegramAlertType\(order\)==='new_order'\)\{[\s\S]*resolveTelegramProductImage/,'Thumbnail lookup must not be restricted to new orders');
assert.match(agent,/photoLogLabel:`\$\{marketName\}/,'Thumbnail logs must include the marketplace and alert type');
assert.match(app,/slice\(0,20\)/,'Today product ranking must show TOP 20');
assert.match(app,/allocatedGroupLineAmounts/,'Product sales must allocate an order total when line prices are missing');
assert.match(app,/displayOrderAmount\(o\)/,'Current order list must use the enriched display amount');
assert.match(app,/function firstPositiveAmount/,'Zero-valued amount aliases must not hide a later valid amount');
const index=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
assert.match(index,/오늘 판매 TOP 20/,'Today analytics heading must say TOP 20');
const styles=fs.readFileSync(new URL('../styles.css',import.meta.url),'utf8');
assert.match(styles,/FINAL v7\.7\.16 · 공식 API 직접검증 · 전체 가독성 확대/,'Readability overrides must be included');

console.log('source-contract tests passed');
