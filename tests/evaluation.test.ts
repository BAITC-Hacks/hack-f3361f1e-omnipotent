import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTask } from '../server/evaluation.js';
import { FIELD_MAX } from '../shared/scoring.js';
import { emptyFields } from '../shared/types.js';
const result=(fields:unknown)=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({fields})}]}]}),{status:200});
const rows=()=>Object.keys(FIELD_MAX).map(field=>({field,quality:1,reason:'Достаточно конкретно',improvement:'Уточните детали при встрече.'}));
test('valid model output uses server weights and cannot award points to garbage',async()=>{
 let body:Record<string,unknown>={};
 const fields={...emptyFields(),context:'аю',data:'Таблица продаж за 3 месяца в формате CSV.'};
 const assessment=await evaluateTask(fields,'Магазин','Торговля',{apiKey:'test-secret',fetchImpl:(async(_url,init)=>{body=JSON.parse(String(init?.body));return result(rows());}) as typeof fetch});
 assert.equal(assessment.mode,'openai');assert.equal(assessment.fields.find(r=>r.field==='context')?.points,0);assert.equal(assessment.fields.find(r=>r.field==='data')?.points,20);assert.equal(body.store,false);assert.ok(!JSON.stringify(assessment).includes('test-secret'));
});
test('duplicate, missing, invented or invalid model fields fall back without exposing provider details',async()=>{
 for(const bad of [rows().slice(1),rows().map(r=>({...r,field:'data'})),rows().map(r=>({...r,quality:100})),rows().map(r=>({...r,field:'invented'}))]){
 const assessment=await evaluateTask(emptyFields(),'Описание','Сфера',{apiKey:'test-secret',fetchImpl:(async()=>result(bad)) as typeof fetch});assert.equal(assessment.mode,'fallback');assert.equal(assessment.fields.reduce((sum,r)=>sum+r.points,0),0);assert.ok(!JSON.stringify(assessment).includes('test-secret'));
 }
 const error=await evaluateTask(emptyFields(),'Описание','Сфера',{apiKey:'test-secret',fetchImpl:(async()=>new Response('test-secret',{status:401})) as typeof fetch});assert.ok(!JSON.stringify(error).includes('test-secret'));
});
test('timeout and absent key return labeled conservative fallback',async()=>{
 const timeout=await evaluateTask(emptyFields(),'Описание','Сфера',{apiKey:'test-secret',timeoutMs:5,fetchImpl:(()=>new Promise(()=>{})) as typeof fetch});assert.equal(timeout.mode,'fallback');assert.match(timeout.notice,/вовремя/);
 const offline=await evaluateTask(emptyFields(),'Описание','Сфера',{apiKey:''});assert.equal(offline.mode,'fallback');assert.match(offline.notice,/не AI/);
});

test('short meaningful phrases survive AI validation including Telegram contacts',async()=>{
 const fields={...emptyFields(),users:'Кассиры магазина',data:'CSV продаж',outcome:'Веб-прототип',need:'аналитика',contact:'https://t.me/owner_demo',context:'Остатки теряются каждый день. Как это исправить?'};
 const assessment=await evaluateTask(fields,'Магазин','Торговля',{apiKey:'test-secret',fetchImpl:(async()=>result(rows())) as typeof fetch});
 for(const field of ['users','data','outcome','need','contact','context'])assert.ok(assessment.fields.find(r=>r.field===field)!.points>0,field);
});
