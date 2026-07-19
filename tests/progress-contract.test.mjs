import fs from 'node:fs';
import assert from 'node:assert/strict';

const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const agent=fs.readFileSync(new URL('../backend/local-agent.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');

for(const token of ['collectProgress','collectProgressBar','% 남음','수집 ${percent}%']){
  assert.ok(app.includes(token)||html.includes(token),`missing progress UI token: ${token}`);
}
for(const percent of [22,42,57,70,78,95]){
  assert.ok(agent.includes(`updateCollectProgress(source,${percent},`),`missing progress milestone ${percent}`);
}
assert.ok(agent.includes("progressPercent:100"),'missing success progress');
assert.ok(agent.includes("progressStep:'수집 완료'"),'missing success step');
console.log('progress contract test passed');
