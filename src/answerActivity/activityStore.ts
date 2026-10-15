import type { appStore, AIAnswerResult, QuestionItem } from '../store/appStore';

export type ActivityKind = 'web-auto' | 'web-read' | 'api-answer' | 'api-apply';
export type ActivityOutcome = 'running' | 'completed' | 'partial' | 'failed' | 'stopped';
export type ActivityFeedback = { id: string; kind: 'extracted' | 'completed'; createdAt: number };
export type AnswerActivity = {
  id: string; kind: ActivityKind; targets: string[]; applied: string[]; resolved: string[];
  skipped: string[]; phase: string; label: string; outcome: ActivityOutcome;
  paused: boolean; indeterminate: boolean; startedAt: number; endedAt?: number;
};
export type ActivitySnapshot = { task: AnswerActivity | null; feedback: ActivityFeedback[] };

export class AnswerActivityStore {
  private state: ActivitySnapshot = { task: null, feedback: [] };
  private listeners = new Set<() => void>();
  private emitted = new Set<string>();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(task: AnswerActivity | null, feedback = this.state.feedback) {
    this.state = { task, feedback };
    this.listeners.forEach(listener => listener());
  }
  begin(id: string, kind: ActivityKind, targets: string[], indeterminate = false) {
    this.update({ id, kind, targets: [...new Set(targets)], applied: [], resolved: [], skipped: [],
      phase: 'starting', label: '正在准备', outcome: 'running', paused: false, indeterminate, startedAt: Date.now() });
  }
  phase(id: string, phase: string, label: string, paused = false) {
    const task = this.state.task;
    if (task?.id === id && task.outcome === 'running') this.update({ ...task, phase, label, paused });
  }
  addTargets(id: string, hashes: string[]) {
    const task = this.state.task;
    if (task?.id === id) this.update({ ...task, targets: [...new Set([...task.targets, ...hashes])] });
  }
  resolved(id: string, hashes: string[]) {
    const task = this.state.task;
    if (task?.id === id && task.outcome === 'running') this.update({ ...task,
      resolved: [...new Set([...task.resolved, ...hashes.filter(hash => task.targets.includes(hash))])] });
  }
  applied(id: string, hash: string) {
    const task = this.state.task;
    if (task?.id !== id || task.outcome !== 'running' || !task.targets.includes(hash) || task.applied.includes(hash)) return;
    this.update({ ...task, applied: [...task.applied, hash] });
  }
  skip(id: string, hashes: string[]) {
    const task = this.state.task;
    if (task?.id === id && task.outcome === 'running') this.update({ ...task, skipped: [...new Set([...task.skipped, ...hashes])] });
  }
  extracted(id: string, requestId: string) { this.feedback(id, `${id}:${requestId}:extracted`, 'extracted'); }
  private feedback(id: string, key: string, kind: ActivityFeedback['kind']) {
    if (this.state.task?.id !== id || this.emitted.has(key)) return;
    this.emitted.add(key);
    if (this.emitted.size > 1000) this.emitted.delete(this.emitted.values().next().value!);
    this.update(this.state.task, [...this.state.feedback.slice(-19), { id: key, kind, createdAt: Date.now() }]);
  }
  finish(id: string, outcome: Exclude<ActivityOutcome, 'running'>, label: string) {
    const task = this.state.task;
    if (task?.id !== id || task.outcome !== 'running') return;
    const success = task.kind === 'api-answer' ? task.resolved.length : task.applied.length;
    const complete = task.targets.length > 0 && success === task.targets.length && task.skipped.length === 0;
    const final = outcome === 'completed' && !complete ? 'partial' : outcome;
    this.update({ ...task, outcome: final, label, paused: false, endedAt: Date.now() });
    if (final === 'completed' && task.kind !== 'web-read') this.feedback(id, `${id}:completed`, 'completed');
  }
}

export function activityProgress(task: AnswerActivity) {
  const count = task.kind === 'api-answer' ? task.resolved.length : task.applied.length;
  const total = task.targets.length;
  const actual = total ? Math.floor(count / total * 100) : 0;
  return { count, total, percent: actual };
}

export const answerActivity = new AnswerActivityStore();
type AppSnapshot = ReturnType<typeof appStore.getState>;
type ApplyResult = { success?: boolean; skipped?: number; partial?: boolean; done?: boolean };
const isSequential = (question?: QuestionItem | null) => Boolean(question &&
  (/reVersionTestStartNew/i.test(question.pageUrl || '') || /singleQuestionDiv|fanyaMarking|questionLi/i.test(question.selector || '')));

