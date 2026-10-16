import { afterEach, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { callPageHook } from '../electron/preload-webview/page-bridge';

afterEach(() => vi.unstubAllGlobals());

it('同步已填好的选择答案只通知页面，不再次调用单选或多选切换钩子', async () => {
  const listeners = new Map<string, Function[]>();
  const addChoice = vi.fn(); const addMultipleChoice = vi.fn();
  const answerContentChange = vi.fn(); const loadAnswerSheet = vi.fn();
  const pageWindow = {
    addEventListener: (name: string, listener: Function) => listeners.set(name, [...listeners.get(name) || [], listener]),
    dispatchEvent: (event: { type: string }) => { listeners.get(event.type)?.forEach(listener => listener(event)); },
    setTimeout, clearTimeout, addChoice, addMultipleChoice, answerContentChange, loadAnswerSheet
  };
  class CustomEventFixture { constructor(public type: string, public options: { detail: unknown }) {} get detail() { return this.options.detail; } }
  vi.stubGlobal('CustomEvent', CustomEventFixture); vi.stubGlobal('window', pageWindow);
  vi.stubGlobal('document', {
    documentElement: { appendChild: (script: { textContent: string }) => runInNewContext(script.textContent, { window: pageWindow, CustomEvent: CustomEventFixture }) },
    createElement: () => ({ textContent: '', remove() {} })
  });
  const result = await callPageHook({ kind: 'syncChoice', qid: '1234', values: ['A'] });
  expect(result?.ok).toBe(true);
  expect(addMultipleChoice).not.toHaveBeenCalled();
  expect(addChoice).not.toHaveBeenCalled();
  expect(loadAnswerSheet).toHaveBeenCalledWith('1234');
  expect(answerContentChange).toHaveBeenCalledTimes(1);
});
