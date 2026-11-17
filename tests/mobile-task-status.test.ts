import { describe, expect, it } from 'vitest';
import { mobileTaskStatus } from '../src/mobile/taskStatus';
import type { AnswerActivity } from '../src/answerActivity/activityStore';

const task = (patch: Partial<AnswerActivity> = {}): AnswerActivity => ({ id: '1', kind: 'web-auto', targets: ['a', 'b'], applied: ['a'],
  resolved: ['a', 'b'], skipped: [], phase: 'waiting_answer', label: 'private question and account', outcome: 'running', paused: false,
  indeterminate: false, startedAt: 1, ...patch });
describe('mobile task status', () => {
  it('uses actual filled count and omits page labels and question data', () => {
    const status = mobileTaskStatus([task()]);
    expect(status).toMatchObject({ running: true, completed: 1, total: 2, phase: '正在等待 AI 回答' });
    expect(JSON.stringify(status)).not.toContain('private');
  });
  it('aggregates active tasks without counting old completed tasks', () => {
    expect(mobileTaskStatus([task(), task({ id: '2', paused: true }), task({ outcome: 'completed' })]))
      .toMatchObject({ completed: 2, total: 4, paused: false, title: '2 个答题任务' });
  });
  it('counts API answers, reports skipped separately, and keeps partial as partial', () => {
    expect(mobileTaskStatus([task({ kind: 'api-answer', outcome: 'partial', phase: 'partial', skipped: ['b'] })]))
      .toMatchObject({ running: false, completed: 2, skipped: 1, outcome: 'partial' });
  });
  it('chooses the most recent terminal task and preserves busy before targets exist', () => {
    expect(mobileTaskStatus([task({ outcome: 'failed', endedAt: 4 }), task({ outcome: 'completed', endedAt: 3 })]).outcome).toBe('failed');
    expect(mobileTaskStatus([], true)).toMatchObject({ running: true, indeterminate: true, total: 0 });
    expect(mobileTaskStatus([task({ paused: true })]).paused).toBe(true);
    expect(mobileTaskStatus([task({ outcome: 'completed', phase: 'waiting_answer' })]).phase).toBe('答题已完成');
  });
});
