import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');

assert.match(html,/오늘 판매상품 전체/);
assert.doesNotMatch(html,/오늘 판매 TOP 20/);
assert.match(html,/최근 90일/);
assert.match(html,/전체 기간/);

const todaySection=app.slice(
  app.indexOf('function renderTodayAnalytics(){'),
  app.indexOf('async function toggleImportant')
);
assert.doesNotMatch(todaySection,/\.slice\(0,\s*20\)/);
assert.match(todaySection,/value\.lines\.size/);

const statsSection=app.slice(
  app.indexOf('function renderStats(){'),
  app.indexOf('const ANALYTICS_MARKET_COLORS')
);
assert.doesNotMatch(statsSection,/\.slice\(0,\s*10\)/);
assert.match(statsSection,/productOrderCount/);
assert.match(statsSection,/value\.lines\.size/);
assert.match(app,/db\.collection\('orders'\)\.get\(\)/);
assert.match(app,/authoritativeDailyRows\(\)\.forEach/);
assert.match(app,/Date\.now\(\)-statisticsLoadedAt<5\*60\*1000/);

console.log('v7.7.19 full day and range statistics tests passed');
