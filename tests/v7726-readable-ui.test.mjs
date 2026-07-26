import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const css=fs.readFileSync(path.join(root,'styles.css'),'utf8');
const agent=fs.readFileSync(path.join(root,'backend','local-agent.js'),'utf8');

assert.match(app,/function orderProductName\(order=\{\}\)/);
assert.match(app,/function renderMarketBadge\(market=''/);
assert.match(app,/status-\$\{escapeHtml\(statusKey\(o\)\)\}/);
assert.match(app,/renderMarketBadge\(o\.market\|\|''\)/);
for(const status of ['new','shipping_wait','cancel','return','exchange','inquiry']){
  assert.match(css,new RegExp(`status-${status.replace('_','_')}`));
}
for(const market of ['coupang','smartstore','elevenst','gmarket','auction','lotteon']){
  assert.match(css,new RegExp(`market-${market}`));
}
assert.match(agent,/patch\.product=resolvedProduct/);
assert.match(agent,/active-list-backfill-v7\.7\.26/);
console.log('v7.7.26 readable status and market UI contract passed');
