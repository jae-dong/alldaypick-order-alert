import assert from 'node:assert/strict';
import { upsertDocuments,reconcileOpenDocuments,migrateLegacyDocuments,sanitizeFirestoreValue } from '../backend/order-store.js';

function mockDb(initial={}){
  const data=new Map(Object.entries(initial).map(([id,value])=>[id,{...value}]));
  const writes=[];
  const makeRef=id=>({id,path:`orders/${id}`});
  const snapshotFor=(id)=>({exists:data.has(id),data:()=>data.get(id)});
  const makeQuery=(conditions=[])=>({
    where(field,op,value){
      return makeQuery([...conditions,[field,op,value]]);
    },
    async get(){
      const docs=[...data.entries()]
        .filter(([,item])=>conditions.every(([field,op,value])=>{
          assert.equal(op,'==');
          return item[field]===value;
        }))
        .map(([id,item])=>({id,ref:makeRef(id),data:()=>item}));
      return {docs,size:docs.length,forEach:fn=>docs.forEach(fn)};
    }
  });
  const collection={
    doc:id=>makeRef(id),
    where(field,op,value){
      return makeQuery([[field,op,value]]);
    },
    async get(){
      const docs=[...data.entries()].map(([id,item])=>({id,ref:makeRef(id),data:()=>item}));
      return {docs,size:docs.length,forEach:fn=>docs.forEach(fn)};
    }
  };
  return {
    data,
    writes,
    collection:name=>{assert.equal(name,'orders');return collection;},
    async runTransaction(fn){
      const tx={
        get:async ref=>snapshotFor(ref.id),
        create:(ref,value)=>{writes.push(['create',ref.id]);data.set(ref.id,{...value});},
        set:(ref,value,{merge}={})=>{writes.push(['set',ref.id]);data.set(ref.id,merge?{...(data.get(ref.id)||{}),...value}:{...value});}
      };
      return fn(tx);
    },
    batch(){
      const queued=[];
      return {
        set:(ref,value,{merge}={})=>queued.push([ref,value,merge]),
        async commit(){
          for(const [ref,value,merge] of queued){
            writes.push(['batch-set',ref.id]);
            data.set(ref.id,merge?{...(data.get(ref.id)||{}),...value}:{...value});
          }
        }
      };
    }
  };
}


const db=mockDb({
  order1:{source:'coupang',eventType:'order',sourceStatus:'INSTRUCT',status:'shipping_wait',activeState:false,qty:1,invoiceNumber:'',datetime:'2026-07-19T00:00:00+09:00'}
});
const result=await upsertDocuments(db,[{id:'order1',source:'coupang',market:'쿠팡',eventType:'order',sourceStatus:'INSTRUCT',status:'shipping_wait',statusLabel:'발송대기',activeState:true,qty:1,invoiceNumber:'',datetime:'2026-07-19T00:00:00+09:00'}]);
assert.equal(result.statusChanged,1);
assert.equal(db.data.get('order1').activeState,true);

const writesAfterChange=db.writes.length;
const unchanged=await upsertDocuments(db,[{
  id:'order1',source:'coupang',market:'쿠팡',eventType:'order',
  sourceStatus:'INSTRUCT',status:'shipping_wait',statusLabel:'발송대기',
  activeState:true,qty:1,invoiceNumber:'',
  datetime:'2026-07-19T00:00:00+09:00',
  syncedAt:new Date().toISOString(),sourceUpdatedAt:new Date().toISOString()
}]);
assert.equal(unchanged.existing,1);
assert.equal(unchanged.statusChanged,0);
assert.equal(db.writes.length,writesAfterChange,'unchanged document must not write');


await upsertDocuments(db,[{
  id:'delivered1',source:'coupang',market:'쿠팡',eventType:'order',
  sourceStatus:'FINAL_DELIVERY',status:'delivered',statusLabel:'배송완료',
  activeState:true,datetime:'2026-07-19T00:00:00+09:00'
}]);
assert.equal(db.data.get('delivered1').activeState,false,'delivered order must leave unfinished list');

await upsertDocuments(db,[{id:'claim1',source:'coupang',market:'쿠팡',eventType:'return',sourceStatus:'CC',status:'return_request',activeState:true,datetime:'2026-07-19T00:00:00+09:00'}]);
assert.equal(db.data.get('claim1').activeState,false);

const reconcileDb=mockDb({
  accept:{source:'coupang',eventType:'order',sourceStatus:'ACCEPT',activeState:true,datetime:'2026-07-19T00:00:00+09:00'},
  instruct:{source:'coupang',eventType:'order',sourceStatus:'INSTRUCT',activeState:true,datetime:'2026-07-19T00:00:00+09:00'}
});
const rec=await reconcileOpenDocuments(reconcileDb,{source:'coupang',eventType:'order',sourceStatus:'ACCEPT',currentIds:[],from:new Date('2026-07-18T00:00:00+09:00'),complete:true});
assert.equal(rec.deactivated,1);
assert.equal(reconcileDb.data.get('accept').activeState,false);
assert.equal(reconcileDb.data.get('instruct').activeState,true);

const staleExchangeDb=mockDb({
  oldExchange:{source:'coupang',eventType:'exchange',sourceStatus:'PROGRESS',activeState:true,datetime:'2025-01-01T00:00:00+09:00'}
});
const staleExchangeResult=await reconcileOpenDocuments(staleExchangeDb,{
  source:'coupang',eventType:'exchange',currentIds:[],from:new Date(0),complete:true
});
assert.equal(staleExchangeResult.deactivated,1,'startup full exchange reconcile must retire old active cache entries');
assert.equal(staleExchangeDb.data.get('oldExchange').activeState,false);

const migrationDb=mockDb({
  completedClaim:{source:'smartstore',eventType:'return',sourceStatus:'RETURN_DONE',status:'return_request',activeState:true,claimKey:'smartstore|return|R1|1'},
  openClaim:{source:'smartstore',eventType:'return',sourceStatus:'RETURN_REQUEST',status:'return_request',activeState:true,claimKey:'smartstore|return|R2|1'}
});
const migration=await migrateLegacyDocuments(migrationDb);
assert.ok(migration.patched>=1);
assert.equal(migrationDb.data.get('completedClaim').activeState,false);
assert.equal(migrationDb.data.get('openClaim').activeState,true);

console.log('order-store tests passed');


const dirty={
  id:'dirty1',
  source:'coupang',
  eventType:'order',
  lineKey:'coupang|1|1',
  claimKey:undefined,
  nested:{keep:'yes',drop:undefined},
  list:[1,undefined,{keep:true,drop:undefined}]
};
const clean=sanitizeFirestoreValue(dirty);
assert.equal(Object.hasOwn(clean,'claimKey'),false);
assert.deepEqual(clean.nested,{keep:'yes'});
assert.deepEqual(clean.list,[1,{keep:true}]);
await upsertDocuments(db,[dirty]);
assert.equal(Object.hasOwn(db.data.get('dirty1'),'claimKey'),false);
assert.deepEqual(db.data.get('dirty1').nested,{keep:'yes'});

console.log('firestore undefined sanitizer tests passed');
