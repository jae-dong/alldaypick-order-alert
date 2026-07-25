import assert from 'node:assert/strict';
import {
  EXCHANGE_BASELINE_CUTOFF_MS,
  isBeforeExchangeBaseline,
  isTrackedExchangeDocument
} from '../backend/exchange-baseline.js';

assert.ok(Number.isFinite(EXCHANGE_BASELINE_CUTOFF_MS));
assert.equal(isBeforeExchangeBaseline({claimRequestedAt:'2026-07-25T23:00:00+09:00'}),true);
assert.equal(isBeforeExchangeBaseline({claimRequestedAt:'2026-07-26T01:10:00+09:00'}),false);
assert.equal(isTrackedExchangeDocument({source:'coupang',eventType:'exchange'},'coupang-exchange-1'),true);
assert.equal(isTrackedExchangeDocument({market:'스마트스토어',statusLabel:'교환요청'},'legacy-1'),true);
assert.equal(isTrackedExchangeDocument({source:'elevenst',eventType:'order'},'eleven-1'),false);
console.log('exchange baseline tests passed');
