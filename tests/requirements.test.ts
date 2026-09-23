import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { seedState } from '../server/seed.js';
import { createApp } from '../server/app.js';
import { emptyFields, type Field, type Task, type Proposal } from '../shared/types.js';
import { FIELD_MAX, assessmentKey, calculateScore } from '../shared/scoring.js';

test('demo supplies five of every entity with full task schema and valid saved assessments',()=>{
 const state=seedState();
 for(const collection of [state.drafts,state.tasks,state.teams,state.proposals])assert.ok(collection.length>=5);
 const totals:number[]=[];
 for(const task of state.tasks){
  for(const key of Object.keys(emptyFields()) as Field[])assert.equal(typeof task[key],'string',`${task.id}.${key}`);
  assert.ok(state.businesses.some(b=>b.id===task.businessId));
  assert.equal(task.assessment?.mode,'openai');assert.equal(task.assessment?.inputKey,assessmentKey(task));
  assert.equal(task.assessment?.fields.length,10);
  assert.equal(new Set(task.assessment?.fields.map(row=>row.field)).size,10);
  for(const row of task.assessment!.fields){assert.equal(row.max,FIELD_MAX[row.field]);assert.ok(row.points>=0&&row.points<=row.max);if(!task[row.field].trim())assert.equal(row.points,0);}
  totals.push(calculateScore(task,task.confirmed,task.assessment).total);
 }
 assert.ok(new Set(totals).size>=3,'seed demonstrates visibly different readiness scores');
 for(const team of state.teams){assert.ok(team.name);assert.ok(team.interests.length);assert.ok(team.skills.length);assert.ok(team.technologies.length);assert.equal(team.points,0);}
 for(const proposal of state.proposals){assert.equal(proposal.status,'pending');assert.equal(proposal.milestoneConfirmed,false);assert.ok(state.tasks.some(task=>task.id===proposal.taskId));assert.ok(state.teams.some(team=>team.id===proposal.teamId));assert.ok(proposal.idea&&proposal.plan&&proposal.timeline);}
});

