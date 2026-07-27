import fs from 'node:fs';
import assert from 'node:assert/strict';
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../styles.css',import.meta.url),'utf8');
const agent=fs.readFileSync(new URL('../backend/local-agent.js',import.meta.url),'utf8');
for(const text of ['renderStatisticsProductThumbnail','stats-thumb-btn','statisticsProductImageLookup','썸네일 포함']) assert.ok(app.includes(text),text);
for(const text of ['.stats-thumb-btn','.stats-product-row','.rank-sales']) assert.ok(css.includes(text),text);
for(const text of ['backfillStatisticsOrderThumbnails','조회기간 판매상품 썸네일 채우기 완료','statistics-backfill-v7.7.27']) assert.ok(agent.includes(text),text);
console.log('v7.7.27 statistics full-list thumbnail contract passed');
