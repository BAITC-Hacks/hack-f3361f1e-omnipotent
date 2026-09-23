export const FIELD_LABELS = {
  title: 'Название задачи', context: 'Контекст', need: 'Потребность', users: 'Пользователи',
  data: 'Данные и материалы', constraints: 'Ограничения', outcome: 'Ожидаемый результат',
  success: 'Критерии успеха', contact: 'Контакт', interaction: 'Формат взаимодействия',
} as const;
export type Field = keyof typeof FIELD_LABELS;
export type TaskFields = Record<Field, string>;
export interface Task extends TaskFields {
  id: string; businessId: string; assessment?: QualityAssessment; industry: string; description: string; confirmed: boolean; published: boolean;
  createdAt: string; updatedAt: string;
}
export interface FieldQuality { field: Field; points: number; max: number; reason: string; improvement: string }
export interface QualityAssessment { mode: 'openai' | 'fallback'; notice: string; inputKey: string; fields: FieldQuality[]; assessedAt: string }
export interface Business { id: string; name: string }
export interface Identity { role: 'business' | 'team'; profileId: string; name: string }
export interface ScoreItem { key: string; label: string; points: number; max: number; missing: Field[]; reason?: string }
export interface Score { total: number; level: 'Черновик' | 'Рабочая' | 'Готовая' | 'Приоритетная'; items: ScoreItem[]; missing: Field[] }
export interface Team { id: string; name: string; interests: string[]; skills: string[]; technologies: string[]; points: number }
export interface Proposal {
  id: string; taskId: string; teamId: string; idea: string; plan: string; timeline: string; prototypeUrl: string;
  status: 'pending' | 'selected' | 'rejected'; feedback?: string; milestoneConfirmed: boolean; createdAt: string;
}
export interface Draft { description: string; industry: string }
export interface AppState { businesses: Business[]; tasks: Task[]; teams: Team[]; proposals: Proposal[]; drafts: Draft[] }
export interface Question { field: Field; question: string }
export interface Clarification { mode: 'demo' | 'openai'; notice: string; questions: Question[]; fields: TaskFields }
export const emptyFields = (): TaskFields => ({ title: '', context: '', need: '', users: '', data: '', constraints: '', outcome: '', success: '', contact: '', interaction: '' });
