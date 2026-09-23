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
function fallbackFraction(value:string,field:Field):number {
 if(field==='contact')return /[^\s@]+@[^\s@]+\.[^\s@]+|\+?\d[\d ()-]{7,}|@[a-z\d_]{4,}|(?:https?:\/\/)?t\.me\/[a-z\d_]+/iu.test(value)?0.5:0;
 const words=value.match(/[\p{L}\d]+/gu)??[];
 return words.length>=3?0.5:0.25;
}
export function localAssessment(fields:TaskFields,description='',industry=''):QualityAssessment {
 const values=keys.map(k=>normalized(fields[k]??'').toLowerCase()).filter(Boolean);
 return {mode:'fallback',notice:'Консервативная проверка по правилам, не AI-оценка. Максимум 50/100; для содержательной оценки нужен доступ к OpenAI.',inputKey:assessmentKey(fields,description,industry),assessedAt:new Date().toISOString(),fields:keys.map(field=>{
 const value=fields[field]??'';const meaningless=isMeaningless(value,field)||values.filter(v=>v===normalized(value).toLowerCase()).length>2;
 const points=meaningless?0:Math.floor(FIELD_MAX[field]*fallbackFraction(value,field));
 return {field,max:FIELD_MAX[field],points,reason:meaningless?'Нет конкретного ответа или текст не похож на содержательное заполнение.':'Есть предварительный ответ; смысл и соответствие задаче не проверены AI.',improvement:field==='title'?'Название помогает найти задачу, но баллов не добавляет.':`Уточните поле «${FIELD_LABELS[field]}»: добавьте проверяемые факты, относящиеся к задаче.`};
 })};
}
export function calculateScore(fields:TaskFields,confirmed:boolean,assessment?:QualityAssessment):Score {
 let evaluated=assessment;
 if(!evaluated||evaluated.inputKey!==assessmentKey(fields)||!Array.isArray(evaluated.fields)||evaluated.fields.length!==keys.length||new Set(evaluated.fields.map(f=>f.field)).size!==keys.length||evaluated.fields.some(f=>!Object.hasOwn(FIELD_MAX,f.field)||!Number.isFinite(f.points)||f.points<0||f.points>FIELD_MAX[f.field]||f.max!==FIELD_MAX[f.field]))evaluated=localAssessment(fields);
 const items=RUBRIC.map(({key,label,max,fields:group})=>{const rows=group.map(f=>evaluated!.fields.find(row=>row.field===f)!);const missing=group.filter(f=>!rows.find(row=>row.field===f)?.points);return {key,label,max,missing,points:confirmed?rows.reduce((sum,row)=>sum+Math.floor(row.points),0):0,reason:rows.map(row=>row.reason).join(' ')};});
 const total=items.reduce((sum,item)=>sum+item.points,0);
 return {total,level:total<40?'Черновик':total<70?'Рабочая':total<90?'Готовая':'Приоритетная',items,missing:items.flatMap(i=>i.missing)};
}
