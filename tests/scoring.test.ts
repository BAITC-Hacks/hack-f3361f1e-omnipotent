import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateScore, RUBRIC } from '../shared/scoring';
import { emptyFields } from '../shared/types';
test('unconfirmed information never earns points', () => {
  const fields = Object.fromEntries(Object.keys(emptyFields()).map(key => [key, 'Подтверждаемые сведения']));
  assert.equal(calculateScore(fields as ReturnType<typeof emptyFields>, false).total, 0);
  assert.equal(calculateScore(fields as ReturnType<typeof emptyFields>, true).total, 100);
});
test('rubric is exactly 100 and multi-field categories require every field', () => {
  assert.equal(RUBRIC.reduce((s,r) => s+r.max, 0), 100);
  const fields = {...emptyFields(), context: 'Текущая ситуация', contact: 'demo@example.org'};
  assert.equal(calculateScore(fields,true).total, 0);
  assert.equal(calculateScore({...fields, need: 'Изменить процесс', interaction:'Еженедельная консультация'},true).total,30);
});
test('scores and readiness change when confirmed information is added or removed', () => {
  const fields = {...emptyFields(), data:'CSV', outcome:'Прототип', success:'Точность 90%', constraints:'2 недели', users:'Менеджеры'};
  assert.equal(calculateScore(fields,true).total,70);
  assert.equal(calculateScore(fields,true).level,'Готовая');
  assert.equal(calculateScore({...fields,data:'   '},true).level,'Рабочая');
  assert.equal(calculateScore(emptyFields(),true).level,'Черновик');
  assert.equal(calculateScore({...fields,context:'Сейчас',need:'Требуется'},true).level,'Приоритетная');
});
