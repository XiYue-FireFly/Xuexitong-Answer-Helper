import { describe, expect, it } from 'vitest';
import { WebAIController } from '../src/webAI/WebAIController';
import { AnswerActivityStore } from '../src/answerActivity/activityStore';
import { appStore, type QuestionItem } from '../src/store/appStore';
import type { WebCommand, WebPageState } from '../src/webAI/browserBridge';

const question: QuestionItem = { id: 'one', hash: 'one', question: 'Choose apple', options: ['A. Apple', 'B. Banana'], type: 'single', source: 'webview', pageUrl: 'https://school.test/work', capturedAt: 0 };

function scenario(items: QuestionItem[] = [question]) {
  let state = { ...appStore.getState(), questions: items, settings: { ...appStore.getState().settings, allowRealPageAutomation: true }, batchRunning: false, liveRunning: false, status: 'idle' as ReturnType<typeof appStore.getState>['status'] };
  let time = 0;
  let prepared: { requestId: string; questions: { id: string }[] } | null = null;
  let sent = false;
  const commands: WebCommand[] = [];
  const applied: string[] = [];
  const imported: string[] = [];
  const activity = new AnswerActivityStore();
  let authState: WebPageState['authState'] = 'ready';
  let composerReady = true;
  let composerEnabled = true;
  let sendWorks = true;
  let asAttachment = false;
  let formatDraft = (value: string) => value;
  let inspectFailures = 0;
  let sourceExtractions = 0;
  let missingFocus = 0;
  let confidence = 0.9;
  let answerRows = (rows: any[], _attempt: number): any[] => rows;
  let sendCount = 0;
  let answerText = (value: string, _attempt: number) => value;
  let pageState = (value: WebPageState, _sent: boolean, _time: number) => value;
  let changed = false;
  let applyResult = { success: true } as { success: boolean; skipped?: number; partial?: boolean; error?: string };
  let afterWait: (() => void | Promise<void>) | undefined;
  let beforeExtract: (() => Promise<void>) | undefined;
  let beforeApply: (() => Promise<void>) | undefined;
  let controller: WebAIController;
  const store = {
    getState: () => state,
    setAutomationRunning: (patch: { batchRunning?: boolean }) => { state = { ...state, ...patch }; },
    setStatus: (status: typeof state.status, statusText: string) => { state = { ...state, status, statusText }; },
    addLog: () => undefined,
    upsertQuestionBank: (item: QuestionItem) => { imported.push(item.hash); },
    setAnswerForQuestion: () => undefined
  };
  const browser = async (command: WebCommand) => {
    commands.push(command);
    if (command.action === 'inspect' && inspectFailures > 0) { inspectFailures--; throw new Error('inspection failed'); }
    if (command.action === 'focus' && command.tabId === 'ai' && missingFocus-- > 0) throw new Error('原标签已关闭，请重新抓题或打开 AI 网站。');
    if (command.action === 'source') return { tabId: 'source', url: question.pageUrl };
    if (command.action === 'open' || command.action === 'focus') return { tabId: command.tabId || 'ai', url: command.tabId === 'source' ? question.pageUrl : 'https://chat.deepseek.com/' };
    if (command.action === 'prepare') {
      prepared = JSON.parse(command.prompt!.slice(command.prompt!.lastIndexOf('\n\n{') + 2));
      sent = false;
    }
    if (command.action === 'send' && sendWorks) { sent = true; sendCount++; }
    return pageState({
      ready: composerReady, inputEnabled: composerEnabled, authState, busy: false, generationState: 'finished', messageKey: prepared?.requestId || '',
      inputText: sent || asAttachment && prepared ? '' : formatDraft((command.prompt || (prepared ? controller.getSnapshot().prompt : 'draft')).replace(/\r\n?/g, '\n').replace(/[\u200B\uFEFF]/g, '')), attempted: command.action === 'send',
      promptReady: Boolean(asAttachment && prepared && !sent), attachmentState: asAttachment && prepared && !sent ? 'ready' : undefined,
      text: sent && prepared ? answerText(JSON.stringify({ requestId: prepared.requestId, answers: answerRows(prepared.questions.map(item => ({
        id: item.id, answer: 'Apple', choiceLabels: ['A'], matchedOptions: ['Apple'], confidence, analysis: '', warnings: []
      })), sendCount) }), sendCount) : ''
    }, sent, time);
  };
  controller = new WebAIController({ store, browser, activity, now: () => time,
    wait: async (ms, signal) => { time += ms; await afterWait?.(); if (signal.aborted) throw new Error('stopped'); if (time > 900000) throw new Error('scenario exceeded wait limit'); },
    notify: () => undefined,
    page: async (channel, detail) => {
      if (channel === 'studypilot:extract-question-request') {
        sourceExtractions++;
        await beforeExtract?.();
        return { success: true, questions: changed ? items.map(item => ({ ...item, question: 'changed' })) : items };
      }
      await beforeApply?.();
      for (const item of detail.items as { question: QuestionItem }[]) applied.push(item.question.hash);
      return applyResult;
    }
  });
  return { controller, activity, commands, applied, imported,
    setLogin: (value: boolean) => { authState = value ? 'ready' : 'required'; }, setConfidence: (value: number) => { confidence = value; },
    setAuthState: (value: WebPageState['authState']) => { authState = value; },
    setComposer: (ready: boolean, enabled = ready) => { composerReady = ready; composerEnabled = enabled; },
    setSendWorks: (value: boolean) => { sendWorks = value; },
    setAttachment: () => { asAttachment = true; },
    setAnswerRows: (transform: typeof answerRows) => { answerRows = transform; },
    setAnswerText: (transform: typeof answerText) => { answerText = transform; },
    setPageState: (transform: typeof pageState) => { pageState = transform; },
    setDraftFormat: (format: typeof formatDraft) => { formatDraft = format; },
    failInspections: (count: number) => { inspectFailures = count; },
    sourceExtractions: () => sourceExtractions,
    setMissingFocus: (attempts: number) => { missingFocus = attempts; },
    changeSource: () => { changed = true; }, state: () => state,
    advanceTime: (milliseconds: number) => { time += milliseconds; },
    onWait: (callback: () => void | Promise<void>) => { afterWait = callback; },
    onExtract: (callback: () => Promise<void>) => { beforeExtract = callback; },
    onApply: (callback: () => Promise<void>) => { beforeApply = callback; },
    setApplyResult: (result: typeof applyResult) => { applyResult = result; },
    setExternalBatchRunning: () => { state = { ...state, batchRunning: true }; }
  };
}

