import { describe, expect, it } from 'vitest';
import { AnswerActivityStore, ApiActivityObserver, activityProgress } from '../src/answerActivity/activityStore';
import { appStore, type QuestionItem } from '../src/store/appStore';

describe('answer activity', () => {
  it('counts only actual successful applications, not extraction or resolved answers', () => {
    const store = new AnswerActivityStore();
    store.begin('run', 'web-auto', ['one', 'two']);
    store.phase('run', 'extracting', '抓题');
    store.resolved('run', ['one', 'two']);
    expect(activityProgress(store.getSnapshot().task!).percent).toBe(0);
    store.applied('run', 'one');
    store.applied('run', 'one');
    store.applied('run', 'other-page');
    expect(activityProgress(store.getSnapshot().task!)).toEqual({ count: 1, total: 2, percent: 50 });
    store.applied('run', 'two');
    expect(activityProgress(store.getSnapshot().task!).percent).toBe(100);
    expect(store.getSnapshot().feedback).toEqual([]);
  });
  it('does not celebrate missing or skipped answers', () => {
    for (const skipped of [false, true]) {
      const store = new AnswerActivityStore();
      store.begin('run', 'web-auto', ['one', 'two']);
      store.applied('run', 'one');
      if (skipped) store.skip('run', ['two']);
      store.finish('run', 'completed', '完成');
      expect(store.getSnapshot().task!.outcome).toBe('partial');
      expect(store.getSnapshot().feedback).toHaveLength(0);
    }
  });
  it('deduplicates extraction and task completion', () => {
    const store = new AnswerActivityStore();
    store.begin('run', 'web-auto', ['one']);
    store.extracted('run', 'batch'); store.extracted('run', 'batch');
    store.applied('run', 'one');
    store.finish('run', 'completed', '完成'); store.finish('run', 'completed', '完成');
    expect(store.getSnapshot().feedback.map(event => event.kind)).toEqual(['extracted', 'completed']);
    expect(activityProgress(store.getSnapshot().task!).percent).toBe(100);
  });
  it('isolates new runs from old answers and ignores stale callbacks', () => {
    const store = new AnswerActivityStore();
    store.begin('old', 'web-auto', ['one']); store.applied('old', 'one');
    store.begin('new', 'web-auto', ['one']); store.applied('old', 'one');
    expect(activityProgress(store.getSnapshot().task!).count).toBe(0);
  });
  it('supports answer-only progress without pretending it has filled the page', () => {
    const store = new AnswerActivityStore();
    store.begin('api', 'api-answer', ['one']); store.resolved('api', ['one']);
    store.finish('api', 'completed', '答案已生成');
    expect(store.getSnapshot().task!.applied).toEqual([]);
    expect(store.getSnapshot().task!.outcome).toBe('completed');
  });
});

describe('read-only API activity observation', () => {
  const q = { id: 'one', hash: 'one', question: 'test', options: [], type: 'single', source: 'webview', capturedAt: 0 } as QuestionItem;
  const state = () => ({ ...appStore.getState(), questions: [q], currentQuestion: q, answerMap: {}, batchRunning: false, liveRunning: false, livePaused: false, status: 'idle' as ReturnType<typeof appStore.getState>['status'] });
  it('ignores extraction and the Web-owned batch flag', () => {
    const store = new AnswerActivityStore(); const observer = new ApiActivityObserver(store);
    observer.observe({ ...state(), status: 'extracting_question' }, false);
    observer.observe({ ...state(), batchRunning: true }, true);
    expect(store.getSnapshot().task).toBeNull();
  });
  it('waits for the API loop to finish and requires actual applications', () => {
    const store = new AnswerActivityStore(); const observer = new ApiActivityObserver(store);
    observer.observe({ ...state(), liveRunning: true }, false);
    observer.observe({ ...state(), liveRunning: true, status: 'done' }, false);
    expect(store.getSnapshot().feedback).toEqual([]);
    observer.applied('one');
    observer.observe({ ...state(), status: 'done' }, false);
    expect(store.getSnapshot().task?.outcome).toBe('completed');
    expect(store.getSnapshot().feedback).toHaveLength(1);
  });
  it('does not celebrate failed API requests counted in status text', () => {
    const store = new AnswerActivityStore(); const observer = new ApiActivityObserver(store);
    observer.observe({ ...state(), liveRunning: true }, false);
    observer.observe({ ...state(), status: 'done', statusText: '已解析 1/1 题，已填入 0 题' }, false);
    expect(store.getSnapshot().task?.outcome).toBe('partial');
    expect(store.getSnapshot().feedback).toEqual([]);
  });
  it('does not count placeholder answers or invalid choice labels as valid query answers', () => {
    for (const answer of ['No answer recognized', 'Apple']) {
      const store = new AnswerActivityStore(); const observer = new ApiActivityObserver(store);
      const snapshot = { ...state(), questions: [{ ...q, options: ['A. Apple'] }], batchRunning: true };
      observer.observe(snapshot, false);
      const invalid = { questionHash: 'one', answer, choiceLabels: answer === 'Apple' ? ['Z'] : [], matchedOptions: [], confidence: 0.75, analysis: '', warnings: [], provider: 'test', model: 'test', createdAt: 0 };
      observer.observe({ ...snapshot, batchRunning: false, status: 'done', answerMap: { one: invalid } }, false);
      expect(activityProgress(store.getSnapshot().task!).count).toBe(0);
      expect(store.getSnapshot().feedback).toEqual([]);
    }
  });
  it('counts valid generated answers against the frozen query targets', () => {
    const store = new AnswerActivityStore(); const observer = new ApiActivityObserver(store);
    const snapshot = { ...state(), questions: [{ ...q, options: ['A. Apple'] }], batchRunning: true };
    observer.observe(snapshot, false);
    const answer = { questionHash: 'one', answer: 'Apple', choiceLabels: ['A'], matchedOptions: ['Apple'], confidence: 0.9, analysis: '', warnings: [], provider: 'test', model: 'test', createdAt: 0 };
    observer.observe({ ...snapshot, questions: [], batchRunning: false, status: 'done', answerMap: { one: answer } }, false);
    expect(store.getSnapshot().task?.outcome).toBe('completed');
  });
  it('requires actual next-question terminal evidence in a sequential exam', () => {
    for (const terminal of [false, true]) {
      const store = new AnswerActivityStore(); const observer = new ApiActivityObserver(store);
      const exam = { ...q, selector: '.singleQuestionDiv' };
      const current = { ...state(), questions: [exam], currentQuestion: exam };
      observer.observe({ ...current, liveRunning: true }, false);
      observer.applied('one');
      if (terminal) observer.nextResult({ done: true });
      observer.observe({ ...current, status: 'done' }, false);
      expect(store.getSnapshot().task?.outcome).toBe(terminal ? 'completed' : 'partial');
    }
  });
  it('resets manual application counts on each task', () => {
    const store = new AnswerActivityStore(); const observer = new ApiActivityObserver(store);
    observer.beginApply(['one'], false); observer.applied('one'); observer.finishApply({ success: true });
    observer.beginApply(['one'], false);
    expect(activityProgress(store.getSnapshot().task!).count).toBe(0);
    observer.finishApply({ success: false });
    expect(store.getSnapshot().task?.outcome).toBe('partial');
  });
});
