import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELD_MAX, assessmentKey, calculateScore, localAssessment, potentialForField } from '../shared/scoring.js';
import { emptyFields, type Field, type QualityAssessment } from '../shared/types.js';
const meaningful={...emptyFields(),title:'Учёт остатков',context:'В магазине остатки учитывают вручную каждый вечер.',need:'Снизить число случаев отсутствия популярных товаров.',users:'Два продавца и управляющий магазина.',data:'CSV с продажами за 3 месяца предоставим команде.',constraints:'Срок 2 недели, бюджет 0 тенге.',outcome:'Рабочая веб-форма учёта с выгрузкой CSV.',success:'Все 5 контрольных продаж уменьшают остаток правильно.',contact:'owner@example.com',interaction:'Созвон каждую пятницу и ежедневный чат.'};
test('field maxima sum 100 and represent individual contributions',()=>{assert.equal(Object.values(FIELD_MAX).reduce((a,b)=>a+b,0),100);assert.equal(potentialForField('context'),10);assert.equal(potentialForField('contact'),5);assert.equal(potentialForField('title'),0);});
test('garbage, empty fields, copied questions and unconfirmed inputs do not earn points',()=>{
 const garbage=Object.fromEntries(Object.keys(emptyFields()).map(k=>[k,'аю'])) as typeof meaningful;
 assert.equal(calculateScore(emptyFields(),true).total,0);assert.ok(calculateScore(garbage,true).total<10);
 const copied={...garbage,data:'Какие данные и материалы вы можете предоставить?'};assert.equal(calculateScore(copied,true).total,0);
 assert.equal(calculateScore(meaningful,false).total,0);assert.equal(calculateScore(meaningful,true).total,0, 'Without semantic evaluation no points are invented');
});
test('AI assessments are invalidated when fields change and malformed assessments fall back',()=>{
 const assessment:QualityAssessment={...localAssessment(meaningful),mode:'openai',fields:(Object.keys(FIELD_MAX) as Field[]).map(field=>({field,max:FIELD_MAX[field],points:FIELD_MAX[field],reason:'Конкретный ответ',improvement:''}))};
 assert.equal(calculateScore(meaningful,true,assessment).total,100);
 assert.ok(calculateScore({...meaningful,data:'аю'},true,assessment).total<100);
 assert.equal(assessmentKey(meaningful,'one','retail'),assessmentKey(meaningful,'two','food'));
 assert.ok(calculateScore(meaningful,true,{...assessment,fields:assessment.fields.map(row=>({...row,points:1000}))}).total<=50);
});

test('legacy fallback points never masquerade as a semantic score',()=>{
 const fallback=localAssessment(meaningful);
 fallback.fields=fallback.fields.map(row=>({...row,points:row.max}));
 assert.equal(calculateScore(meaningful,true,fallback).total,0);
});
