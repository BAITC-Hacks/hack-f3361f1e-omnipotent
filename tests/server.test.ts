import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { emptyFields } from '../shared/types.js';
import { calculateScore } from '../shared/scoring.js';
import { seedState } from '../server/seed.js';

test('personal accounts isolate drafts and proposals, enforce ownership and persist across restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sana-accounts-'));const dataFile=join(dir,'store.json');
 try {
  const app=createApp({dataFile,aiOptions:{apiKey:''}});
  const business=request.agent(app),other=request.agent(app),team=request.agent(app),otherTeam=request.agent(app);
  const login=await business.post('/api/session').send({role:'business',name:'Мой магазин'}).expect(200);
  const businessId=login.body.profileId;
  const again=await business.post('/api/session').send({role:'business',name:'мой МАГАЗИН'}).expect(200);
  assert.equal(again.body.profileId,businessId);
  await other.post('/api/session').send({role:'business',name:'Другой бизнес'}).expect(200);
  const teamId=(await team.post('/api/session').send({role:'team',name:'Новая команда'}).expect(200)).body.profileId;
  await otherTeam.post('/api/session').send({role:'team',name:'Другая команда'}).expect(200);
  const body={fields:emptyFields(),description:'',industry:'',confirmed:false,published:false};
  const draft=(await business.post('/api/tasks').send(body).expect(201)).body;
  assert.equal(draft.title,'Без названия');assert.equal(draft.businessId,businessId);
  const foreign=(await other.get('/api/state').expect(200)).body;
  assert.equal(foreign.tasks.some((t:{id:string})=>t.id===draft.id),false);
  assert.equal('sessions' in foreign,false);
  await other.put(`/api/tasks/${draft.id}`).send({...body,fields:{...emptyFields(),title:'Украденная'}}).expect(403);
  await request(app).post('/api/tasks').send(body).expect(401);
  await team.post('/api/tasks').send(body).expect(403);
  await business.put(`/api/tasks/${draft.id}`).send({...body,fields:{...emptyFields(),title:'аб'},published:true}).expect(400);
  const task=(await business.put(`/api/tasks/${draft.id}`).send({...body,fields:{...emptyFields(),title:'аб',need:'аю'},confirmed:true,published:true}).expect(200)).body;
  assert.equal(calculateScore(task,true,task.assessment).total,0);
  const input={taskId:task.id,idea:'Есть идея',plan:'Проверим её',timeline:'Неделя',prototypeUrl:''};
  await team.post('/api/proposals').send({...input,teamId:'team-1'}).expect(403);
  const p1=(await team.post('/api/proposals').send(input).expect(201)).body;
  assert.equal(p1.teamId,teamId);
  assert.equal((await other.get('/api/state').expect(200)).body.proposals.length,0);
  assert.equal((await otherTeam.get('/api/state').expect(200)).body.proposals.length,0);
  await other.patch(`/api/proposals/${p1.id}`).send({status:'selected'}).expect(403);
  await team.patch(`/api/proposals/${p1.id}`).send({status:'selected'}).expect(403);
  await business.patch(`/api/proposals/${p1.id}`).send({status:'rejected',feedback:'Нужен другой подход'}).expect(200);
  assert.equal((await team.get('/api/state').expect(200)).body.proposals[0].feedback,'Нужен другой подход');
  const p2=(await otherTeam.post('/api/proposals').send(input).expect(201)).body;
  await business.patch(`/api/proposals/${p1.id}/milestone`).send({}).expect(400);
  for(const p of [p1,p2]) await business.patch(`/api/proposals/${p.id}`).send({status:'selected'}).expect(200);
  await business.patch(`/api/proposals/${p1.id}/milestone`).send({}).expect(200);
  await business.patch(`/api/proposals/${p1.id}/milestone`).send({}).expect(200);
  const own=(await business.get('/api/state').expect(200)).body;
  assert.equal(own.proposals.filter((p:{status:string})=>p.status==='selected').length,2);
  assert.equal(own.teams.find((t:{id:string})=>t.id===teamId).points,10);
  const cookie=again.headers['set-cookie'][0].split(';')[0];
  const restored=request(createApp({dataFile,aiOptions:{apiKey:''}}));
  assert.equal((await restored.get('/api/session').set('Cookie',cookie)).body.profileId,businessId);
  assert.equal((await restored.get('/api/state').set('Cookie',cookie)).body.proposals.length,2);
  await team.post('/api/proposals').send({...input,prototypeUrl:'javascript:alert(1)'}).expect(400);
  await business.post('/api/tasks').set('Content-Type','application/json').send('{bad').expect(400);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('clarification and quality assessment require a business and preserve supplied facts',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sana-clarify-'));
 try{
  const app=createApp({aiOptions:{apiKey:''},dataFile:join(dir,'store.json')});const api=request.agent(app);
  await api.post('/api/clarify').send({description:'Магазин',industry:'Торговля'}).expect(401);
  await api.post('/api/session').send({role:'business',name:'Тест'}).expect(200);
  const result=(await api.post('/api/clarify').send({description:'Магазин',industry:'Торговля'}).expect(200)).body;
  assert.equal(result.fields.context,'Магазин');assert.ok(result.questions.length>=3);
  const rating=(await api.post('/api/assess').send({fields:{...emptyFields(),title:'аб',need:'аю'},description:'',industry:''}).expect(200)).body;
  assert.equal(rating.mode,'fallback');assert.equal(rating.fields.reduce((sum:number,f:{points:number})=>sum+f.points,0),0);
  await api.post('/api/clarify').send({description:'Магазин',industry:'Торговля',fields:{data:42}}).expect(400);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('existing store migration preserves tasks and creates a backup with explicit business ownership',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sana-migrate-'));const dataFile=join(dir,'store.json');
 try{
  const seed=seedState();const {businesses:_,...old}=seed;
  old.tasks=old.tasks.map(t=>{const {businessId:__,...fields}=t;return fields as typeof t;});
  old.tasks.push({...old.tasks[0],id:'custom-old-task',title:'Старая пользовательская задача',published:false});
  writeFileSync(dataFile,JSON.stringify(old));
  const api=request.agent(createApp({dataFile,aiOptions:{apiKey:''}}));
  await api.post('/api/session').send({role:'business',name:'Мой бизнес'}).expect(200);
  const state=(await api.get('/api/state').expect(200)).body;
  assert.ok(state.tasks.some((t:{id:string})=>t.id==='custom-old-task'));
  assert.equal(state.tasks.length,6);assert.equal(readdirSync(dir).filter(p=>p.endsWith('.bak')).length,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