function validObservedAnswer(question: QuestionItem | undefined, answer: AIAnswerResult | undefined) {
  if (!question || !answer || answer.questionHash !== question.hash || typeof answer.answer !== 'string' ||
    !answer.answer.trim() || /^No answer recognized$/i.test(answer.answer.trim())) return false;
  if (question.type === 'single' || question.type === 'multiple') {
    const labels = answer.choiceLabels;
    if (!Array.isArray(labels) || !labels.length || new Set(labels).size !== labels.length || question.type === 'single' && labels.length !== 1) return false;
    const available = question.options.map((option, index) => question.optionTargets?.[index]?.label ||
      option.match(/^\s*([A-H])\s*[.\s:\uff1a\u3001\u3002)]/i)?.[1]?.toUpperCase() || String.fromCharCode(65 + index));
    return labels.every(label => available.includes(label));
  }
  if (question.type === 'judgement') return /^(true|false|correct|wrong|正确|错误|对|错)$/i.test(answer.answer.trim());
  return question.type === 'completion' || question.type === 'essay';
}

// Read-only observation; the existing API loops remain the sole task executors.
export class ApiActivityObserver {
  private sequence = 0;
  private run: { id: string; mode: 'live' | 'batch' | 'single' | 'manual'; sequential: boolean; terminal: boolean; changed: boolean; questions: Map<string, QuestionItem> } | null = null;
  private previousStatus = '';
  constructor(private activity: AnswerActivityStore) {}
  observe(state: AppSnapshot, webBusy: boolean) {
    if (webBusy) { this.previousStatus = state.status; return; }
    if (!this.run) {
      const mode = state.liveRunning ? 'live' : state.batchRunning ? 'batch' :
        state.status === 'calling_ai' && this.previousStatus !== 'calling_ai' ? 'single' : null;
      if (mode) {
        const sequential = mode === 'live' && state.questions.some(isSequential);
        const targets = mode === 'single' ? state.currentQuestion ? [state.currentQuestion.hash] : [] : state.questions.map(q => q.hash);
        const id = `api:${Date.now()}:${++this.sequence}`;
        this.run = { id, mode, sequential, terminal: false, changed: false, questions: new Map(state.questions.map(q => [q.hash, q])) };
        this.activity.begin(id, mode === 'live' ? 'api-apply' : 'api-answer', targets, sequential);
      }
    }
    const run = this.run;
    this.previousStatus = state.status;
    if (!run || run.mode === 'manual') return;
    if (run.sequential && !run.terminal) {
      const current = state.currentQuestion;
      if (isSequential(current)) {
        run.questions.set(current!.hash, current!);
        this.activity.addTargets(run.id, [current!.hash]);
      }
      else if (current) run.changed = true;
    }
    const task = this.activity.getSnapshot().task;
    if (task?.id !== run.id) return;
    this.activity.resolved(run.id, task.targets.filter(hash => validObservedAnswer(run.questions.get(hash), state.answerMap[hash])));
    this.activity.phase(run.id, state.livePaused ? 'paused' : state.status, state.statusText, state.livePaused);
    const ended = run.mode === 'live' ? !state.liveRunning : run.mode === 'batch' ? !state.batchRunning : state.status !== 'calling_ai';
    if (!ended) return;
    const terminal = state.status === 'done' && (!run.sequential || run.terminal && !run.changed);
    this.activity.finish(run.id, terminal ? 'completed' : state.status === 'error' ? 'failed' : 'partial', state.statusText);
    this.run = null;
  }
  beginApply(hashes: string[], webBusy: boolean) {
    if (webBusy || this.run) return;
    const id = `apply:${Date.now()}:${++this.sequence}`;
    this.run = { id, mode: 'manual', sequential: false, terminal: false, changed: false, questions: new Map() };
    this.activity.begin(id, 'api-apply', hashes);
    this.activity.phase(id, 'applying', '正在填入答案');
  }
  applied(hash: string) { if (this.run) this.activity.applied(this.run.id, hash); }
  skipped(hash: string) { if (this.run) this.activity.skip(this.run.id, [hash]); }
  finishApply(result: ApplyResult) {
    if (this.run?.mode !== 'manual') return;
    this.activity.finish(this.run.id, result?.success && !result.partial && !result.skipped ? 'completed' : 'partial', result?.success ? '答案填入结束' : '答案填入失败');
    this.run = null;
  }
  nextResult(result: ApplyResult) {
    if (this.run?.sequential && result?.done) this.run.terminal = true;
  }
}

export const apiActivity = new ApiActivityObserver(answerActivity);
