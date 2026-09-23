import { emptyFields, FIELD_LABELS, type Clarification, type Field, type TaskFields } from '../shared/types.js';
// Input: description, industry, fields containing user-supplied strings.
// Output: Clarification. Never infer facts or supply invented answers.
export const SYSTEM_PROMPT = 'Уточни бизнес-задачу. Используй только факты пользователя. Верни fields и минимум три questions {field,question} о недостающих сведениях. Не придумывай контакты, данные, сроки и критерии. Человек подтверждает карточку.';
const questions: Record<Field,string> = {
 title: 'Как коротко назвать задачу?', context: 'Как сейчас устроен процесс?', need: 'Какую конкретную проблему нужно решить?', users: 'Кто будет пользоваться результатом?', data: 'Какие данные и материалы вы можете предоставить?', constraints: 'Какие сроки, бюджет и технические ограничения нужно учесть?', outcome: 'Что команда должна передать в конце работы?', success: 'По каким измеримым признакам вы примете результат?', contact: 'С кем команда сможет связаться?', interaction: 'Как часто и в каком формате вы готовы общаться с командой?',
};
export function clarify(description:string, industry:string, provided:Partial<TaskFields>={}):Clarification {
 const fields=emptyFields();
 for(const key of Object.keys(fields) as Field[]) if(typeof provided[key]==='string') fields[key]=provided[key]!.trim();
 if(!fields.context) fields.context=description;
 const priority: Field[] = ['need','data','outcome','success','constraints','users','contact','interaction','title','context'];
 const missing=priority.filter(key=>!fields[key]);
 const selected=[...missing,...(Object.keys(fields) as Field[]).filter(key=>!missing.includes(key))].slice(0,Math.max(3,Math.min(missing.length,6)));
 return {mode:'demo', notice:'Демонстрационный режим: вопросы формируются по правилам, внешний AI не подключён. Ответы заполняет человек.', fields, questions:selected.map(field=>({field,question:missing.includes(field)?`Для сферы «${industry}»: ${questions[field]}`:`Проверьте поле «${FIELD_LABELS[field]}»: нужны ли уточнения?`}))};
}
export function validateClarification(value:unknown):value is Clarification {
 if(!value||typeof value!=='object') return false;
 const v=value as Clarification;
 return v.mode==='demo'&&typeof v.notice==='string'&&!!v.fields&&Object.keys(emptyFields()).every(k=>typeof v.fields[k as Field]==='string')&&Array.isArray(v.questions)&&v.questions.length>=3&&v.questions.every(q=>q&&q.field in FIELD_LABELS&&typeof q.question==='string'&&q.question.trim().length>0);
}
// Validate a future provider result at one explicit boundary. Preserve only user facts.
export function resolveClarification(value: unknown, description: string, industry: string, fields?: Partial<TaskFields>): Clarification {
 const fallback = clarify(description, industry, fields);
 if (!validateClarification(value)) return {...fallback, notice: fallback.notice + ' Некорректный ответ заменён безопасными вопросами.'};
 return {...value, fields: fallback.fields};
}
export function safeClarify(description:string,industry:string,fields?:Partial<TaskFields>):Clarification {
 return resolveClarification(clarify(description,industry,fields), description, industry, fields);
}
