import snapshots from './seed-assessments.json';
import { assessmentKey } from '../shared/scoring.js';
import type { QualityAssessment, Task } from '../shared/types.js';

// Real, saved AI evaluations of the synthetic starter cards. Never apply a
// snapshot to a user's edited text, even when the task keeps a starter id.
export function withSeedAssessment(task: Task): Task {
 if(task.assessment?.mode==='openai'&&task.assessment.inputKey===assessmentKey(task))return task;
 const snapshot=snapshots.find(row=>row.id===task.id&&row.description===task.description&&row.industry===task.industry&&row.assessment.inputKey===assessmentKey(task));
 if(!snapshot)return task;
 return {...task,assessment:{...snapshot.assessment,notice:'Сохранённая AI-оценка синтетического примера. При редактировании выполняется новая проверка.'} as QualityAssessment};
}
