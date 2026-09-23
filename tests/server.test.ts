import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { emptyFields } from '../shared/types.js';

test('publication, unlimited low-score proposals, manual selection, idempotent points and persistence',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'omnipotent-'));const dataFile=join(dir,'store.json');
 try {
  const app=createApp({aiOptions:{apiKey:''},dataFile});const api=request(app);
  const body={fields:{...emptyFields(),title:'Новая задача'},description:'Нужен простой прототип для магазина.',industry:'Торговля',confirmed:false,published:true};
  await api.post('/api/tasks').send(body).expect(400);
  const task=(await api.post('/api/tasks').send({...body,confirmed:true}).expect(201)).body;
  const input={taskId:task.id,teamId:'team-1',idea:'Соберём простой интерфейс.',plan:'Обсудим сценарий и проверим прототип.',timeline:'Неделя',prototypeUrl:'https://example.org/prototype'};
  const first=(await api.post('/api/proposals').send(input).expect(201)).body;
  const second=(await api.post('/api/proposals').send({...input,teamId:'team-2'}).expect(201)).body;
  await api.patch(`/api/proposals/${first.id}/milestone`).send({}).expect(400);
  await api.patch(`/api/proposals/${first.id}`).send({status:'selected'}).expect(200);
  await api.patch(`/api/proposals/${second.id}`).send({status:'selected'}).expect(200);
  await api.patch(`/api/proposals/${first.id}/milestone`).send({}).expect(200);
  await api.patch(`/api/proposals/${first.id}/milestone`).send({}).expect(200);
  const persisted=(await request(createApp({aiOptions:{apiKey:''},dataFile})).get('/api/state').expect(200)).body;
  assert.equal(persisted.teams.find((t:{id:string})=>t.id==='team-1').points,10);
  assert.equal(persisted.proposals.filter((p:{status:string})=>p.status==='selected').length,2);
  await api.post('/api/proposals').send({...input,prototypeUrl:'javascript:alert(1)'}).expect(400);
  await api.post('/api/tasks').set('Content-Type','application/json').send('null').expect(400);
  await api.post('/api/tasks').set('Content-Type','application/json').send('{bad').expect(400);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('demo clarification preserves facts and returns at least three questions',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'omnipotent-'));
 try{const api=request(createApp({aiOptions:{apiKey:''},dataFile:join(dir,'store.json')}));const description='В магазине постоянно заканчивается молоко.';
 const result=(await api.post('/api/clarify').send({description,industry:'Торговля'}).expect(200)).body;
 assert.equal(result.mode,'demo');assert.equal(result.fields.context,description);assert.equal(result.fields.contact,'');assert.ok(result.questions.length>=3);
 await api.post('/api/clarify').send({description,industry:'Торговля',fields:{data:42}}).expect(400);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
