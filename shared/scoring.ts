import type { Field, TaskFields, Score } from './types';
export const RUBRIC: {key: string; label: string; max: number; fields: Field[]}[] = [
  { key: 'context', label: 'Контекст и потребность', max: 20, fields: ['context', 'need'] },
  { key: 'data', label: 'Данные и материалы', max: 20, fields: ['data'] },
  { key: 'outcome', label: 'Ожидаемый результат', max: 15, fields: ['outcome'] },
  { key: 'success', label: 'Критерии успеха', max: 15, fields: ['success'] },
  { key: 'constraints', label: 'Ограничения', max: 10, fields: ['constraints'] },
  { key: 'users', label: 'Пользователи', max: 10, fields: ['users'] },
  { key: 'contact', label: 'Связь с бизнесом', max: 10, fields: ['contact', 'interaction'] },
];
export function calculateScore(fields: TaskFields, confirmed: boolean): Score {
  const items = RUBRIC.map(({key, label, max, fields: keys}) => {
    const missing = keys.filter(key => !fields[key]?.trim());
    return {key, label, max, missing, points: confirmed && missing.length === 0 ? max : 0};
  });
  const total = items.reduce((sum, item) => sum + item.points, 0);
  const level = total < 40 ? 'Черновик' : total < 70 ? 'Рабочая' : total < 90 ? 'Готовая' : 'Приоритетная';
  return {total, level, items, missing: items.flatMap(item => item.missing)};
}
