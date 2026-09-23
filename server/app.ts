import express from 'express';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyFields, FIELD_LABELS, type AppState, type Field, type Identity, type TaskFields, type Proposal, type Task, type QualityAssessment } from '../shared/types.js';
import { generateClarification, aiStatus, type AIOptions } from './openai.js';
import { evaluateTask } from './evaluation.js';
import { analyzeTask } from './analysis.js';
import { localAssessment, assessmentKey } from '../shared/scoring.js';
import { seedState } from './seed.js';
import { withSeedAssessment } from './seed-assessments.js';

type Store = AppState & { schemaVersion: number; sessions: Record<string, Identity>; favorites: Record<string,string[]> };
const COOKIE = 'sana_session';

export function createApp({dataFile=resolve('data/store.json'),aiOptions={}}:{dataFile?:string;aiOptions?:AIOptions}={}) {
 const app=express();
 app.disable('x-powered-by');
 app.use(express.json({limit:'128kb'}));
 const original=existsSync(dataFile)?JSON.parse(readFileSync(dataFile,'utf8')):seedState();
 if(existsSync(dataFile)&&original.schemaVersion!==3) copyFileSync(dataFile,`${dataFile}.before-accounts-${Date.now()}.bak`);
 const businesses=original.businesses?.length?original.businesses:seedState().businesses;
 if(original.tasks.some((task:Task)=>!task.businessId&&!/^task-[1-5]$/.test(task.id))) businesses.push({id:'business-legacy',name:'Мой бизнес'});
 let state:Store={...original,businesses,schemaVersion:3,sessions:original.sessions??{},favorites:original.favorites??{},tasks:original.tasks.map((task:Task)=>({...task,resolution:task.resolution??'open',businessId:task.businessId??(/^task-[1-5]$/.test(task.id)?`business-${task.id.split('-')[1]}`:'business-legacy')})).map(withSeedAssessment)};
 function persist(next:Store) {
  mkdirSync(dirname(dataFile),{recursive:true});
  const temporary=`${dataFile}.${process.pid}.tmp`;
  writeFileSync(temporary,JSON.stringify(next,null,2),'utf8');
  renameSync(temporary,dataFile);
  state=next;
 }
 persist(state);
 function fail(message:string,status=400):never {throw Object.assign(new Error(message),{status});}
 function object(value:unknown):Record<string,unknown> {if(!value||typeof value!=='object'||Array.isArray(value))fail('Ожидается JSON-объект.');return value as Record<string,unknown>;}
 function text(value:unknown,label:string,min=0,max=5000):string {if(typeof value!=='string')fail(`${label}: ожидается текст.`);const clean=(value as string).trim();if(clean.length<min||clean.length>max)fail(`${label}: допустимая длина ${min}–${max} символов.`);return clean;}
 function boolean(value:unknown,label:string):boolean {if(typeof value!=='boolean')fail(`${label}: ожидается логическое значение.`);return value as boolean;}
 function fields(value:unknown):TaskFields {const input=object(value);const result=emptyFields();for(const key of Object.keys(result) as Field[])result[key]=text(input[key]??'',FIELD_LABELS[key],0,key==='title'?160:5000);return result;}
 function token(req:express.Request) {return (req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1)??'';}
 function identity(req:express.Request) {return state.sessions[token(req)]??null;}
 function requireRole(req:express.Request,role:Identity['role']) {const who=identity(req);if(!who)fail('Войдите в кабинет по имени.',401);if(who.role!==role)fail(role==='business'?'Это действие доступно бизнесу.':'Это действие доступно команде.',403);return who;}
 function requireIdentity(req:express.Request) {const who=identity(req);if(!who)fail('Войдите в кабинет по имени.',401);return who;}
 const favoriteKey=(who:Identity)=>`${who.role}:${who.profileId}`;
 function ownedTask(req:express.Request) {
  const who=requireRole(req,'business');const task=state.tasks.find(t=>t.id===req.params.id);
  if(!task)fail('Задача не найдена.',404);
  if(task.businessId!==who.profileId)fail('Можно изменять только задачи своего бизнеса.',403);
  return task;
 }
 function removeProposals(ids:Set<string>) {
  const removed=state.proposals.filter(p=>ids.has(p.id));
  return {proposals:state.proposals.filter(p=>!ids.has(p.id)),teams:state.teams.map(team=>({...team,points:Math.max(0,team.points-10*removed.filter(p=>p.teamId===team.id&&p.milestoneConfirmed).length)}))};
 }
 function ownedProposal(req:express.Request) {
  const who=requireRole(req,'business');const proposal=state.proposals.find(p=>p.id===req.params.id);
  if(!proposal)fail('Отклик не найден.',404);
  if(!state.tasks.some(t=>t.id===proposal.taskId&&t.businessId===who.profileId))fail('Решение может принять только бизнес, опубликовавший задачу.',403);
  return proposal;
 }
 const evaluations=new Map<string,QualityAssessment>();
 const cacheKey=(owner:string,f:TaskFields,description:string,industry:string)=>JSON.stringify([owner,assessmentKey(f,description,industry),description,industry]);
 async function assess(owner:string,f:TaskFields,description:string,industry:string) {
  const key=cacheKey(owner,f,description,industry);
  const cached=evaluations.get(key);if(cached)return cached;
  const result=await evaluateTask(f,description,industry,aiOptions);
  // A transient provider outage must not permanently prevent retrying the same text.
  if(result.mode==='openai') {if(evaluations.size>=200)evaluations.delete(evaluations.keys().next().value!);evaluations.set(key,result);}
  return result;
 }

 app.get('/api/session',(req,res)=>res.json(identity(req)));
 app.post('/api/session',(req,res)=>{
  const input=object(req.body);if(input.role!=='business'&&input.role!=='team')fail('Выберите бизнес или команду.');
  const role=input.role as Identity['role'];const name=text(input.name,'Название',1,100).replace(/\s+/g,' ');
  const collection=role==='business'?state.businesses:state.teams;
  let profile=collection.find(p=>p.name.toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru'));
  let next={...state};
  if(!profile){
   const id=randomUUID();profile={id,name};
   if(role==='business')next={...next,businesses:[...state.businesses,{id,name}]};
   else next={...next,teams:[...state.teams,{id,name,interests:[],skills:[],technologies:[],points:0}]};
  }
  const who:Identity={role,profileId:profile.id,name:profile.name};const sessionToken=randomUUID();
  const sessions={...state.sessions};delete sessions[token(req)];sessions[sessionToken]=who;
  persist({...next,sessions});res.cookie(COOKIE,sessionToken,{httpOnly:true,sameSite:'lax',maxAge:7*24*60*60*1000,path:'/'});res.json(who);
 });
 app.delete('/api/session',(req,res)=>{const sessions={...state.sessions};delete sessions[token(req)];persist({...state,sessions});res.clearCookie(COOKIE,{path:'/'});res.json({success:true});});
 app.get('/api/state',(req,res)=>{
  const who=identity(req);
  const ownTasks=state.tasks.filter(t=>who?.role==='business'&&t.businessId===who.profileId);
  res.json({businesses:state.businesses,tasks:state.tasks.filter(t=>t.published||ownTasks.includes(t)),teams:state.teams,drafts:state.drafts,
   favoriteTaskIds:who?(state.favorites[favoriteKey(who)]??[]).filter(id=>state.tasks.some(t=>t.id===id&&(t.published||ownTasks.includes(t)))):[],
   proposals:state.proposals.filter(p=>state.tasks.some(t=>t.id===p.taskId&&t.published)||(who?.role==='team'&&p.teamId===who.profileId)||(who?.role==='business'&&ownTasks.some(t=>t.id===p.taskId)))} satisfies AppState);
 });
 app.put('/api/favorites/:id',(req,res)=>{
  const who=requireIdentity(req);const task=state.tasks.find(t=>t.id===req.params.id);
  if(!task||(!task.published&&!(who.role==='business'&&task.businessId===who.profileId)))fail('Задача не найдена.',404);
  const key=favoriteKey(who);const favoriteTaskIds=[...new Set([...(state.favorites[key]??[]),task.id])];
  persist({...state,favorites:{...state.favorites,[key]:favoriteTaskIds}});res.json({favoriteTaskIds});
 });
 app.delete('/api/favorites/:id',(req,res)=>{
  const who=requireIdentity(req);const task=state.tasks.find(t=>t.id===req.params.id);
  if(!task||(!task.published&&!(who.role==='business'&&task.businessId===who.profileId)))fail('Задача не найдена.',404);
  const key=favoriteKey(who);const favoriteTaskIds=(state.favorites[key]??[]).filter(id=>id!==task.id);
  persist({...state,favorites:{...state.favorites,[key]:favoriteTaskIds}});res.json({favoriteTaskIds});
 });
 app.post('/api/analyze',async(req,res)=>{
  const who=requireRole(req,'business');const input=object(req.body);const description=text(input.description,'Описание',1,5000);const industry=text(input.industry??'Другое','Сфера',0,120)||'Другое';
  const supplied:Partial<TaskFields>={};
  if(input.fields!==undefined){const source=object(input.fields);for(const key of Object.keys(emptyFields()) as Field[])if(Object.hasOwn(source,key))supplied[key]=text(source[key],FIELD_LABELS[key],0,key==='title'?160:5000);}
  const result=await analyzeTask(description,industry,supplied,aiOptions);
  requireRole(req,'business'); // Session may have been revoked while AI was running.
  if(result.assessment.mode==='openai'){if(evaluations.size>=200)evaluations.delete(evaluations.keys().next().value!);evaluations.set(cacheKey(who.profileId,result.fields,description,industry),result.assessment);}
  res.json(result);
 });
 app.get('/api/ai/status',(_req,res)=>res.json(aiStatus(aiOptions)));
 app.post('/api/clarify',async(req,res)=>{
  requireRole(req,'business');const input=object(req.body);const description=text(input.description,'Описание',1,5000);const industry=text(input.industry??'Другое','Сфера',0,120)||'Другое';
  const supplied:Partial<TaskFields>={};if(input.fields!==undefined){const source=object(input.fields);for(const key of Object.keys(emptyFields()) as Field[])if(source[key]!==undefined)supplied[key]=text(source[key],FIELD_LABELS[key],0,key==='title'?160:5000);}
  res.json(await generateClarification(description,industry,supplied,aiOptions));
 });
 app.post('/api/assess',async(req,res)=>{
  const who=requireRole(req,'business');const input=object(req.body);const f=fields(input.fields);
  const result=await assess(who.profileId,f,text(input.description??'','Описание'),text(input.industry??'Другое','Сфера',0,120));
  requireRole(req,'business');res.json(result);
 });
 const saveTask:express.RequestHandler=async(req,res)=>{
  const who=requireRole(req,'business');const input=object(req.body);const existing=req.params.id?state.tasks.find(task=>task.id===req.params.id):undefined;
  if(req.params.id&&!existing)fail('Задача не найдена.',404);
  if(existing&&existing.businessId!==who.profileId)fail('Можно редактировать только задачи своего бизнеса.',403);
  const confirmed=boolean(input.confirmed,'Подтверждение');const published=boolean(input.published,'Публикация');const f=fields(input.fields);
  if(published&&!f.title)fail('Добавьте название задачи перед публикацией.');
  if(published&&!confirmed)fail('Перед публикацией отметьте, что проверили сведения. Низкая оценка не мешает публикации.');
  if(!f.title)f.title='Без названия';
  const description=text(input.description??'','Описание');const industry=text(input.industry??'Другое','Сфера',0,120)||'Другое';
  const cached=evaluations.get(cacheKey(who.profileId,f,description,industry));
  const retained=existing?.assessment?.mode==='openai'&&existing.assessment.inputKey===assessmentKey(f)&&existing.description===description&&existing.industry===industry?existing.assessment:undefined;
  const assessment=confirmed?await assess(who.profileId,f,description,industry):cached??retained??localAssessment(f,description,industry);
  requireRole(req,'business'); // Re-check authorization after awaiting the provider.
  if(existing&&state.tasks.find(t=>t.id===existing.id)!==existing)fail('Задача уже изменена. Откройте последнюю версию и повторите сохранение.',409);
  const now=new Date().toISOString();const task:Task={...f,id:existing?.id??randomUUID(),businessId:who.profileId,resolution:existing?.resolution??'open',description,industry,confirmed,published,assessment,createdAt:existing?.createdAt??now,updatedAt:now};
  persist({...state,tasks:existing?state.tasks.map(t=>t.id===task.id?task:t):[task,...state.tasks]});
  res.status(existing?200:201).json(task);
 };
 app.post('/api/tasks',saveTask);app.put('/api/tasks/:id',saveTask);
 app.patch('/api/tasks/:id/status',(req,res)=>{
  const old=ownedTask(req);const input=object(req.body);if(input.resolution!=='open'&&input.resolution!=='solved')fail('Выберите статус open или solved.');
  const task={...old,resolution:input.resolution as 'open'|'solved',updatedAt:new Date().toISOString()};
  persist({...state,tasks:state.tasks.map(t=>t.id===old.id?task:t)});res.json(task);
 });
 app.delete('/api/tasks/:id',(req,res)=>{
  const task=ownedTask(req);const related=new Set(state.proposals.filter(p=>p.taskId===task.id).map(p=>p.id));
  const favorites=Object.fromEntries(Object.entries(state.favorites).map(([key,ids])=>[key,ids.filter(id=>id!==task.id)]));
  persist({...state,...removeProposals(related),tasks:state.tasks.filter(t=>t.id!==task.id),favorites});res.json({success:true});
 });
 app.delete('/api/proposals/:id',(req,res)=>{
  const who=requireRole(req,'team');const proposal=state.proposals.find(p=>p.id===req.params.id);
  if(!proposal)fail('Отклик не найден.',404);if(proposal.teamId!==who.profileId)fail('Можно удалить только решение своей команды.',403);
  persist({...state,...removeProposals(new Set([proposal.id]))});res.json({success:true});
 });
 app.post('/api/proposals',(req,res)=>{
  const who=requireRole(req,'team');const input=object(req.body);const taskId=text(input.taskId,'Задача',1,100);
  if(input.teamId!==undefined&&input.teamId!==who.profileId)fail('Нельзя отправлять решение от имени другой команды.',403);
  const task=state.tasks.find(task=>task.id===taskId&&task.published);
  if(!task)fail('Отклик доступен только на опубликованную задачу.');
  if(task.resolution==='solved')fail('Задача уже решена и не принимает новые решения.');
  const prototypeUrl=text(input.prototypeUrl??'','Ссылка на прототип',0,2048);
  if(prototypeUrl){let valid=false;try{valid=['http:','https:'].includes(new URL(prototypeUrl).protocol);}catch{}if(!valid)fail('Ссылка на прототип должна начинаться с http:// или https://.');}
  const proposal:Proposal={id:randomUUID(),taskId,teamId:who.profileId,idea:text(input.idea,'Идея',1),plan:text(input.plan,'План',1),timeline:text(input.timeline,'Сроки',1,500),prototypeUrl,status:'pending',feedback:'',milestoneConfirmed:false,createdAt:new Date().toISOString()};
  persist({...state,proposals:[proposal,...state.proposals]});res.status(201).json(proposal);
 });
 app.patch('/api/proposals/:id',(req,res)=>{
  const old=ownedProposal(req);const input=object(req.body);if(!['selected','rejected'].includes(input.status as string))fail('Выберите решение: selected или rejected.');
  const proposal={...old,status:input.status as 'selected'|'rejected',feedback:input.feedback===undefined?old.feedback??'':text(input.feedback,'Ответ бизнесa')};
  persist({...state,proposals:state.proposals.map(p=>p.id===old.id?proposal:p)});res.json(proposal);
 });
 app.patch('/api/proposals/:id/milestone',(req,res)=>{
  object(req.body);const old=ownedProposal(req);if(old.status!=='selected')fail('Сначала выберите команду для задачи.');
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
