import { describe, expect, it } from 'vitest';
import { appStore, type QuestionItem } from '../src/store/appStore';
import { WebAISessionManager } from '../src/webAI/WebAISessionManager';
import type { WebCommand } from '../src/webAI/browserBridge';

function scenario() {
  let global = { ...appStore.getState(), settings: { ...appStore.getState().settings, allowRealPageAutomation: true }, batchRunning: false, liveRunning: false, status: 'idle' as ReturnType<typeof appStore.getState>['status'] };
  const question = (tab: string): QuestionItem => ({ id: tab, hash: `${tab}-hash`, question: '实验结论', options: [], type: 'essay', source: 'webview', pageUrl: `https://school.test/${tab}`, capturedAt: 0 });
  const prepared = new Map<string, any>(); const sent = new Set<string>(); const release = new Set<string>();
  const commands: WebCommand[] = []; const applied: string[] = []; const imported: string[] = []; const notifications: string[] = [];
  let time = 0; let onWait: () => void = () => undefined; let wrongSource = false; let applyPaused = false;
  const store = { ...appStore,
    getState: () => global,
    setAutomationRunning: (patch: any) => { global = { ...global, ...patch }; },
    addLog: () => undefined,
    upsertQuestionBank: (q: QuestionItem) => { imported.push(q.hash); }
  } as typeof appStore;
  const manager = new WebAISessionManager(store, {
    now: () => time,
    wait: async ms => { time += ms; onWait(); await new Promise(resolve => setTimeout(resolve, 0)); if (time > 900000) throw new Error('test exceeded time'); },
    notify: (_title, body) => { notifications.push(body); },
    browser: async command => {
      commands.push(command); const session = command.sessionId!;
      if (command.action === 'source') return { tabId: command.tabId!, url: `https://school.test/${command.tabId}` };
      if (command.action === 'open') return { tabId: `ai-${session}`, url: 'https://chat.deepseek.com/' };
      if (command.action === 'prepare') { prepared.set(session, JSON.parse(command.prompt!.slice(command.prompt!.lastIndexOf('\n\n{') + 2))); sent.delete(session); }
      if (command.action === 'send') sent.add(session);
      const done = sent.has(session) && release.has(session);
      return { ready: true, inputEnabled: true, busy: sent.has(session) && !done, generationState: done ? 'finished' : 'unknown', messageKey: prepared.get(session)?.requestId,
        inputText: sent.has(session) ? '' : command.prompt || '', attempted: command.action === 'send',
        text: done ? JSON.stringify({ requestId: prepared.get(session).requestId, answers: prepared.get(session).questions.map((q: any) => ({ id: q.id, answer: `结论-${session}`, choiceLabels: [], matchedOptions: [], confidence: 1, analysis: '', warnings: [] })) }) : '' };
    },
    page: async (channel, detail) => {
      if (channel === 'studypilot:extract-question-request') return { success: true, questions: [wrongSource ? { ...question(detail.targetTabId as string), hash: 'wrong' } : question(detail.targetTabId as string)] };
      if (applyPaused) throw new Error('原题目页面正在重新加载。');
      applied.push(detail.targetTabId as string); return { success: true };
    }
  });
  const a = manager.getOrCreateForSource({ tabId: 'a', url: 'https://school.test/a' }, '报告 A');
  const b = manager.getOrCreateForSource({ tabId: 'b', url: 'https://school.test/b' }, '报告 B');
  return { manager, a, b, commands, applied, imported, notifications, global: () => global,
    release: (id: string) => release.add(id), onWait: (fn: () => void) => { onWait = fn; },
    wrong: (value: boolean) => { wrongSource = value; }, pauseApply: (value: boolean) => { applyPaused = value; },
    setAPI: () => { global = { ...global, batchRunning: true, status: 'calling_ai' }; } };
}

