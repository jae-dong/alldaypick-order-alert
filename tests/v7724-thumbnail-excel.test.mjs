import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const css=fs.readFileSync(path.join(root,'styles.css'),'utf8');
const agent=fs.readFileSync(path.join(root,'backend','local-agent.js'),'utf8');

assert.match(app,/v7\.7\.26 상태색상·마켓아이콘·상품명·가독성 개선/);
assert.match(app,/function renderOrderProductCell/);
assert.match(app,/class="order-thumb-img"/);
assert.match(app,/function exportStatisticsExcel/);
assert.match(app,/상품별 순위/);
assert.match(app,/상품주문 상세/);
assert.match(app,/value!=='month'/);
assert.match(html,/id="statsMonth"/);
assert.match(html,/id="exportStatsExcelBtn"/);
assert.match(html,/id="imageDialog"/);
assert.match(css,/\.order-thumb-btn/);
assert.match(css,/\.excel-btn/);
assert.match(agent,/latestImageUrl:photoUrl/);
assert.match(agent,/thumbnailRefreshedAt/);
console.log('v7.7.26 thumbnail and Excel export contract passed');
