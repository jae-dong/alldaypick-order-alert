import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const agent=fs.readFileSync(path.join(root,'backend','local-agent.js'),'utf8');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');

for(const required of [
  'backfillActiveOrderThumbnails',
  "where('activeState','==',true)",
  'latestImageUrl:photoUrl',
  "thumbnailSource:'active-list-backfill-v7.7.26'",
  "scheduleActiveThumbnailBackfill(source,1500)",
  "scheduleActiveThumbnailBackfill('immediate'"
]){
  if(!agent.includes(required)) throw new Error(`missing active thumbnail backfill contract: ${required}`);
}

for(const required of [
  'orderImageUrl(order={})',
  'order.representativeImageUrl',
  'order.productImageUrl',
  'order.thumbnailUrl',
  'order.imageUrl',
  '사진 없음'
]){
  if(!app.includes(required)) throw new Error(`missing frontend thumbnail contract: ${required}`);
}

console.log('v7.7.26 active thumbnail backfill contract passed');
