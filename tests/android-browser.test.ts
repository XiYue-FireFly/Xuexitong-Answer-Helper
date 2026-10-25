import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appStore } from '../src/store/appStore';

const native = vi.hoisted(() => ({
  getState: vi.fn(), injectBridge: vi.fn(), dispatchBridgeEvent: vi.fn(),
  createTab: vi.fn(), focusTab: vi.fn(), executeScript: vi.fn(), sendEnter: vi.fn(), leaseWebAITask: vi.fn(),
}));
vi.mock('../src/platform/nativeWebViewPlugin', () => ({ NativeWebView: native }));

let dispose: () => void;
let start: typeof import('../src/platform/androidBrowser').startAndroidBrowser;
const question = { hash: 'q1', question: '1 + 1 = ?', type: 'single', options: ['A. 2', 'B. 3'], selector: '#q1' };
const state = { tabId: 'study', activeTabId: 'study', url: 'https://school.test/work', title: '练习', loading: false, canGoBack: false, canGoForward: false };

function request(channel: string, detail: Record<string, unknown> = {}) {
  return new Promise<any>(resolve => window.dispatchEvent(new CustomEvent(channel, { detail: { ...detail, onComplete: resolve } })));
}

beforeEach(async () => {
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('CustomEvent', class extends Event { detail: any; constructor(type: string, options: any) { super(type); this.detail = options.detail; } });
  vi.clearAllMocks();
  native.getState.mockResolvedValue(state);
  native.injectBridge.mockResolvedValue(undefined);
  native.dispatchBridgeEvent.mockResolvedValue({ success: true, questions: [question] });
  native.executeScript.mockResolvedValue({ result: JSON.stringify({ ready: true, text: 'answer' }) });
  ({ startAndroidBrowser: start } = await import('../src/platform/androidBrowser'));
  dispose = start();
});
afterEach(() => { dispose?.(); vi.unstubAllGlobals(); });

describe('Android browser integration', () => {
  it('answers source commands with the real native tab', async () => {
    expect(await request('studypilot:web-ai-browser', { action: 'source' })).toMatchObject({ tabId: 'study', url: state.url });
  });
  it('binds image reads to the selected question tab instead of the startup tab', async () => {
    native.getState.mockResolvedValue({ ...state, tabId: 'tab-work' });
    await request('studypilot:web-ai-browser', { action: 'source', tabId: 'tab-work', sessionId: 'task-one', resourceSource: { tabId: 'tab-work', url: state.url } });
    expect(native.leaseWebAITask).toHaveBeenCalledWith({ sessionId: 'task-one', sourceTabId: 'tab-work', sourceUrl: state.url });
  });
  it('does not bind an AI tab inspection as the question image source', async () => {
    native.getState.mockResolvedValue({ ...state, tabId: 'ai-one', url: 'https://chat.deepseek.com/' });
    await request('studypilot:web-ai-browser', { action: 'source', tabId: 'ai-one', sessionId: 'task-one' });
    expect(native.leaseWebAITask).not.toHaveBeenCalled();
  });
  it('reports a loading AI view as mount-pending so the controller can wait', async () => {
    native.getState.mockResolvedValue({ ...state, tabId: 'ai-one', loading: true, url: 'https://chat.deepseek.com/' });
    expect(await request('studypilot:web-ai-browser', { action: 'source', provider: 'deepseek', tabId: 'ai-one' }))
      .toMatchObject({ error: expect.stringContaining('网页尚未就绪') });
  });
  it('stores extracted questions with their native page source', async () => {
    expect(await request('studypilot:extract-question-request')).toMatchObject({ success: true });
    expect(appStore.getState().questions[0]).toMatchObject({ hash: 'q1', pageUrl: state.url, source: 'webview' });
    expect(appStore.getState().status).toBe('done');
  });
  it('refuses to extract from a navigated source', async () => {
    expect(await request('studypilot:extract-question-request', { targetTabId: 'study', expectedUrl: 'https://school.test/old' })).toMatchObject({ success: false });
    expect(native.dispatchBridgeEvent).not.toHaveBeenCalled();
  });
  it('converts answer items into the content bridge payload', async () => {
    native.dispatchBridgeEvent.mockResolvedValue({ success: true });
    await request('studypilot:apply-answers', { items: [{ question, answer: { answer: '2', choiceLabels: ['A'], matchedOptions: ['A. 2'] } }] });
    expect(native.dispatchBridgeEvent).toHaveBeenCalledWith(expect.objectContaining({
      detail: { payload: { questionHash: 'q1', question, answer: '2', choiceLabels: ['A'], matchedOptions: ['A. 2'] } },
    }));
  });
  it('shows the validated source tab before applying answers from an AI tab', async () => {
    native.getState.mockResolvedValue({ ...state, activeTabId: 'ai-1' });
    native.dispatchBridgeEvent.mockResolvedValue({ success: true });
    const result = await request('studypilot:apply-answers', { targetTabId: 'study', expectedUrl: state.url,
      items: [{ question, answer: { answer: '2' } }] });
    expect(result.success).toBe(true);
    expect(native.focusTab).toHaveBeenCalledWith('study');
    expect(native.focusTab.mock.invocationCallOrder[0]).toBeLessThan(native.dispatchBridgeEvent.mock.invocationCallOrder[0]);
  });
  it('sends a real Enter to the bound AI tab for icon-only composers', async () => {
    native.executeScript.mockResolvedValue({ result: { ready: true, needsEnter: true, attempted: false } });
    native.sendEnter.mockResolvedValue(undefined);
    expect(await request('studypilot:web-ai-browser', { action: 'send', tabId: 'study', provider: 'deepseek', prompt: 'prompt' }))
      .toMatchObject({ attempted: true, needsEnter: false });
    expect(native.sendEnter).toHaveBeenCalledWith('study');
  });
  it('receives sequential exam navigation results', async () => {
    native.dispatchBridgeEvent.mockResolvedValue({ success: true, changed: true });
    expect(await request('studypilot:exam-next-question')).toMatchObject({ success: true, changed: true });
  });
  it('opens an independent AI tab while retaining the source', async () => {
    native.createTab.mockResolvedValue({ ...state, tabId: 'ai-1' });
    expect(await request('studypilot:web-ai-browser', { action: 'open', provider: 'deepseek' })).toMatchObject({ tabId: 'ai-1' });
    expect(native.createTab).toHaveBeenCalledWith('https://chat.deepseek.com/');
  });
  it('does not perform operations after cancellation', async () => {
    expect(await request('studypilot:apply-answers', { items: [{ question, answer: { answer: '2' } }], isCancelled: () => true })).toMatchObject({ success: false });
    expect(native.dispatchBridgeEvent).not.toHaveBeenCalled();
  });
});
