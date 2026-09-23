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

test('personal accounts isolate drafts, expose published proposals, enforce ownership and persist across restart',async()=>{
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
  assert.ok((await other.get('/api/state').expect(200)).body.proposals.some((p:{id:string})=>p.id===p1.id));
  assert.ok((await otherTeam.get('/api/state').expect(200)).body.proposals.some((p:{id:string})=>p.id===p1.id));
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
  assert.equal((await restored.get('/api/state').set('Cookie',cookie)).body.proposals.filter((p:{taskId:string})=>p.taskId===task.id).length,2);
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

test('public proposals, private drafts, owner status and scoped persistent favorites',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sana-public-'));const dataFile=join(dir,'store.json');
 try {
  const app=createApp({dataFile,aiOptions:{apiKey:''}});const owner=request.agent(app),other=request.agent(app),team=request.agent(app),outsider=request.agent(app);
  await owner.post('/api/session').send({role:'business',name:'Владелец'}).expect(200);
  await other.post('/api/session').send({role:'business',name:'Другой'}).expect(200);
  const login=await team.post('/api/session').send({role:'team',name:'Авторы'}).expect(200);
  await outsider.post('/api/session').send({role:'team',name:'Зрители'}).expect(200);
  const body={fields:{...emptyFields(),title:'Задача'},description:'Описание',industry:'Сфера',confirmed:true,published:true};
  const task=(await owner.post('/api/tasks').send(body).expect(201)).body;
  assert.equal(task.resolution,'open');
  const proposal=(await team.post('/api/proposals').send({taskId:task.id,idea:'Идея',plan:'План',timeline:'Неделя'}).expect(201)).body;
  for(const client of [request(app),owner,other,team,outsider])assert.ok((await client.get('/api/state')).body.proposals.some((p:{id:string})=>p.id===proposal.id));
  await other.patch(`/api/tasks/${task.id}/status`).send({resolution:'solved'}).expect(403);
  await team.patch(`/api/tasks/${task.id}/status`).send({resolution:'solved'}).expect(403);
  await owner.patch(`/api/tasks/${task.id}/status`).send({resolution:'wrong'}).expect(400);
  assert.equal((await owner.patch(`/api/tasks/${task.id}/status`).send({resolution:'solved'}).expect(200)).body.resolution,'solved');
  assert.equal((await owner.put(`/api/tasks/${task.id}`).send(body).expect(200)).body.resolution,'solved');
  await request(app).put(`/api/favorites/${task.id}`).send({}).expect(401);
  await team.put(`/api/favorites/${task.id}`).send({}).expect(200);
  await team.put(`/api/favorites/${task.id}`).send({}).expect(200);
  assert.deepEqual((await team.get('/api/state')).body.favoriteTaskIds,[task.id]);
  assert.deepEqual((await outsider.get('/api/state')).body.favoriteTaskIds,[]);
  const cookie=login.headers['set-cookie'][0].split(';')[0];
  assert.deepEqual((await request(createApp({dataFile,aiOptions:{apiKey:''}})).get('/api/state').set('Cookie',cookie)).body.favoriteTaskIds,[task.id]);
  await owner.put(`/api/tasks/${task.id}`).send({...body,confirmed:false,published:false}).expect(200);
  for(const client of [request(app),other,outsider])assert.ok(!(await client.get('/api/state')).body.proposals.some((p:{id:string})=>p.id===proposal.id));
  for(const client of [owner,team])assert.ok((await client.get('/api/state')).body.proposals.some((p:{id:string})=>p.id===proposal.id));
  await outsider.put(`/api/favorites/${task.id}`).send({}).expect(404);
  await outsider.delete(`/api/favorites/${task.id}`).expect(404);
  await owner.put(`/api/favorites/${task.id}`).send({}).expect(200);
  await owner.delete(`/api/favorites/${task.id}`).expect(200);
  assert.deepEqual((await owner.get('/api/state')).body.favoriteTaskIds,[]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('deletions require ownership and cascade solutions, favorites and awarded progress points',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sana-delete-'));const dataFile=join(dir,'store.json');
 try {
  const app=createApp({dataFile,aiOptions:{apiKey:''}});const owner=request.agent(app),other=request.agent(app),team=request.agent(app),outsider=request.agent(app);
  await owner.post('/api/session').send({role:'business',name:'Владелец'}).expect(200);
  await other.post('/api/session').send({role:'business',name:'Другой'}).expect(200);
  const teamId=(await team.post('/api/session').send({role:'team',name:'Авторы'}).expect(200)).body.profileId;
  await outsider.post('/api/session').send({role:'team',name:'Зрители'}).expect(200);
  const task=(await owner.post('/api/tasks').send({fields:{...emptyFields(),title:'Задача'},description:'Описание',industry:'Сфера',confirmed:true,published:true}).expect(201)).body;
  const submit=async()=> (await team.post('/api/proposals').send({taskId:task.id,idea:'Идея',plan:'План',timeline:'Неделя'}).expect(201)).body;
  const first=await submit();
  await owner.patch(`/api/proposals/${first.id}`).send({status:'selected'}).expect(200);
  await owner.patch(`/api/proposals/${first.id}/milestone`).send({}).expect(200);
  assert.equal((await team.get('/api/state')).body.teams.find((t:{id:string})=>t.id===teamId).points,10);
  await outsider.delete(`/api/proposals/${first.id}`).expect(403);
  await owner.delete(`/api/proposals/${first.id}`).expect(403);
  await team.delete(`/api/proposals/${first.id}`).expect(200);
  assert.equal((await team.get('/api/state')).body.teams.find((t:{id:string})=>t.id===teamId).points,0);
  const second=await submit();
  await owner.patch(`/api/proposals/${second.id}`).send({status:'selected'}).expect(200);
  await owner.patch(`/api/proposals/${second.id}/milestone`).send({}).expect(200);
  await team.put(`/api/favorites/${task.id}`).send({}).expect(200);
  await owner.put(`/api/favorites/${task.id}`).send({}).expect(200);
  await other.delete(`/api/tasks/${task.id}`).expect(403);
  await team.delete(`/api/tasks/${task.id}`).expect(403);
  await request(app).delete(`/api/tasks/${task.id}`).expect(401);
  await owner.delete(`/api/tasks/${task.id}`).expect(200);
  for(const client of [owner,team]){const state=(await client.get('/api/state')).body;assert.ok(!state.tasks.some((t:{id:string})=>t.id===task.id));assert.ok(!state.proposals.some((p:{taskId:string})=>p.taskId===task.id));assert.ok(!state.favoriteTaskIds.includes(task.id));assert.equal(state.teams.find((t:{id:string})=>t.id===teamId).points,0);}
  await owner.delete(`/api/tasks/${task.id}`).expect(404);
  await team.delete(`/api/proposals/${second.id}`).expect(404);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('combined analysis is business-only and validates user-supplied fields',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sana-analyze-'));
 try{
  const app=createApp({aiOptions:{apiKey:''},dataFile:join(dir,'store.json')});const api=request.agent(app);
  const input={description:'В магазине теряются записи',industry:'Торговля',fields:{context:'Пользовательский контекст'}};
  await api.post('/api/analyze').send(input).expect(401);
  await api.post('/api/session').send({role:'team',name:'Команда'}).expect(200);
  await api.post('/api/analyze').send(input).expect(403);
  await api.post('/api/session').send({role:'business',name:'Бизнес'}).expect(200);
  const result=(await api.post('/api/analyze').send(input).expect(200)).body;
  assert.equal(result.fields.context,input.fields.context);assert.ok(result.assessment);assert.ok(Array.isArray(result.questions));
  await api.post('/api/analyze').send({...input,fields:{data:42}}).expect(400);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('analysis assessment is reused during save and solved tasks reject new submissions',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sana-analysis-cache-'));let calls=0;
 try{
  const supplied={...emptyFields(),title:'Учёт продаж',context:'Магазин учитывает продажи в тетради.'};
  const mockFetch:typeof fetch=async()=>{calls++;return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({fields:Object.entries(supplied).map(([field,value])=>({field,value,evidence:[],quality:value?0.5:0,reason:'Частичная информация',improvement:'Уточните сведения',question:'Что нужно уточнить?'}))})}]}]}),{status:200});};
  const app=createApp({dataFile:join(dir,'store.json'),aiOptions:{apiKey:'test-key',fetchImpl:mockFetch}});const owner=request.agent(app),team=request.agent(app);
  await owner.post('/api/session').send({role:'business',name:'Бизнес'}).expect(200);
  await team.post('/api/session').send({role:'team',name:'Команда'}).expect(200);
  const input={description:'Магазин учитывает продажи в тетради.',industry:'Торговля',fields:supplied};
  const analysis=(await owner.post('/api/analyze').send(input).expect(200)).body;
  assert.equal(analysis.assessment.mode,'openai');assert.equal(calls,1);
  const task=(await owner.post('/api/tasks').send({...input,fields:analysis.fields,confirmed:true,published:true}).expect(201)).body;
  assert.equal(calls,1);assert.deepEqual(task.assessment,analysis.assessment);
  await owner.patch(`/api/tasks/${task.id}/status`).send({resolution:'solved'}).expect(200);
  const proposal={taskId:task.id,idea:'Идея',plan:'План',timeline:'Неделя'};
  await team.post('/api/proposals').send(proposal).expect(400);
  await owner.patch(`/api/tasks/${task.id}/status`).send({resolution:'open'}).expect(200);
  await team.post('/api/proposals').send(proposal).expect(201);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('pending AI saves cannot resurrect deleted tasks or commit after logout',async()=>{
 for(const action of ['delete','logout'] as const){
  const dir=mkdtempSync(join(tmpdir(),`sana-race-${action}-`));
  try{
   let release!:()=>void;let started!:()=>void;
   const waiting=new Promise<void>(resolve=>{release=resolve;});const requested=new Promise<void>(resolve=>{started=resolve;});
   const mockFetch:typeof fetch=async()=>{started();await waiting;return new Response('',{status:503});};
   const app=createApp({dataFile:join(dir,'store.json'),aiOptions:{apiKey:'test-key',fetchImpl:mockFetch}});const owner=request.agent(app);
   await owner.post('/api/session').send({role:'business',name:'Бизнес'}).expect(200);
   const input={description:'Магазин',industry:'Торговля',fields:{...emptyFields(),title:'Задача'},confirmed:false,published:false};
   const task=(await owner.post('/api/tasks').send(input).expect(201)).body;
   const pending=owner.put(`/api/tasks/${task.id}`).send({...input,confirmed:true}).then(response=>response);
   await requested;
   if(action==='delete')await owner.delete(`/api/tasks/${task.id}`).expect(200);else await owner.delete('/api/session').expect(200);
   release();assert.equal((await pending).status,action==='delete'?409:401);
   await owner.post('/api/session').send({role:'business',name:'Бизнес'}).expect(200);
   const tasks=(await owner.get('/api/state')).body.tasks;
   if(action==='delete')assert.ok(!tasks.some((t:{id:string})=>t.id===task.id));else assert.equal(tasks.find((t:{id:string})=>t.id===task.id).confirmed,false);
  }finally{rmSync(dir,{recursive:true,force:true});}
 }
});
