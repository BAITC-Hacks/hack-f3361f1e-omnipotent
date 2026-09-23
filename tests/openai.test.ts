import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { generateClarification, parseQuestions } from '../server/openai';
import { createApp } from '../server/app';

const description='В магазине заканчиваются популярные товары.';
const questions=[
 {field:'need',question:'Какой процесс закупок хотите изменить?'},
 {field:'users',question:'Кто в магазине будет использовать прогноз?'},
 {field:'success',question:'Как вы измерите снижение дефицита товаров?'},
];
const response=(payload:unknown)=>new Response(JSON.stringify(payload),{status:200,headers:{'Content-Type':'application/json'}});
const completed=(text:string)=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}]});

test('real provider contract uses server authorization and preserves only supplied fields', async()=>{
 let called=false;
 const fetchImpl=(async(url,init)=>{
  called=true;
  assert.equal(url,'https://api.openai.com/v1/responses');
  assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer test-server-key');
  const body=JSON.parse(init?.body as string);
  assert.equal(body.store,false);
  assert.equal(body.text.format.strict,true);
  assert.equal(body.model,'gpt-4.1-mini');
  assert.equal(JSON.parse(body.input).fields.data,'CSV продаж');
  return response(completed(JSON.stringify({questions,fields:{contact:'invented@example.org'}})));
 }) as typeof fetch;
 const result=await generateClarification(description,'Торговля',{data:'CSV продаж'},{apiKey:'test-server-key',fetchImpl,model:'gpt-4.1-mini'});
 assert.ok(called);assert.equal(result.mode,'openai');assert.deepEqual(result.questions,questions);
 assert.equal(result.fields.context,description);assert.equal(result.fields.data,'CSV продаж');assert.equal(result.fields.contact,'');
 assert.equal(JSON.stringify(result).includes('test-server-key'),false);
});

test('missing API key makes no network request',async()=>{
 const result=await generateClarification(description,'Торговля',{}, {apiKey:'',fetchImpl:(async()=>{throw new Error('must not call')}) as typeof fetch});
 assert.equal(result.mode,'demo');assert.ok(result.questions.length>=3);
});

test('HTTP errors, invalid output, refusal, network failure and timeout have honest safe fallbacks',async()=>{
 for(const status of [401,403,404,429,500]){
  const result=await generateClarification(description,'Торговля',{}, {apiKey:'test-server-key',fetchImpl:(async()=>new Response('secret provider body',{status})) as typeof fetch});
  assert.equal(result.mode,'demo');assert.match(result.notice,/резервные/);assert.equal(result.notice.includes('secret provider'),false);
 }
 for(const payload of [completed('invalid json'),completed(JSON.stringify({questions:[]})),{status:'incomplete',output:[]},{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]}]){
  const result=await generateClarification(description,'Торговля',{}, {apiKey:'test-server-key',fetchImpl:(async()=>response(payload)) as typeof fetch});
  assert.equal(result.mode,'demo');assert.ok(result.questions.length>=3);
 }
 const failed=await generateClarification(description,'Торговля',{}, {apiKey:'test-server-key',fetchImpl:(async()=>{throw new Error('sensitive transport detail')}) as typeof fetch});
 assert.equal(failed.mode,'demo');assert.equal(failed.notice.includes('sensitive'),false);
 const timed=await generateClarification(description,'Торговля',{}, {apiKey:'test-server-key',timeoutMs:5,fetchImpl:((_,init)=>new Promise((_,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('timeout'))))) as typeof fetch});
 assert.equal(timed.mode,'demo');assert.match(timed.notice,/не ответил/);
});

test('invalid, duplicate and prototype-inherited field names are rejected',()=>{
 for(const qs of [questions.slice(0,2),[...questions,questions[0]],[{field:'constructor',question:'Какой ваш контекст?'},...questions.slice(1)],[{field:'users',question:42},...questions.slice(1)]]) assert.throws(()=>parseQuestions({questions:qs}));
});

test('API awaits OpenAI and status endpoint never exposes a key',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sana-openai-'));
 try{
  const app=createApp({dataFile:join(dir,'store.json'),aiOptions:{apiKey:'test-server-key',model:'gpt-4.1-mini',fetchImpl:(async()=>response(completed(JSON.stringify({questions})))) as typeof fetch}});
  const status=(await request(app).get('/api/ai/status').expect(200)).body;
  assert.deepEqual(status,{configured:true,model:'gpt-4.1-mini'});
  const api=request.agent(app);
  await api.post('/api/session').send({role:'business',name:'AI test'}).expect(200);
  const result=(await api.post('/api/clarify').send({description,industry:'Торговля'}).expect(200)).body;
  assert.equal(result.mode,'openai');assert.equal(JSON.stringify(result).includes('test-server-key'),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