describe('Web automatic controller', () => {
  it.each(['deepseek', 'doubao', 'qwen'] as const)('automatically uses a guest %s composer without account confirmation', async provider => {
    const test = scenario(); test.controller.edit({ provider });
    test.setAuthState('unknown');
    let waits = 0;
    test.onWait(() => { if (++waits > 20) test.controller.stop(); });
    await test.controller.startAutomatic();
    expect(test.controller.getSnapshot().phase).toBe('completed');
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(1);
    expect(test.applied).toEqual(['one']);
  });

  it.each(['deepseek', 'doubao', 'qwen'] as const)('preserves manual sending on %s when account detection is unknown', async provider => {
    const test = scenario();
    test.controller.edit({ flow: 'manual', provider });
    test.controller.generate();
    await test.controller.openWebsite();
    test.setAuthState('unknown');
    let waits = 0;
    test.onWait(() => { if (++waits > 20) test.controller.stop(); });
    await test.controller.send();
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(1);
    expect(test.controller.getSnapshot().reply).not.toBe('');
    expect(test.imported).toEqual([]);
    expect(test.applied).toEqual([]);
  });

  it('does not gate a usable manual composer on login detection', async () => {
    const test = scenario();
    test.controller.generate();
    await test.controller.openWebsite();
    test.setLogin(false);
    await test.controller.send();
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(1);
    expect(test.controller.getSnapshot().reply).not.toBe('');
  });

  it('continues reading after account flags change without resending or requiring login', async () => {
    const test = scenario();
    test.controller.generate();
    await test.controller.openWebsite();
    let interrupted = false;
    test.onWait(() => {
      if (test.controller.getSnapshot().phase === 'waiting_answer' && !interrupted) {
        interrupted = true;
        test.setLogin(false);
      }
    });
    await test.controller.send();
    expect(interrupted).toBe(true);
    expect(test.controller.getSnapshot().phase).toBe('idle');
    expect(test.controller.getSnapshot().reply).not.toBe('');
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(1);
  });

  it('waits for a newly opened AI view to mount before sending', async () => {
    const test = scenario(); test.setMissingFocus(2);
    await test.controller.startAutomatic();
    expect(test.controller.getSnapshot().phase).toBe('completed');
    expect(test.commands.filter(command => command.action === 'open')).toHaveLength(1);
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(1);
  });

  it('ends the mount wait when the new AI tab never becomes available', async () => {
    const test = scenario(); test.setMissingFocus(Infinity);
    await test.controller.startAutomatic();
    expect(test.controller.getSnapshot().phase).toBe('failed');
    expect(test.controller.getSnapshot().message).toContain('未能就绪');
    expect(test.commands.filter(command => command.action === 'focus').length).toBeLessThanOrEqual(51);
    expect(test.commands.some(command => command.action === 'send')).toBe(false);
  });

  it('can stop while the newly opened AI view is mounting', async () => {
    const test = scenario(); test.setMissingFocus(Infinity);
    test.onWait(() => test.controller.stop());
    await test.controller.startAutomatic();
    expect(test.controller.getSnapshot().phase).toBe('stopped');
    expect(test.commands.some(command => command.action === 'send')).toBe(false);
  });

  it('preserves manual approval after automatic extraction on send', async () => {
    const test = scenario(); test.controller.edit({ flow: 'manual' });
    test.controller.generate();
    await test.controller.openWebsite();
    await test.controller.send();
    expect(test.controller.getSnapshot().reply).not.toBe('');
    expect(test.imported).toEqual([]);
    expect(test.applied).toEqual([]);
    test.controller.importPreview();
    expect(test.imported).toEqual(['one']);
    expect(test.applied).toEqual([]);
    await test.controller.approveFill();
    expect(test.applied).toEqual(['one']);
  });

  it('does not acquire or release an existing API batch lock', async () => {
    const test = scenario(); test.setExternalBatchRunning();
    await test.controller.startAutomatic();
    test.controller.stop();
    expect(test.commands).toEqual([]);
    expect(test.state().batchRunning).toBe(true);
    expect(test.controller.getSnapshot().busy).toBe(false);
  });

  it('extracts, generates, opens, sends, validates, imports and fills without submitting', async () => {
    const test = scenario();
    await test.controller.startAutomatic();
    expect(test.controller.getSnapshot().phase).toBe('completed');
    expect(test.applied).toEqual(['one']);
    expect(test.imported).toEqual(['one']);
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(1);
    expect(test.state().batchRunning).toBe(false);
    expect(test.activity.getSnapshot().feedback.map(event => event.kind)).toEqual(['extracted', 'completed']);
  });

  it('keeps scanning after a view unsubscribes and restores the same run', async () => {
    const test = scenario();
    const unsubscribe = test.controller.subscribe(() => undefined);
    const task = test.controller.startAutomatic();
    const runId = test.controller.getSnapshot().runId;
    unsubscribe();
    await task;
    expect(test.controller.getSnapshot().runId).toBe(runId);
    expect(test.applied).toEqual(['one']);
  });

  it('blocks duplicate starts and cancels before a late extraction can send', async () => {
    const test = scenario();
    const first = test.controller.startAutomatic();
    void test.controller.startAutomatic();
    test.controller.stop();
    await first;
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(0);
    expect(test.applied).toEqual([]);
    expect(test.controller.getSnapshot().phase).toBe('stopped');
    expect(test.state().batchRunning).toBe(false);
  });

  it('automatically imports structurally valid low confidence answers without confirmation', async () => {
    const test = scenario(); test.setConfidence(0.4);
    await test.controller.startAutomatic();
    expect(test.controller.getSnapshot().phase).toBe('completed');
    expect(test.controller.getSnapshot().reply).not.toBe('');
    expect(test.imported).toEqual(['one']);
    expect(test.applied).toEqual(['one']);
  });

  it('imports partial answers immediately, resends only missing questions and fills after collection', async () => {
    const test = scenario([question, { ...question, id: 'two', hash: 'two', question: 'Choose fruit again' }]);
    test.setAnswerRows((rows, attempt) => attempt === 1 ? rows.slice(0, 1) : rows);
    const importedBeforeSend: string[][] = [];
    const unsubscribe = test.controller.subscribe(() => {
      if (test.controller.getSnapshot().phase === 'sending') importedBeforeSend.push([...test.imported]);
    });
    test.onApply(async () => { expect(test.imported).toEqual(['one', 'two']); });
    await test.controller.startAutomatic(); unsubscribe();
    const prompts = test.commands.filter(command => command.action === 'prepare').map(command => JSON.parse(command.prompt!.slice(command.prompt!.lastIndexOf('\n\n{') + 2)));
    expect(prompts).toHaveLength(2);
    expect(prompts[1].questions.map((item: any) => item.question)).toEqual(['Choose fruit again']);
    expect(prompts[1].requestId).not.toBe(prompts[0].requestId);
    expect(importedBeforeSend).toContainEqual(['one']);
    expect(test.imported).toEqual(['one', 'two']);
    expect(test.applied).toEqual(['one', 'two']);
    expect(test.controller.getSnapshot().phase).toBe('completed');
  });

  it('resends invalid single-choice rows instead of importing multiple choices', async () => {
    const test = scenario();
    test.setAnswerRows((rows, attempt) => attempt === 1 ? rows.map(row => ({ ...row, choiceLabels: ['A', 'B'], matchedOptions: ['Apple', 'Banana'] })) : rows);
    await test.controller.startAutomatic();
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(2);
    expect(test.imported).toEqual(['one']);
    expect(test.applied).toEqual(['one']);
  });

  it('recovers complete rows from a finished truncated response and resends only the rest', async () => {
    const test = scenario([question, { ...question, id: 'two', hash: 'two', question: 'Truncated fruit' }]);
    test.setAnswerText((value, attempt) => attempt === 1 ? value.slice(0, value.indexOf(',{"id":"q2"') + 12) : value);
    await test.controller.startAutomatic();
    expect(test.controller.getSnapshot().phase).toBe('completed');
    expect(test.imported).toEqual(['one', 'two']);
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(2);
    const second = test.commands.filter(command => command.action === 'prepare')[1].prompt!;
    const payload = JSON.parse(second.slice(second.lastIndexOf('\n\n{') + 2));
    expect(payload.questions.map((item: any) => item.question)).toEqual(['Truncated fruit']);
  });

  it('retries a finished malformed response with no recoverable rows instead of waiting forever', async () => {
    const test = scenario();
    test.setAnswerText((value, attempt) => attempt === 1 ? '回答格式异常' : value);
    await test.controller.startAutomatic();
    expect(test.controller.getSnapshot().phase).toBe('completed');
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(2);
    expect(test.imported).toEqual(['one']);
  });

  it('does not resend while an old assistant message only changes rendering before the new response', async () => {
    const test = scenario();
    test.setPageState((state, sent, time) => !sent || time < 9000
      ? { ...state, text: sent ? 'old assistant answer\n altered rendering' : 'old assistant answer', messageKey: 'old-message' }
      : state);
    await test.controller.startAutomatic();
    expect(test.controller.getSnapshot().phase).toBe('completed');
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(1);
    expect(test.imported).toEqual(['one']);
    expect(test.applied).toEqual(['one']);
  });

  it('bounds automatic missing-answer retries, retains imports and resumes only unresolved questions', async () => {
    const test = scenario([question, { ...question, id: 'two', hash: 'two', question: 'Missing fruit' }]);
    test.setAnswerRows((rows, attempt) => attempt === 1 ? rows.slice(0, 1) : []);
    await test.controller.startAutomatic();
    expect(test.controller.getSnapshot()).toMatchObject({ phase: 'failed', canRetry: true, visible: true });
    expect(test.imported).toEqual(['one']);
    expect(test.applied).toEqual([]);
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(4);
    test.setAnswerRows(rows => rows);
    await test.controller.retry();
    expect(test.imported).toEqual(['one', 'two']);
    expect(test.applied).toEqual(['one', 'two']);
    expect(test.controller.getSnapshot().phase).toBe('completed');
  });

  it('keeps valid warnings without requiring manual confirmation', async () => {
    const test = scenario();
    test.setAnswerRows(rows => rows.map(row => ({ ...row, warnings: ['请复核'] })));
    await test.controller.startAutomatic();
    expect(test.controller.getSnapshot().completedItems[0].answer.warnings).toEqual(['请复核']);
    expect(test.applied).toEqual(['one']);
  });

  it('keeps the sidebar closed after normal automatic extraction', async () => {
    const test = scenario();
    const visibleDuringImport: boolean[] = [];
    test.controller.subscribe(() => {
      if (test.controller.getSnapshot().phase === 'importing') visibleDuringImport.push(test.controller.getSnapshot().visible);
    });
    await test.controller.startAutomatic();
    expect(visibleDuringImport.length).toBeGreaterThan(0);
    expect(visibleDuringImport.every(value => !value)).toBe(true);
  });

  it('collapses automatic tasks at startup while preserving the manual extraction dialog', async () => {
    const automatic = scenario(); automatic.controller.edit({ visible: true });
    automatic.onExtract(async () => { expect(automatic.controller.getSnapshot().visible).toBe(false); });
    await automatic.controller.startAutomatic();
    const manual = scenario(); manual.controller.edit({ flow: 'manual', visible: true });
    await manual.controller.extractQuestions();
    expect(manual.controller.getSnapshot().visible).toBe(true);
  });

  it('preserves the no-50-question limit in the automatic path', async () => {
    const items = Array.from({ length: 137 }, (_, index) => ({ ...question, id: `id-${index}`, hash: `hash-${index}` }));
    const test = scenario(items);
    await test.controller.startAutomatic();
    expect(test.applied).toHaveLength(137);
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(1);
  });

  it('automatically handles multiple batches and keeps oversized questions intact', async () => {
    const items = [
      { ...question, id: 'large1', hash: 'large1', question: 'x'.repeat(170000) },
      { ...question, id: 'huge', hash: 'huge', question: 'x'.repeat(310000) },
      { ...question, id: 'large2', hash: 'large2', question: 'x'.repeat(170000) }
    ];
    const test = scenario(items);
    await test.controller.startAutomatic();
    expect(test.applied).toEqual(['large1', 'large2']);
    expect(test.controller.getSnapshot().phase).toBe('partial');
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(2);
    expect(items[1].question.length).toBe(310000);
    expect(test.activity.getSnapshot().feedback.filter(event => event.kind === 'completed')).toHaveLength(0);
  });

  it('retains all skipped originals and does not open AI if none can be sent', async () => {
    const test = scenario([{ ...question, question: 'x'.repeat(310000) }]);
    await test.controller.startAutomatic();
    expect(test.commands.some(command => command.action === 'open')).toBe(false);
    expect(test.controller.getSnapshot().phase).toBe('partial');
  });

  it('uses a ready composer even when account detection reports login required', async () => {
    const test = scenario(); test.setLogin(false);
    await test.controller.startAutomatic();
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(1);
    expect(test.controller.getSnapshot().phase).toBe('completed');
  });

  it('retains answers but refuses to fill a changed source page', async () => {
    const test = scenario();
    test.onWait(() => test.changeSource());
    await test.controller.startAutomatic();
    expect(test.controller.getSnapshot().phase).toBe('failed');
    expect(test.imported).toEqual(['one']);
    expect(test.applied).toEqual([]);
  });

  it('does not celebrate a skipped or failed application', async () => {
    for (const result of [{ success: true, skipped: 1, partial: true }, { success: false, error: 'failed' }]) {
      const test = scenario(); test.setApplyResult(result);
      await test.controller.startAutomatic();
      expect(test.controller.getSnapshot().phase).toBe(result.success ? 'partial' : 'failed');
      expect(test.activity.getSnapshot().feedback.map(event => event.kind)).toEqual(['extracted']);
    }
  });

  it('stops before sending without extracting a success event', async () => {
    const test = scenario(); test.setLogin(false);
    test.onWait(() => test.controller.stop());
    await test.controller.startAutomatic();
    expect(test.commands.some(command => command.action === 'send')).toBe(false);
    expect(test.activity.getSnapshot().feedback).toEqual([]);
    expect(test.controller.getSnapshot().phase).toBe('stopped');
  });

  it.each(['manual', 'automatic'] as const)('fails promptly with a retry action when %s has no input', async flow => {
    const test = scenario(); test.controller.edit({ flow });
    if (flow === 'manual') { test.controller.generate(); await test.controller.openWebsite(); }
    test.setComposer(false);
    await (flow === 'manual' ? test.controller.send() : test.controller.startAutomatic());
    expect(test.controller.getSnapshot()).toMatchObject({ phase: 'failed', canRetry: true, busy: false });
    expect(test.controller.getSnapshot().message).toContain('重试');
    expect(test.controller.getSnapshot().message).not.toContain('登录');
    expect(test.commands.some(command => command.action === 'send')).toBe(false);
    const requestId = test.controller.getSnapshot().batch?.requestId;
    const extractions = test.sourceExtractions();
    test.setComposer(true);
    await test.controller.retry();
    expect(test.controller.getSnapshot().phase).toBe(flow === 'manual' ? 'idle' : 'completed');
    expect(test.controller.getSnapshot().batch?.requestId).toBe(requestId);
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(1);
    expect(test.sourceExtractions()).toBe(extractions + (flow === 'automatic' ? 1 : 0));
  });

  it('reports a disabled input as retryable without requesting login', async () => {
    const test = scenario(); test.setComposer(true, false);
    await test.controller.startAutomatic();
    expect(test.controller.getSnapshot()).toMatchObject({ phase: 'failed', canRetry: true });
    expect(test.controller.getSnapshot().message).not.toContain('登录');
    expect(test.commands.some(command => command.action === 'prepare')).toBe(false);
  });

  it.each(['manual', 'automatic'] as const)('retries %s sending at the failed batch without extracting again', async flow => {
    const test = scenario(); test.controller.edit({ flow });
    if (flow === 'manual') { test.controller.generate(); await test.controller.openWebsite(); }
    test.setSendWorks(false);
    await (flow === 'manual' ? test.controller.send() : test.controller.startAutomatic());
    expect(test.controller.getSnapshot()).toMatchObject({ phase: 'failed', canRetry: true });
    expect(test.controller.getSnapshot().message).toContain('重试');
    expect(test.controller.getSnapshot().message).not.toContain('登录');
    const requestId = test.controller.getSnapshot().batch?.requestId;
    test.setSendWorks(true);
    await test.controller.retry();
    expect(test.controller.getSnapshot().phase).toBe(flow === 'manual' ? 'idle' : 'completed');
    expect(test.controller.getSnapshot().batch?.requestId).toBe(requestId);
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(2);
  });

  it.each(['manual', 'automatic'] as const)('retries %s sending when question text contains editor zero-width characters', async flow => {
    const test = scenario([{ ...question, question: 'Choose\u200Bapple\uFEFF' }]); test.controller.edit({ flow });
    if (flow === 'manual') { test.controller.generate(); await test.controller.openWebsite(); }
    test.setSendWorks(false);
    await (flow === 'manual' ? test.controller.send() : test.controller.startAutomatic());
    expect(test.controller.getSnapshot()).toMatchObject({ phase: 'failed', canRetry: true });
    test.setSendWorks(true);
    await test.controller.retry();
    expect(test.controller.getSnapshot().phase).toBe(flow === 'manual' ? 'idle' : 'completed');
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(2);
  });

  it.each(['manual', 'automatic'] as const)('retries %s sending after editor paragraph formatting changes', async flow => {
    const test = scenario(); test.controller.edit({ flow });
    test.setDraftFormat(value => value.replace(/\n\n/g, '\n'));
    if (flow === 'manual') { test.controller.generate(); await test.controller.openWebsite(); }
    test.setSendWorks(false);
    await (flow === 'manual' ? test.controller.send() : test.controller.startAutomatic());
    expect(test.controller.getSnapshot()).toMatchObject({ phase: 'failed', canRetry: true });
    test.setSendWorks(true);
    await test.controller.retry();
    expect(test.controller.getSnapshot().phase).toBe(flow === 'manual' ? 'idle' : 'completed');
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(2);
  });

  for (const provider of ['deepseek', 'doubao', 'qwen'] as const) {
    it.each(['manual', 'automatic'] as const)(`retries %s sending of a converted ${provider} TXT from the failed batch`, async flow => {
      const test = scenario(); test.controller.edit({ flow, provider }); test.setAttachment();
      if (flow === 'manual') { test.controller.generate(); await test.controller.openWebsite(); }
      test.setSendWorks(false);
      await (flow === 'manual' ? test.controller.send() : test.controller.startAutomatic());
      expect(test.controller.getSnapshot()).toMatchObject({ phase: 'failed', canRetry: true });
      const requestId = test.controller.getSnapshot().batch?.requestId;
      test.setSendWorks(true);
      await test.controller.retry();
      expect(test.controller.getSnapshot().phase).toBe(flow === 'manual' ? 'idle' : 'completed');
      expect(test.controller.getSnapshot().batch?.requestId).toBe(requestId);
      expect(test.commands.filter(command => command.action === 'send')).toHaveLength(2);
      expect(test.applied).toEqual(flow === 'manual' ? [] : ['one']);
    });
  }

  it('resumes answer monitoring after failure without sending the current request twice', async () => {
    const test = scenario(); let failed = false;
    test.onWait(() => {
      if (!failed && test.controller.getSnapshot().phase === 'waiting_answer') { failed = true; test.failInspections(3); }
    });
    await test.controller.startAutomatic();
    expect(test.controller.getSnapshot()).toMatchObject({ phase: 'failed', canRetry: true });
    await test.controller.retry();
    expect(test.controller.getSnapshot().phase).toBe('completed');
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(1);
  });

  it('retries only the unfinished fill and preserves successful progress', async () => {
    const test = scenario([question, { ...question, id: 'two', hash: 'two' }]);
    let writes = 0;
    test.onApply(async () => { if (++writes === 2) throw new Error('write failed'); });
    await test.controller.startAutomatic();
    expect(test.controller.getSnapshot()).toMatchObject({ phase: 'failed', canRetry: true });
    expect(test.applied).toEqual(['one']);
    await test.controller.retry();
    expect(test.controller.getSnapshot().phase).toBe('completed');
    expect(test.applied).toEqual(['one', 'two']);
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(1);
    expect(test.activity.getSnapshot().task?.applied).toEqual(['one', 'two']);
    expect(test.activity.getSnapshot().feedback.map(event => event.kind)).toEqual(['extracted', 'completed']);
  });

  it('preserves already filled questions when retrying a manually approved fill', async () => {
    const test = scenario([question, { ...question, id: 'two', hash: 'two' }]);
    test.controller.edit({ flow: 'manual' }); test.controller.generate();
    await test.controller.openWebsite(); await test.controller.send(); test.controller.importPreview();
    let writes = 0;
    test.onApply(async () => { if (++writes === 2) throw new Error('write failed'); });
    await test.controller.approveFill();
    expect(test.applied).toEqual(['one']);
    await test.controller.retry();
    expect(test.applied).toEqual(['one', 'two']);
    expect(test.activity.getSnapshot().task?.applied).toEqual(['one', 'two']);
  });

  it('invalidates a retry if the provider or workflow is changed', async () => {
    const test = scenario(); test.setComposer(false);
    await test.controller.startAutomatic();
    expect(test.controller.getSnapshot().canRetry).toBe(true);
    test.controller.edit({ flow: 'manual' });
    expect(test.controller.getSnapshot().canRetry).toBe(false);
    await test.controller.retry();
    expect(test.commands.some(command => command.action === 'send')).toBe(false);
  });

  it('retries the current batch while preserving completed earlier batches', async () => {
    const test = scenario([
      { ...question, id: 'large1', hash: 'large1', question: 'x'.repeat(170000) },
      { ...question, id: 'large2', hash: 'large2', question: 'x'.repeat(170000) }
    ]);
    test.onWait(() => { if (test.controller.getSnapshot().position === 2) test.setSendWorks(false); });
    await test.controller.startAutomatic();
    expect(test.applied).toEqual([]);
    expect(test.imported).toEqual(['large1']);
    test.onWait(() => undefined); test.setSendWorks(true);
    await test.controller.retry();
    expect(test.applied).toEqual(['large1', 'large2']);
    expect(test.controller.getSnapshot().phase).toBe('completed');
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(3);
  });

  it('does not send after an already-started extraction returns late', async () => {
    const test = scenario();
    let release!: () => void; let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    test.onExtract(async () => { reached(); await gate; });
    const running = test.controller.startAutomatic();
    await entered; test.controller.stop(); release(); await running;
    expect(test.commands.some(command => command.action === 'send')).toBe(false);
    expect(test.controller.getSnapshot().phase).toBe('stopped');
  });

  it('pauses at the answer boundary and resumes without a second send', async () => {
    const test = scenario(); let paused = false;
    let release!: () => void; let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    test.onWait(async () => {
      if (paused || test.controller.getSnapshot().phase !== 'waiting_answer') return;
      paused = true; test.controller.togglePause(); reached(); await gate;
    });
    const running = test.controller.startAutomatic();
    await entered;
    expect(test.imported).toEqual([]);
    expect(test.controller.getSnapshot().phase).toBe('paused');
    expect(test.controller.getSnapshot().visible).toBe(true);
    test.controller.togglePause(); release(); await running;
    expect(test.applied).toEqual(['one']);
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(1);
  });

  it('still sends once after pausing longer than the initial send window', async () => {
    const test = scenario(); let paused = false;
    test.onWait(() => {
      if (paused || test.controller.getSnapshot().phase !== 'sending') return;
      paused = true; test.controller.togglePause();
      test.advanceTime(20000);
      test.controller.togglePause();
    });
    await test.controller.startAutomatic();
    expect(paused).toBe(true);
    expect(test.controller.getSnapshot().phase).toBe('completed');
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(1);
  });

  it('does not fill the next question or celebrate after an in-flight write is stopped', async () => {
    const test = scenario([question, { ...question, id: 'two', hash: 'two' }]);
    let release!: () => void; let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    test.onApply(async () => { reached(); await gate; });
    const running = test.controller.startAutomatic();
    await entered; test.controller.stop(); release(); await running;
    expect(test.applied).toEqual(['one']);
    expect(test.activity.getSnapshot().task?.applied).toEqual([]);
    expect(test.activity.getSnapshot().feedback.map(event => event.kind)).toEqual(['extracted']);
    expect(test.controller.getSnapshot().phase).toBe('stopped');
  });
});