describe('Independent Web page sessions', () => {
  it('runs different-provider tasks concurrently; completing B does not unlock or overwrite A', async () => {
    const test = scenario(); test.a.controller.edit({ provider: 'deepseek' }); test.b.controller.edit({ provider: 'qwen' });
    const first = test.a.controller.startAutomatic(); const second = test.b.controller.startAutomatic();
    let observed = false;
    test.onWait(() => {
      if (test.a.controller.getSnapshot().phase === 'waiting_answer' && test.b.controller.getSnapshot().phase === 'waiting_answer') {
        observed = true; test.release(test.b.id);
      }
      if (test.b.controller.getSnapshot().phase === 'completed') { expect(test.global().batchRunning).toBe(true); test.release(test.a.id); }
    });
    await Promise.all([first, second]);
    expect(observed).toBe(true); expect(test.applied).toEqual(['b', 'a']); expect(test.global().batchRunning).toBe(false);
    expect(test.a.questions.map(q => q.hash)).toEqual(['a-hash']); expect(test.b.questions.map(q => q.hash)).toEqual(['b-hash']);
    expect(test.global().questions).not.toEqual(test.a.questions);
    expect(test.commands.filter(command => command.action === 'open')).toHaveLength(2);
    expect(test.commands.some(command => command.action === 'focus')).toBe(false);
    expect(test.a.activity.getSnapshot().task?.outcome).toBe('completed'); expect(test.b.activity.getSnapshot().task?.outcome).toBe('completed');
    expect(new Set(test.manager.getSnapshot().feedback.map(event => event.id)).size).toBe(4);
  });
  it('queues the same-provider send/read sections while retaining independent live tasks', async () => {
    const test = scenario(); const first = test.a.controller.startAutomatic(); const second = test.b.controller.startAutomatic();
    let queued = false;
    test.onWait(() => {
      if (test.a.controller.getSnapshot().phase === 'waiting_answer') {
        expect(test.b.controller.getSnapshot().busy).toBe(true);
        expect(test.commands.some(command => command.action === 'send' && command.sessionId === test.b.id)).toBe(false);
        queued = true; test.release(test.a.id);
      }
      if (test.b.controller.getSnapshot().phase === 'waiting_answer') test.release(test.b.id);
    });
    await Promise.all([first, second]); expect(queued).toBe(true); expect(test.applied).toEqual(['a', 'b']);
    expect(test.manager.getSnapshot().sessions).toHaveLength(2);
  });
  it('stops only the selected task and keeps the other running', async () => {
    const test = scenario();
    const first = test.a.controller.startAutomatic(); const second = test.b.controller.startAutomatic();
    test.onWait(() => {
      if (test.a.controller.getSnapshot().phase === 'waiting_answer' && test.b.controller.getSnapshot().busy) {
        test.a.controller.stop(); expect(test.global().batchRunning).toBe(true); test.release(test.b.id);
      }
    });
    await Promise.all([first, second]);
    expect(test.a.controller.getSnapshot().phase).toBe('stopped'); expect(test.b.controller.getSnapshot().phase).toBe('completed'); expect(test.applied).toEqual(['b']);
  });
  it('keeps answers while waiting for original page identity and resumes without resending', async () => {
    const test = scenario(); test.release(test.a.id);
    let once = false;
    test.onWait(() => {
      if (!once && test.a.controller.getSnapshot().phase === 'waiting_answer') { test.wrong(true); once = true; }
      if (test.a.controller.getSnapshot().phase === 'waiting_source') test.wrong(false);
    });
    await test.a.controller.startAutomatic();
    expect(once).toBe(true); expect(test.applied).toEqual(['a']);
    expect(test.commands.filter(command => command.action === 'send')).toHaveLength(1);
    expect(test.a.controller.getSnapshot().phase).toBe('completed');
  });
  it('restores the source owner on AI tab selection and protects retryable identity', async () => {
    const test = scenario(); test.release(test.a.id); await test.a.controller.startAutomatic();
    const ai = test.a.controller.getSnapshot().aiTab!;
    test.manager.selectForTab({ tabId: ai.id, url: 'https://chat.deepseek.com/' }); expect(test.manager.getSnapshot().selectedId).toBe(test.a.id);
    const next = test.manager.getOrCreateForSource({ tabId: 'a', url: 'https://school.test/other' }, '新报告');
    expect(next).not.toBe(test.a); expect(next.source.url).toBe('https://school.test/other'); expect(next.title).toBe('新报告');
    test.manager.select(test.b.id); expect(test.manager.getSnapshot().controller).toBe(test.b.controller);
    test.manager.selectDefault(); expect(test.manager.getSnapshot().selectedId).toBe('');
  });
  it('retains the API/Web exclusion', async () => {
    const test = scenario(); test.setAPI(); await test.a.controller.startAutomatic();
    expect(test.commands).toEqual([]); expect(test.a.controller.getSnapshot().busy).toBe(false);
    expect(test.a.controller.getSnapshot().message).toContain('等待当前任务');
  });
});
