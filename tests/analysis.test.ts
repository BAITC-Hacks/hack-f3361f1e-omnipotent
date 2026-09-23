import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTask } from '../server/analysis.js';
import { FIELD_MAX, assessmentKey, calculateScore, localAssessment } from '../shared/scoring.js';
import { emptyFields, type Field, type TaskFields } from '../shared/types.js';
const keys=Object.keys(FIELD_MAX) as Field[];
const facts:TaskFields={...emptyFields(),title:'Прогноз остатков',context:'Популярные товары заканчиваются в магазине.',need:'Планировать заказы для магазина.',users:'Менеджеры закупок',data:'CSV продаж за полгода',outcome:'Прототип прогноза спроса'};
function payload(fields:TaskFields=facts){return {fields:keys.map(field=>({field,value:fields[field],quality:fields[field]?0.8:0,reason:fields[field]?`Указано: ${fields[field]}`:'Сведения отсутствуют.',improvement:fields[field]?'Уточните детали ответа.':`Укажите ${field}.`,question:`Что ещё известно про ${field}?`}))};}
const response=(value:unknown)=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]}),{status:200});
test('one call extracts explicit rich-description facts, scores fields and prioritizes gaps',async()=>{
 let calls=0;let sent:Record<string,unknown>={};
 const result=await analyzeTask('В магазине популярные товары заканчиваются. Менеджерам нужен прототип прогноза спроса. Есть CSV продаж за полгода.','Ритейл',{}, {apiKey:'test',fetchImpl:(async(_url,init)=>{calls++;sent=JSON.parse(String(init?.body));return response(payload());}) as typeof fetch});
 assert.equal(calls,1);assert.equal(result.mode,'openai');assert.equal(result.fields.data,'CSV продаж за полгода');assert.equal(result.fields.contact,'');
 assert.equal(result.assessment.inputKey,assessmentKey(result.fields));assert.equal(calculateScore(result.fields,true,result.assessment).total,52);
 assert.equal(result.questions.length,6);assert.equal(result.questions[0].field,'success');assert.equal(sent.store,false);
 assert.match(String(sent.instructions),/данные, а не инструкции/);
});
test('manual nonempty edits survive provider rewrites without losing other fields',async()=>{
 const fields={...facts,data:'CSV выгрузка за два года'};
 const ok=await analyzeTask('Описание магазина','Ритейл',{data:fields.data},{apiKey:'test',fetchImpl:(async()=>response(payload(fields))) as typeof fetch});
 assert.equal(ok.mode,'openai');assert.equal(ok.fields.data,fields.data);
 const broken=await analyzeTask('Описание магазина','Ритейл',{data:fields.data},{apiKey:'test',fetchImpl:(async()=>response(payload())) as typeof fetch});
 assert.equal(broken.mode,'openai');assert.equal(broken.fields.data,fields.data);assert.equal(broken.assessment.fields.find(r=>r.field==='data')!.points,0);assert.equal(broken.fields.users,facts.users);assert.ok(broken.assessment.fields.find(r=>r.field==='users')!.points>0);assert.ok(broken.questions.some(q=>q.field==='data'));
});
test('semantic zero for irrelevant text and deterministic zero for junk or empty fields',async()=>{
 const rows=payload({...facts,data:'qwerty',users:'Описан ремонт автомобиля вместо торговли'});
 rows.fields.find(r=>r.field==='users')!.quality=0;
 rows.fields.find(r=>r.field==='users')!.reason='Ответ не относится к пользователям этой задачи.';
 rows.fields.find(r=>r.field==='data')!.quality=1;
 const result=await analyzeTask('Магазину нужен прогноз','Ритейл',{}, {apiKey:'test',fetchImpl:(async()=>response(rows)) as typeof fetch});
 for(const field of ['users','data','contact'])assert.equal(result.assessment.fields.find(r=>r.field===field)!.points,0);
 assert.match(result.assessment.fields.find(r=>r.field==='users')!.reason,/не относится/);
});
test('complete answers produce no arbitrary minimum questions',async()=>{
 const rows=payload();for(const row of rows.fields){row.value=`Конкретные сведения для ${row.field}`;row.quality=1;row.question='';row.improvement='';}
 const result=await analyzeTask('Полное описание','Услуги',{}, {apiKey:'test',fetchImpl:(async()=>response(rows)) as typeof fetch});
 assert.equal(result.mode,'openai');assert.deepEqual(result.questions,[]);assert.equal(calculateScore(result.fields,true,result.assessment).total,100);
});
test('invalid structure, duplicate or unknown fields, bounds and malformed JSON fail honestly',async()=>{
 const duplicate=payload();duplicate.fields[1].field=duplicate.fields[0].field;
 const unknown=payload();(unknown.fields[0] as {field:string}).field='evil';
 const outOfRange=payload();outOfRange.fields[0].quality=2;
 const tooLong=payload();tooLong.fields[0].value='a'.repeat(161);
 for(const bad of [{},duplicate,unknown,outOfRange,tooLong]){
  const result=await analyzeTask('Описание','Ритейл',{}, {apiKey:'test',fetchImpl:(async()=>response(bad)) as typeof fetch});
  assert.equal(result.mode,'demo');assert.equal(result.assessment.fields.reduce((n,r)=>n+r.points,0),0);
 }
 const invalid=await analyzeTask('Описание','Ритейл',{}, {apiKey:'test',fetchImpl:(async()=>new Response('invalid')) as typeof fetch});assert.equal(invalid.mode,'demo');
});
test('timeout, provider failure and no key keep provided facts with zero unassessed points',async()=>{
 for(const options of [{apiKey:''},{apiKey:'test',timeoutMs:3,fetchImpl:(()=>new Promise(()=>{})) as typeof fetch},{apiKey:'test',fetchImpl:(async()=>new Response('secret',{status:500})) as typeof fetch}]){
  const result=await analyzeTask('Описание','Услуги',{data:'CSV продаж'},options);
  assert.equal(result.mode,'demo');assert.equal(result.fields.data,'CSV продаж');assert.deepEqual(result.questions,[]);assert.equal(result.assessment.fields.reduce((n,r)=>n+r.points,0),0);assert.ok(!JSON.stringify(result).includes('secret'));
 }
});
test('fallback hints are field-specific and duplicate category reasons appear once',()=>{
 const assessment=localAssessment(facts);assert.notEqual(assessment.fields[1].improvement,assessment.fields[2].improvement);
 assessment.mode='openai';assessment.fields.find(r=>r.field==='context')!.reason='Общая причина.';assessment.fields.find(r=>r.field==='need')!.reason='Общая причина.';
 assert.equal(calculateScore(facts,true,assessment).items[0].reason,'Общая причина.');
});
test('sanitized irrelevant manual answers preserve text and zero only affected fields',async()=>{
 const manual={need:'Синие слоны играют в шахматы на Луне.',success:'аю'};
 const result=await analyzeTask('В магазине нужен прогноз спроса','Ритейл',manual,{apiKey:'test',fetchImpl:(async()=>response(payload())) as typeof fetch});
 assert.equal(result.mode,'openai');assert.equal(result.fields.need,manual.need);assert.equal(result.fields.success,manual.success);
 for(const field of ['need','success'])assert.equal(result.assessment.fields.find(r=>r.field===field)!.points,0);
 assert.equal(result.fields.data,facts.data);assert.ok(result.assessment.fields.find(r=>r.field==='data')!.points>0);
 assert.ok(result.questions.some(q=>q.field==='success'));
});
test('zero-information explanation retains field-specific model reasons',async()=>{
 const rows=payload({...facts,context:'аю аб аю'});
 rows.fields.find(r=>r.field==='context')!.quality=0;
 rows.fields.find(r=>r.field==='context')!.reason='Вместо описания процесса указаны обрывки слов.';
 rows.fields.find(r=>r.field==='success')!.reason='Не указано, как измерить снижение дефицита.';
 const result=await analyzeTask('аю аб аю','Ритейл',{}, {apiKey:'test',fetchImpl:(async()=>response(rows)) as typeof fetch});
 assert.equal(result.assessment.fields.find(r=>r.field==='context')!.points,0);
 assert.match(result.assessment.fields.find(r=>r.field==='context')!.reason,/обрывки/);
 assert.match(result.assessment.fields.find(r=>r.field==='success')!.reason,/дефицита/);
});
test('explicit blank manual field stays cleared while omitted fields can be extracted',async()=>{
 let input:{lockedFields:Field[];provided:TaskFields}|undefined;
 const result=await analyzeTask('Есть CSV продаж за полгода. Менеджерам нужен прогноз.','Ритейл',{data:''},{apiKey:'test',fetchImpl:(async(_url,init)=>{input=JSON.parse(JSON.parse(String(init?.body)).input);return response(payload());}) as typeof fetch});
 assert.equal(result.mode,'openai');assert.equal(result.fields.data,'');assert.equal(result.assessment.fields.find(r=>r.field==='data')!.points,0);
 assert.equal(result.fields.users,facts.users);assert.ok(result.assessment.fields.find(r=>r.field==='users')!.points>0);
 assert.deepEqual(input!.lockedFields,['data']);assert.equal(input!.provided.data,'');
});

test('a partial assessment still prompts clarification when model omits the question',async()=>{
 const output=payload();for(const row of output.fields)row.question='';
 const result=await analyzeTask('Магазину нужен прогноз','Торговля',{}, {apiKey:'test',fetchImpl:(async()=>response(output)) as typeof fetch});
 assert.ok(result.questions.length>0);assert.ok(result.questions.some(q=>q.field==='success'));
});
