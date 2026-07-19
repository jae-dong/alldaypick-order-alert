import assert from 'node:assert/strict';
import {
  quotaExceeded,
  nextFirestoreFreeResetMs
} from '../backend/quota-utils.js';

assert.equal(
  quotaExceeded(new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.')),
  true
);
assert.equal(quotaExceeded({code:8,message:'other'}),false);
assert.equal(quotaExceeded({code:'RESOURCE_EXHAUSTED'}),true);
assert.equal(quotaExceeded(new Error('HTTP 504 timeout')),false);

const summerNow=Date.parse('2026-07-19T00:00:00.000Z');
const summerReset=nextFirestoreFreeResetMs(summerNow);
assert.equal(
  new Date(summerReset).toISOString(),
  '2026-07-19T07:05:00.000Z'
);

const winterNow=Date.parse('2026-01-01T00:00:00.000Z');
const winterReset=nextFirestoreFreeResetMs(winterNow);
assert.equal(
  new Date(winterReset).toISOString(),
  '2026-01-01T08:05:00.000Z'
);

console.log('quota guard tests passed');
