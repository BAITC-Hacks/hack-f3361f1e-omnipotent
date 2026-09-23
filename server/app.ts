import express from 'express';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyFields, type AppState, type Field, type TaskFields, type Proposal } from '../shared/types.js';
import { generateClarification, aiStatus, type AIOptions } from './openai.js';
import { seedState } from './seed.js';

export function createApp({dataFile=resolve('data/store.json'),aiOptions={}}:{dataFile?:string;aiOptions?:AIOptions}={}) {
 const app=express();
 app.disable('x-powered-by');
 app.use(express.json({limit:'128kb'}));
 let state:AppState=existsSync(dataFile)?JSON.parse(readFileSync(dataFile,'utf8')):seedState();
 function persist(next:AppState) {
  mkdirSync(dirname(dataFile),{recursive:true});
  const temporary=`${dataFile}.${process.pid}.tmp`;
  writeFileSync(temporary,JSON.stringify(next,null,2),'utf8');
  renameSync(temporary,dataFile);
  state=next;
 }
 if(!existsSync(dataFile)) persist(state);
 function fail(message:string):never {const error=new Error(message);Object.assign(error,{status:400});throw error;}
 function object(value:unknown):Record<string,unknown> {if(!value||typeof value!=='object'||Array.isArray(value))fail('Ожидается JSON-объект.');return value as Record<string,unknown>;}
 function text(value:unknown,label:string,min=0,max=5000):string {if(typeof value!=='string')fail(`${label}: ожидается текст.`);const clean=(value as string).trim();if(clean.length<min||clean.length>max)fail(`${label}: допустимая длина ${min}–${max} символов.`);return clean;}
 function boolean(value:unknown,label:string):boolean {if(typeof value!=='boolean')fail(`${label}: ожидается логическое значение.`);return value as boolean;}
 function fields(value:unknown):TaskFields {const input=object(value);const result=emptyFields();for(const key of Object.keys(result) as Field[])result[key]=text(input[key],key,key==='title'?3:0,key==='title'?160:5000);return result;}
 app.get('/api/state',(_req,res)=>res.json(state));
 app.get('/api/ai/status',(_req,res)=>res.json(aiStatus(aiOptions)));
 app.post('/api/clarify',async(req,res)=>{
  const input=object(req.body);const description=text(input.description,'Описание',10,5000);const industry=text(input.industry,'Сфера',2,120);
  const supplied:Partial<TaskFields>={};if(input.fields!==undefined){const source=object(input.fields);for(const key of Object.keys(emptyFields()) as Field[])if(source[key]!==undefined)supplied[key]=text(source[key],key,0,5000);}
  res.json(await generateClarification(description,industry,supplied,aiOptions));
 });
 const saveTask:express.RequestHandler=(req,res)=>{
  const input=object(req.body);const existing=req.params.id?state.tasks.find(task=>task.id===req.params.id):undefined;
  if(req.params.id&&!existing){res.status(404).json({error:'Задача не найдена.'});return;}
  const confirmed=boolean(input.confirmed,'Подтверждение');const published=boolean(input.published,'Публикация');
  if(published&&!confirmed)fail('Перед публикацией подтвердите карточку задачи.');
  const now=new Date().toISOString();
  const task={...fields(input.fields),id:existing?.id??randomUUID(),description:text(input.description,'Описание',10,5000),industry:text(input.industry,'Сфера',2,120),confirmed,published,createdAt:existing?.createdAt??now,updatedAt:now};
  persist({...state,tasks:existing?state.tasks.map(t=>t.id===task.id?task:t):[task,...state.tasks]});
  res.status(existing?200:201).json(task);
 };
 app.post('/api/tasks',saveTask);app.put('/api/tasks/:id',saveTask);
 app.post('/api/proposals',(req,res)=>{
  const input=object(req.body);const taskId=text(input.taskId,'Задача',1,100);const teamId=text(input.teamId,'Команда',1,100);
  if(!state.tasks.some(task=>task.id===taskId&&task.published))fail('Отклик доступен только на опубликованную задачу.');
  if(!state.teams.some(team=>team.id===teamId))fail('Команда не найдена.');
  const prototypeUrl=text(input.prototypeUrl,'Ссылка на прототип',8,2048);
  if(prototypeUrl){let valid=false;try{valid=['http:','https:'].includes(new URL(prototypeUrl).protocol);}catch{}if(!valid)fail('Ссылка на прототип должна начинаться с http:// или https://.');}
  const proposal:Proposal={id:randomUUID(),taskId,teamId,idea:text(input.idea,'Идея',10),plan:text(input.plan,'План',10),timeline:text(input.timeline,'Сроки',2,500),prototypeUrl,status:'pending',milestoneConfirmed:false,createdAt:new Date().toISOString()};
  persist({...state,proposals:[proposal,...state.proposals]});res.status(201).json(proposal);
 });
 app.patch('/api/proposals/:id',(req,res)=>{
  const input=object(req.body);if(!['selected','rejected'].includes(input.status as string))fail('Выберите решение: selected или rejected.');
  const old=state.proposals.find(p=>p.id===req.params.id);if(!old){res.status(404).json({error:'Отклик не найден.'});return;}
  const proposal={...old,status:input.status as 'selected'|'rejected'};
  persist({...state,proposals:state.proposals.map(p=>p.id===old.id?proposal:p)});res.json(proposal);
 });
 app.patch('/api/proposals/:id/milestone',(req,res)=>{
  object(req.body);const old=state.proposals.find(p=>p.id===req.params.id);if(!old){res.status(404).json({error:'Отклик не найден.'});return;}
  if(old.status!=='selected')fail('Сначала выберите команду для задачи.');
  const proposal={...old,milestoneConfirmed:true};
  if(!old.milestoneConfirmed)persist({...state,proposals:state.proposals.map(p=>p.id===old.id?proposal:p),teams:state.teams.map(t=>t.id===old.teamId?{...t,points:t.points+10}:t)});
  res.json(proposal);
 });
 app.use('/api',(_req,res)=>res.status(404).json({error:'API-маршрут не найден.'}));
 if(existsSync(resolve('dist/index.html'))){app.use(express.static(resolve('dist')));app.get('/{*path}',(_req,res)=>res.sendFile(resolve('dist/index.html')));}
 app.use((error:Error&{status?:number},_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  const status=error.status&&error.status>=400&&error.status<500?error.status:500;
  res.status(status).json({error:error instanceof SyntaxError?'Некорректный JSON.':status===500?'Не удалось сохранить изменения. Попробуйте ещё раз.':error.message});
 });
 return app;
}
