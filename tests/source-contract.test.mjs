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
assert.match(smartstore,/page:String\(page\),size:String\(size\),answered:'false'/,'Naver inquiry paging must start with explicit page and size');
assert.match(smartstore,/fromDate:iso\(range\.from\),toDate:iso\(range\.to\)/,'Naver product inquiries must include the required date range');
assert.match(smartstore,/row\.inquiryNo/,'Naver customer inquiry IDs must use inquiryNo');
assert.match(smartstore,/row\.inquiryRegistrationDateTime/,'Naver customer inquiry timestamps must use the documented field');

const coupangInquiries=read('coupang-inquiries.js');
assert.match(coupangInquiries,/answeredType:'NOANSWER'/,'Coupang product inquiries must request unanswered items');
assert.match(coupangInquiries,/\['NO_ANSWER','TRANSFER'\]/,'Coupang call-center inquiries must include answer and confirmation queues');
assert.match(coupangInquiries,/pageSize:String\(maxPageSize\)/,'Coupang inquiries must page through results');

const elevenst=read('elevenst.js');
assert.match(elevenst,/String\(item\.eventType\|\|'order'\)==='order'/,'11st order status refresh must not treat claim documents as orders');
assert.match(elevenst,/reconcileOpenDocuments/,'11st open claims must be reconciled after a complete refresh');

const agent=read('local-agent.js');
assert.match(agent,/HEARTBEAT_INTERVAL_MS=60\*1000/,'Agent heartbeat must run every minute');
assert.match(agent,/version:'FINAL-7\.4\.1-FIXED'/,'Agent diagnostics version must match release');

console.log('source-contract tests passed');
