import fs from 'node:fs';
import assert from 'node:assert/strict';

const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const start=fs.readFileSync(new URL('../START_AGENT.cmd',import.meta.url),'utf8');
const stop=fs.readFileSync(new URL('../STOP_AGENT.cmd',import.meta.url),'utf8');
const cleanup=fs.readFileSync(new URL('../cleanup-junk.ps1',import.meta.url),'utf8');
const pkg=JSON.parse(fs.readFileSync(new URL('../backend/package.json',import.meta.url),'utf8'));

assert.equal(pkg.version,'7.7.35');
assert.match(app,/v7\.7\.35 데일리픽 전용 절전/);
assert.match(app,/latestIntegrationTime\(\)/);
assert.match(app,/freshestAge<=15\*60\*1000/);
assert.match(start,/AUTO RECOVERY/);
assert.match(start,/goto START_AGENT/);
assert.match(stop,/\.agent-stop-requested/);
assert.match(start,/cleanup-junk\.ps1/);
assert.match(cleanup,/배포전_검증결과\*\.txt/);
console.log('v7.7.33 agent self-heal and heartbeat fallback contract passed');
