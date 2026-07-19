import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'alldaypick-free-tier-'));
process.env.FIRESTORE_MIRROR_CACHE_FILE=path.join(tempDir,'mirror.json');
const {upsertDocuments}=await import('../backend/order-store.js?free-tier-test');

function mockDb(){
  const data=new Map();
  const metrics={reads:0,writes:0};
  const makeRef=id=>({id,path:`orders/${id}`});
  const collection={
    doc:id=>makeRef(id),
    where(){
      return {
        limit(){return this;},
        async get(){return {docs:[],size:0,forEach(){}};}
      };
    }
  };
  return {
    data,metrics,
    collection:name=>{assert.equal(name,'orders');return collection;},
    async getAll(...refs){
      metrics.reads+=refs.length;
      return refs.map(ref=>({
        id:ref.id,
        exists:data.has(ref.id),
        data:()=>data.get(ref.id)
      }));
    },
    batch(){
      const queued=[];
      return {
        set:(ref,value,{merge}={})=>queued.push([ref,value,merge]),
        async commit(){
          for(const [ref,value,merge] of queued){
            metrics.writes+=1;
            data.set(ref.id,merge?{...(data.get(ref.id)||{}),...value}:{...value});
          }
        }
      };
    }
  };
}

const db=mockDb();
const order={
  id:'coupang-1-A',source:'coupang',market:'쿠팡',eventType:'order',
  orderNo:'1',vendorItemId:'A',status:'new',statusLabel:'신규주문',
  sourceStatus:'ACCEPT',activeState:true,qty:1,amount:10000,
  datetime:'2026-07-19T09:00:00+09:00',syncedAt:new Date().toISOString()
};

const first=await upsertDocuments(db,[order]);
assert.equal(first.created,1);
assert.equal(first.quota.cloudReads,1);
assert.equal(first.quota.cloudWrites,1);

const readsAfterFirst=db.metrics.reads;
const writesAfterFirst=db.metrics.writes;
const second=await upsertDocuments(db,[{...order,syncedAt:new Date().toISOString(),sourceUpdatedAt:new Date().toISOString()}]);
assert.equal(second.existing,1);
assert.equal(second.quota.cacheHits,1);
assert.equal(db.metrics.reads,readsAfterFirst,'unchanged repeat must use zero Firestore reads');
assert.equal(db.metrics.writes,writesAfterFirst,'unchanged repeat must use zero Firestore writes');

const changed=await upsertDocuments(db,[{...order,status:'shipping_wait',statusLabel:'발송대기',sourceStatus:'INSTRUCT'}]);
assert.equal(changed.statusChanged,1);
assert.equal(changed.quota.cloudReads,0,'known changed order must not read Firestore');
assert.equal(changed.quota.cloudWrites,1);

fs.rmSync(tempDir,{recursive:true,force:true});
console.log('free-tier local mirror cache tests passed');
