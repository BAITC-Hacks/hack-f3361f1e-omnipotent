import test from 'node:test';
import assert from 'node:assert/strict';
import { clarify, resolveClarification, validateClarification } from '../server/ai';
test('malformed provider output falls back without losing supplied information', () => {
 for(const broken of [null, 'invalid json', {}, {questions:[]}, {mode:'demo',notice:'',fields:{},questions:[]}]) {
  assert.equal(validateClarification(broken),false);
  const result=resolveClarification(broken,'У магазина нет учёта остатков','Ритейл',{data:'CSV продаж'});
  assert.equal(result.fields.data,'CSV продаж');
  assert.equal(result.fields.contact,'');
  assert.ok(result.questions.length>=3);
  assert.match(result.notice,/Некорректный/);
 }
});
test('even structurally valid provider output cannot invent field values', () => {
 const value=clarify('Нужен учёт остатков магазина','Ритейл');
 value.fields.contact='invented@example.org';
 assert.equal(resolveClarification(value,'Нужен учёт остатков магазина','Ритейл').fields.contact,'');
});
