import assert from 'node:assert/strict';
import fs from 'node:fs';
import {activeBusinessProfile,businessProfilesState} from '../backend/business-profile.js';

const defaults=businessProfilesState({});
assert.equal(defaults.alldaypick.enabled,false);
assert.equal(defaults.dailypick.enabled,true);

const daily=activeBusinessProfile({ORDER_ALERT_BUSINESS_PROFILE:'DAILYPICK'});
assert.equal(daily.key,'dailypick');
assert.equal(daily.enabled,true);

const oldOff=activeBusinessProfile({ORDER_ALERT_BUSINESS_PROFILE:'ALLDAYPICK'});
assert.equal(oldOff.enabled,false);
const oldOn=activeBusinessProfile({ORDER_ALERT_BUSINESS_PROFILE:'ALLDAYPICK',ALLDAYPICK_PROFILE_ENABLED:'1'});
assert.equal(oldOn.enabled,true);

const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
assert.match(app,/DAILYPICK_DATA_START_ISO='2026-09-13T00:00:00\+09:00'/);
assert.match(app,/if\(currentBusinessKey==='dailypick'\) return;/);
assert.match(app,/데일리픽 절전모드/);

const store=fs.readFileSync(new URL('../backend/order-store.js',import.meta.url),'utf8');
assert.match(store,/query=query\.where\('businessKey','==','dailypick'\)/);
assert.match(store,/firestore-mirror-cache-\$\{CACHE_BUSINESS_KEY\}/);
const metrics=fs.readFileSync(new URL('../backend/daily-metrics-ledger.js',import.meta.url),'utf8');
assert.match(metrics,/business==='dailypick'/);
const agent=fs.readFileSync(new URL('../backend/local-agent.js',import.meta.url),'utf8');
assert.match(agent,/사업자 상태: 올데이픽/);
assert.match(agent,/반복 로그 생략/);

console.log('v7.7.35 dailypick-only optimization contract passed');
