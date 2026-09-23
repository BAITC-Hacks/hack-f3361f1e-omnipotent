import { FIELD_LABELS, type Field, type TaskFields, type Score, type QualityAssessment } from './types';
export const FIELD_MAX: Record<Field, number> = {title:0,context:10,need:10,users:10,data:20,constraints:10,outcome:15,success:15,contact:5,interaction:5};
export const RUBRIC: {key:string;label:string;max:number;fields:Field[]}[] = [
 {key:'context',label:'Контекст и потребность',max:20,fields:['context','need']},
 {key:'data',label:'Данные и материалы',max:20,fields:['data']},
 {key:'outcome',label:'Ожидаемый результат',max:15,fields:['outcome']},
 {key:'success',label:'Критерии успеха',max:15,fields:['success']},
 {key:'constraints',label:'Ограничения',max:10,fields:['constraints']},
 {key:'users',label:'Пользователи',max:10,fields:['users']},
 {key:'contact',label:'Связь с бизнесом',max:10,fields:['contact','interaction']},
];
const keys=Object.keys(FIELD_MAX) as Field[];
const normalized=(s:string)=>s.trim().replace(/\s+/g,' ');
// Only scored fields participate: the calculation API receives fields, not metadata.
export function assessmentKey(fields:TaskFields,_description='',_industry=''):string {return JSON.stringify(keys.map(key=>[key,normalized(fields[key]??'')]));}
export function potentialForField(field:Field):number{return FIELD_MAX[field];}
// Only unmistakable junk is rejected before AI. Short domain phrases remain evaluable.
export function isMeaningless(value:string,field:Field):boolean {
 const text=normalized(value).toLowerCase();
 if(!text||(field!=='title'&&(text.match(/[\p{L}\d]/gu)??[]).length<=2))return true;
 if(/^(.)\1{3,}$/u.test(text)||/^(тест|test|asdf|qwerty|абракадабра|не знаю|нет|да|n\/a|todo|заполнить)$/u.test(text))return true;
 const words=text.match(/[\p{L}\d]+/gu)??[];
 if(words.length>=3&&new Set(words).size===1)return true;
 // A single unanswered question is not an answer; useful assertions followed by a
 // question remain eligible for semantic evaluation.
 if(/^(?:какие?|какую|как|кто|что|по каким|с кем)(?=\s|$)/u.test(text)&&text.endsWith('?')&&!/[.!;\n]/u.test(text.slice(0,-1)))return true;
 if(/^для сферы\s.*:\s*(?:какие?|какую|как|кто|что|по каким|с кем)\s/u.test(text)&&text.endsWith('?'))return true;
 return false;
}
export const FIELD_HINTS: Record<Field,string> = {
 title:'Коротко назовите задачу: действие и предмет работы.',
 context:'Опишите текущий процесс и возникающую в нём проблему.',
 need:'Уточните, что бизнес хочет изменить и зачем это нужно.',
 users:'Назовите людей, которые будут пользоваться результатом.',
 data:'Укажите доступные материалы, их формат и способ передачи команде.',
 constraints:'Уточните срок, ресурсы и технические ограничения.',
 outcome:'Перечислите, что команда должна передать в конце работы.',
 success:'Опишите проверяемые критерии, по которым вы примете результат.',
 contact:'Укажите рабочий канал связи с ответственным человеком.',
 interaction:'Уточните формат консультаций и частоту обратной связи.',
};
export function localAssessment(fields:TaskFields,description='',industry=''):QualityAssessment {
 return {mode:'fallback',notice:'AI-оценка пока недоступна. Сведения сохранены; баллы не начислены до содержательного анализа.',inputKey:assessmentKey(fields,description,industry),assessedAt:new Date().toISOString(),fields:keys.map(field=>({
 field,max:FIELD_MAX[field],points:0,
 reason:normalized(fields[field]??'')?`«${FIELD_LABELS[field]}»: ответ сохранён, качество ещё не оценено.`:`«${FIELD_LABELS[field]}»: сведения пока не указаны.`,
 improvement:FIELD_HINTS[field],
 }))};
}
export function calculateScore(fields:TaskFields,confirmed:boolean,assessment?:QualityAssessment):Score {
 let evaluated=assessment;
 if(!evaluated||evaluated.mode!=='openai'||evaluated.inputKey!==assessmentKey(fields)||!Array.isArray(evaluated.fields)||evaluated.fields.length!==keys.length||new Set(evaluated.fields.map(f=>f.field)).size!==keys.length||evaluated.fields.some(f=>!Object.hasOwn(FIELD_MAX,f.field)||!Number.isFinite(f.points)||f.points<0||f.points>FIELD_MAX[f.field]||f.max!==FIELD_MAX[f.field]))evaluated=localAssessment(fields);
 const items=RUBRIC.map(({key,label,max,fields:group})=>{const rows=group.map(f=>evaluated!.fields.find(row=>row.field===f)!);const missing=group.filter(f=>!rows.find(row=>row.field===f)?.points);return {key,label,max,missing,points:confirmed?rows.reduce((sum,row)=>sum+Math.floor(row.points),0):0,reason:[...new Set(rows.map(row=>row.reason.trim()).filter(Boolean))].join(' ')};});
 const total=items.reduce((sum,item)=>sum+item.points,0);
 return {total,level:total<40?'Черновик':total<70?'Рабочая':total<90?'Готовая':'Приоритетная',items,missing:items.flatMap(i=>i.missing)};
}
