import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyWebAnswers, WebPageRequestRegistry } from '../src/webAI/pageRequests';
const page = vi.hoisted(() => ({ handlers: new Map<string, Function>(), reply: vi.fn(), apply: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: { on: (channel: string, action: Function) => page.handlers.set(channel, action), sendToHost: (...args: unknown[]) => page.reply(...args) }, webFrame: {} }));
vi.mock('../electron/preload-webview/bridge', () => ({ installBridgeErrorHandlers: () => undefined }));
vi.mock('../electron/preload-webview/navigation', () => ({ installBrowserNavigationPatch: () => undefined }));
vi.mock('../electron/preload-webview/font-decode', () => ({ loadFontMap: async () => undefined }));
vi.mock('../electron/preload-webview/answer-applier', () => ({ applyAnswerV2: (payload: unknown) => page.apply(payload) }));
afterEach(() => vi.useRealTimers());

describe('Web page operation isolation', () => {
  it('keeps the page write barrier after host cancellation and renews SPA document identity', async () => {
    await import('../electron/preload-webview');
    page.handlers.get('studypilot:web-document-request')!({});
    const documentId = page.reply.mock.calls.at(-1)![1];
    const first = { operationId: 'first', sessionId: 'one', targetTabId: 'tab', documentId, expiresAt: Date.now() + 10000 };
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    page.apply.mockImplementationOnce(async () => { await gate; return { success: true }; }).mockResolvedValue({ success: true });
    page.handlers.get('studypilot:apply-answer')!({}, first);
    await Promise.resolve(); await Promise.resolve();
    expect(page.apply).toHaveBeenCalledTimes(1);
    page.handlers.get('studypilot:web-cancel-operation')!({}, 'first');
    page.handlers.get('studypilot:apply-answer')!({}, { ...first, operationId: 'second', sessionId: 'two' });
    await Promise.resolve(); await Promise.resolve(); expect(page.apply).toHaveBeenCalledTimes(1);
    finish(); for (let step = 0; step < 10; step++) await Promise.resolve();
    expect(page.apply).toHaveBeenCalledTimes(2);
    page.handlers.get('studypilot:web-document-request')!({}, true);
    const renewed = page.reply.mock.calls.at(-1)![1]; expect(renewed).not.toBe(documentId);
    page.handlers.get('studypilot:apply-answer')!({}, { ...first, operationId: 'stale' });
    for (let step = 0; step < 10; step++) await Promise.resolve();
    expect(page.apply).toHaveBeenCalledTimes(2); expect(page.reply.mock.calls.at(-1)![1].success).toBe(false);
  });
  it('waits once, skips a persistently failing completion, and still applies the following answer', async () => {
    const sent: string[] = []; const delays: number[] = []; const skipped: string[] = [];
    const result = await applyWebAnswers(['first', 'second'], async id => { sent.push(id); return id === 'first' ? { success: false, error: '填空答案写入后校验失败' } : { success: true }; },
      () => false, async ms => { delays.push(ms); }, id => skipped.push(id));
    expect(result).toEqual({ success: true, partial: true, skipped: 1 });
    expect(sent).toEqual(['first', 'first', 'second']); expect(delays).toEqual([420]); expect(skipped).toEqual(['first']);
  });
  it('routes reversed replies and ignores other tabs, documents and duplicate replies', async () => {
    const registry = new WebPageRequestRegistry(); const sent: any[] = [];
    registry.setDocument('a', 'doc-a'); registry.setDocument('b', 'doc-b');
    const first = registry.request('a', 'task-a', 'result', {}, value => sent.push(value));
    const second = registry.request('b', 'task-b', 'result', {}, value => sent.push(value));
    expect(registry.resolve('a', 'result', { ...sent[1], success: true })).toBe(false);
    expect(registry.resolve('a', 'result', { ...sent[0], documentId: 'old' })).toBe(false);
    expect(registry.resolve('a', 'result', { ...sent[0], targetTabId: 'b' })).toBe(false);
    expect(registry.resolve('b', 'result', { ...sent[1], answer: 'B' })).toBe(true);
    expect(registry.resolve('a', 'result', { ...sent[0], answer: 'A' })).toBe(true);
    expect((await first).answer).toBe('A'); expect((await second).answer).toBe('B');
    expect(registry.resolve('a', 'result', sent[0])).toBe(false);
  });
  it('invalidates inflight operations on navigation without cancelling another session', async () => {
    const registry = new WebPageRequestRegistry(); const sent: any[] = [];
    registry.setDocument('a', 'old'); registry.setDocument('b', 'other');
    const old = registry.request('a', 'one', 'result', {}, value => sent.push(value));
    const other = registry.request('b', 'two', 'result', {}, value => sent.push(value));
    registry.setDocument('a', 'new');
    expect((await old).success).toBe(false);
    expect(registry.resolve('a', 'result', sent[0])).toBe(false);
    registry.resolve('b', 'result', { ...sent[1], success: true }); expect((await other).success).toBe(true);
  });
  it('times out and cancels without leaving pending work', async () => {
    vi.useFakeTimers(); const registry = new WebPageRequestRegistry(); registry.setDocument('a', 'doc');
    const sent: any[] = [];
    const timed = registry.request('a', 'one', 'r', {}, value => sent.push(value), undefined, 200);
    await vi.advanceTimersByTimeAsync(200); expect((await timed).error).toContain('超时');
    const stopped = registry.request('a', 'one', 'r', {}, value => sent.push(value));
    registry.cancelSession('one'); expect((await stopped).error).toContain('停止');
    expect(registry.resolve('a', 'r', sent[1])).toBe(false);
  });
  it('serializes only within the same target view', async () => {
    const registry = new WebPageRequestRegistry(); const calls: string[] = [];
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const a = registry.enqueue('a', async () => { calls.push('a1'); await gate; });
    const a2 = registry.enqueue('a', async () => { calls.push('a2'); });
    const b = registry.enqueue('b', async () => { calls.push('b'); });
    await b; expect(calls).toEqual(['a1', 'b']); release(); await Promise.all([a, a2]);
    expect(calls).toEqual(['a1', 'b', 'a2']);
  });
});
