import assert from 'node:assert/strict';
import { upsertDocuments,reconcileOpenDocuments,migrateLegacyDocuments } from '../backend/order-store.js';

function mockDb(initial={}){
  const data=new Map(Object.entries(initial).map(([id,value])=>[id,{...value}]));
  const makeRef=id=>({id,path:`orders/${id}`});
  const snapshotFor=(id)=>({exists:data.has(id),data:()=>data.get(id)});
  const collection={
    doc:id=>makeRef(id),
    where(field,op,value){
      return {async get(){
        const docs=[...data.entries()].filter(([,item])=>item[field]===value).map(([id,item])=>({id,ref:makeRef(id),data:()=>item}));
        return {docs,size:docs.length,forEach:fn=>docs.forEach(fn)};
      }};
    },
    async get(){
      const docs=[...data.entries()].map(([id,item])=>({id,ref:makeRef(id),data:()=>item}));
      return {docs,size:docs.length,forEach:fn=>docs.forEach(fn)};
    }
  };
  return {
    data,
    collection:name=>{assert.equal(name,'orders');return collection;},
    async runTransaction(fn){
      const tx={
        get:async ref=>snapshotFor(ref.id),
        create:(ref,value)=>data.set(ref.id,{...value}),
        set:(ref,value,{merge}={})=>data.set(ref.id,merge?{...(data.get(ref.id)||{}),...value}:{...value})
      };
      return fn(tx);
    },
    batch(){
      const writes=[];
      return {set:(ref,value,{merge}={})=>writes.push([ref,value,merge]),async commit(){for(const [ref,value,merge] of writes)data.set(ref.id,merge?{...(data.get(ref.id)||{}),...value}:{...value});}};
    }
  };
}

const db=mockDb({
  order1:{source:'coupang',eventType:'order',sourceStatus:'INSTRUCT',status:'shipping_wait',activeState:false,qty:1,invoiceNumber:'',datetime:'2026-07-19T00:00:00+09:00'}
});
const result=await upsertDocuments(db,[{id:'order1',source:'coupang',market:'쿠팡',eventType:'order',sourceStatus:'INSTRUCT',status:'shipping_wait',statusLabel:'발송대기',activeState:true,qty:1,invoiceNumber:'',datetime:'2026-07-19T00:00:00+09:00'}]);
assert.equal(result.statusChanged,1);
assert.equal(db.data.get('order1').activeState,true);

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

const migrationDb=mockDb({
  completedClaim:{source:'smartstore',eventType:'return',sourceStatus:'RETURN_DONE',status:'return_request',activeState:true,claimKey:'smartstore|return|R1|1'},
  openClaim:{source:'smartstore',eventType:'return',sourceStatus:'RETURN_REQUEST',status:'return_request',activeState:true,claimKey:'smartstore|return|R2|1'}
});
const migration=await migrateLegacyDocuments(migrationDb);
assert.ok(migration.patched>=1);
assert.equal(migrationDb.data.get('completedClaim').activeState,false);
assert.equal(migrationDb.data.get('openClaim').activeState,true);

console.log('order-store tests passed');
