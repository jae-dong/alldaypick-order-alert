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
assert.ok(agent.includes('주문 수집 완료 · 요청 상태는 백그라운드 확인 중'),'missing fast manual success step');
assert.ok(agent.includes('refreshClaimsInBackground'),'missing background claim refresh');
assert.ok(app.includes("action:'collect'"),'manual button must request fast collect');
console.log('progress contract test passed');