test('low-score tasks accept multiple teams and businesses alone select several or reject all',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sana-requirements-selection-'));
 try{
  const app=createApp({dataFile:join(dir,'store.json'),aiOptions:{apiKey:''}});const owner=request.agent(app),teamA=request.agent(app),teamB=request.agent(app),foreign=request.agent(app);
  await owner.post('/api/session').send({role:'business',name:'Магазин У дома'}).expect(200);
  await foreign.post('/api/session').send({role:'business',name:'Чужой бизнес'}).expect(200);
  await teamA.post('/api/session').send({role:'team',name:'Орбита'}).expect(200);
  await teamB.post('/api/session').send({role:'team',name:'Алгоритм'}).expect(200);
  const task=seedState().tasks[0];assert.ok(calculateScore(task,true,task.assessment).total<40);
  const input={taskId:task.id,idea:'Проверим процесс',plan:'Соберём прототип',timeline:'Две недели'};
  const a=(await teamA.post('/api/proposals').send(input).expect(201)).body;
  const b=(await teamB.post('/api/proposals').send(input).expect(201)).body;
  assert.equal(a.status,'pending');assert.equal(b.status,'pending');
  await teamA.patch(`/api/proposals/${a.id}`).send({status:'selected'}).expect(403);
  await foreign.patch(`/api/proposals/${a.id}`).send({status:'selected'}).expect(403);
  for(const id of [a.id,b.id])await owner.patch(`/api/proposals/${id}`).send({status:'selected'}).expect(200);
  let state=(await owner.get('/api/state')).body;
  assert.equal(state.proposals.filter((p:Proposal)=>p.taskId===task.id&&p.status==='selected').length,2);
  assert.equal(state.proposals.find((p:Proposal)=>p.id==='proposal-1').status,'pending');
  assert.ok(state.teams.every((team:{points:number})=>team.points===0),'selection alone must not award milestone points');
  for(const id of [a.id,b.id])await owner.patch(`/api/proposals/${id}`).send({status:'rejected'}).expect(200);
  state=(await owner.get('/api/state')).body;
  assert.equal(state.proposals.filter((p:Proposal)=>p.taskId===task.id&&p.status==='selected').length,0);
  for(const forbidden of ['sessions','favorites','apiKey','OPENAI_API_KEY'])assert.equal(forbidden in state,false);
  const invalid={fields:{...emptyFields(),title:'Новая задача'},description:'Описание',industry:'Торговля',confirmed:false,published:true};
  await owner.post('/api/tasks').send(invalid).expect(400);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('confirmed meaningful revision upgrades saved readiness and survives process restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sana-requirements-rating-'));const dataFile=join(dir,'store.json');
 try{
  const mockFetch:typeof fetch=async(_url,init)=>{
   const source=JSON.parse(JSON.parse(String(init?.body)).input).fields;
   const payload={fields:(Object.keys(FIELD_MAX) as Field[]).map(field=>({field,quality:source[field]&&source[field]!=='аю'?1:0,reason:'Оценка тестовой модели по подтверждённому ответу',improvement:''}))};
   return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(payload)}]}]}),{status:200});
  };
  const app=createApp({dataFile,aiOptions:{apiKey:'test-only',fetchImpl:mockFetch}});const owner=request.agent(app);
  const login=await owner.post('/api/session').send({role:'business',name:'Проверка рейтинга'}).expect(200);
  const base={fields:{...emptyFields(),title:'Учёт запасов',need:'аю'},description:'Нужен учёт остатков магазина.',industry:'Торговля',confirmed:true,published:true};
  const first=(await owner.post('/api/tasks').send(base).expect(201)).body as Task;
  assert.equal(calculateScore(first,true,first.assessment).total,0);
  const fields={title:'Учёт запасов',context:'Магазин записывает продажи в бумажный журнал.',need:'Снизить число отсутствующих товаров на полке.',users:'Два кассира и управляющий магазина.',data:'CSV продаж за 3 месяца передадим команде.',constraints:'Срок 2 недели, без платных интеграций.',outcome:'Веб-прототип учёта остатков и инструкция.',success:'Все 5 контрольных продаж правильно уменьшают остаток.',contact:'owner@example.com',interaction:'Созвон каждую пятницу и чат для вопросов.'};
  const upgraded=(await owner.put(`/api/tasks/${first.id}`).send({...base,fields}).expect(200)).body as Task;
  assert.equal(calculateScore(upgraded,true,upgraded.assessment).total,100);assert.equal(calculateScore(upgraded,true,upgraded.assessment).level,'Приоритетная');
  const cookie=login.headers['set-cookie'][0].split(';')[0];
  const restored=request(createApp({dataFile,aiOptions:{apiKey:''}}));
  const saved=(await restored.get('/api/state').set('Cookie',cookie)).body.tasks.find((task:Task)=>task.id===first.id) as Task;
  assert.equal(calculateScore(saved,saved.confirmed,saved.assessment).total,100);
  const reassessed=(await restored.post('/api/assess').set('Cookie',cookie).send({fields,description:base.description,industry:base.industry}).expect(200)).body;
  assert.equal(reassessed.mode,'openai');assert.equal(reassessed.fields.reduce((sum:number,row:{points:number})=>sum+row.points,0),100);
  const resaved=(await restored.put(`/api/tasks/${first.id}`).set('Cookie',cookie).send({...base,fields}).expect(200)).body as Task;
  assert.equal(calculateScore(resaved,true,resaved.assessment).total,100,'Unchanged card keeps its score when AI is offline after restart');
  const draft=(await restored.put(`/api/tasks/${first.id}`).set('Cookie',cookie).send({...base,fields,confirmed:false,published:false}).expect(200)).body as Task;
  assert.equal(calculateScore(draft,draft.confirmed,draft.assessment).total,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
