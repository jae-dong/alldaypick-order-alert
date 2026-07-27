import assert from 'node:assert/strict';
import fs from 'node:fs';
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../styles.css',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
assert.ok(app.includes("function setMetricValue"));
assert.ok(app.includes("metric-value-xxl"));
assert.ok(app.includes("setMetricValue('monthSales',monthTotals.sales,{currency:true})"));
assert.ok(css.includes('.metric strong.metric-value-xl'));
assert.ok(css.includes('white-space:nowrap'));
assert.ok(html.includes('id="monthSales"')); // prior billion-safe metric feature remains
console.log('billion-safe metric contract passed');
