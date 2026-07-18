import assert from 'node:assert/strict';
import { isClaimTerminal,workflowFields } from '../backend/workflow-model.js';

assert.equal(isClaimTerminal({sourceStatus:'UC',activeState:true}),false);
assert.equal(isClaimTerminal({sourceStatus:'CC'}),true);
assert.equal(isClaimTerminal({sourceStatus:'RETURNS_COMPLETED'}),true);
assert.equal(isClaimTerminal({answered:true}),true);
assert.equal(isClaimTerminal({claimStatus:'교환완료'}),true);
assert.equal(isClaimTerminal({sourceStatus:'NO_ANSWER'}),false);

const order=workflowFields({source:'coupang',orderNo:'1',lineId:'2',eventType:'order'});
assert.equal(order.workflowType,'order');
assert.equal(order.orderKey,'coupang|1');
assert.equal(order.lineKey,'coupang|1|2');
assert.equal(Object.hasOwn(order,'claimKey'),false);
assert.equal(Object.hasOwn(order,'claimLineKey'),false);
const claim=workflowFields({source:'coupang',orderNo:'1',lineId:'2',eventType:'return',claimId:'3'});
assert.equal(claim.workflowType,'claim');
assert.equal(claim.claimKey,'coupang|return|3');
assert.equal(claim.claimLineKey,'coupang|1|2');
assert.equal(Object.hasOwn(claim,'lineKey'),false);
console.log('workflow-model tests passed');
assert.equal(isClaimTerminal({sourceStatus:'CANCEL_DONE'}),true);
assert.equal(isClaimTerminal({sourceStatus:'RETURN_COMPLETE'}),true);
assert.equal(isClaimTerminal({sourceStatus:'EXCHANGE_COMPLETED'}),true);
assert.equal(isClaimTerminal({sourceStatus:'CANCEL_REQUEST'}),false);
assert.equal(isClaimTerminal({sourceStatus:'RETURN_REQUEST'}),false);
