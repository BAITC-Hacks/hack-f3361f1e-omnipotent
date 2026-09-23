import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../server/seed';
import { withSeedAssessment } from '../server/seed-assessments';
import { calculateScore } from '../shared/scoring';

test('all five starter cards have saved AI scores with different readiness',()=>{
 const {tasks}=seedState();assert.equal(tasks.length,5);
 const scores=tasks.map(t=>{assert.equal(t.assessment?.mode,'openai');return calculateScore(t,t.confirmed,t.assessment).total;});
 assert.ok(scores.every(s=>s>0));assert.ok(new Set(scores).size>=3);
});
test('backfill fixes unchanged legacy cards without applying scores to edited facts',()=>{
 const original=seedState().tasks[0];const legacy={...original,assessment:undefined};
 assert.ok(withSeedAssessment(legacy).assessment);
 assert.equal(withSeedAssessment({...legacy,context:'Другой процесс с другими данными'}).assessment,undefined);
 assert.equal(withSeedAssessment({...legacy,description:'Иная исходная ситуация'}).assessment,undefined);
});
