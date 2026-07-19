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

const coupangInquiries=read('coupang-inquiries.js');
assert.match(coupangInquiries,/answeredType:'NOANSWER'/,'Coupang product inquiries must request unanswered items');
assert.match(coupangInquiries,/\['NO_ANSWER','TRANSFER'\]/,'Coupang call-center inquiries must include answer and confirmation queues');
assert.match(coupangInquiries,/pageSize:String\(maxPageSize\)/,'Coupang inquiries must page through results');

const coupangClaims=read('coupang-claims.js');
assert.match(coupangClaims,/rangeWindows\(days,6\)/,'Coupang exchange requests must be split into sub-seven-day windows');
assert.match(coupangClaims,/createdAtFrom:kstSecond\(window\.from\)[\s\S]*createdAtTo:kstSecond\(window\.to\)/,'Coupang exchange request dates must use each split window');

const elevenst=read('elevenst.js');
assert.match(elevenst,/String\(item\.eventType\|\|'order'\)==='order'/,'11st order status refresh must not treat claim documents as orders');
assert.match(elevenst,/reconcileOpenDocuments/,'11st open claims must be reconciled after a complete refresh');

assert.doesNotMatch(smartstore,/collection\('orders'\).*where\('source'.*get\(\)/s,'Smartstore sync must not scan Firestore orders');
assert.doesNotMatch(elevenst,/collection\('orders'\).*where\('source'.*get\(\)/s,'11st sync must not scan Firestore orders');


const agent=read('local-agent.js');
const orderStore=read('order-store.js');
assert.match(agent,/HEARTBEAT_INTERVAL_MS=5\*60\*1000/,'Agent heartbeat must run every five minutes in free-tier mode');
assert.match(agent,/version:'FINAL-7\.6\.0-STATE-FLOW-FIX'/,'Agent diagnostics version must match release');

assert.match(orderStore,/FIRESTORE_MIRROR_CACHE_FILE/,'Order store must persist a local Firestore mirror cache');
assert.match(orderStore,/cacheHits/,'Order store must report cache hits');
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
assert.match(app,/where\('datetime','>=',monthStartIso\(\)\)/,'Web app must subscribe only to the current month');
assert.match(app,/where\('activeState','==',true\)/,'Web app must separately subscribe to unresolved items');
console.log('source-contract tests passed');
