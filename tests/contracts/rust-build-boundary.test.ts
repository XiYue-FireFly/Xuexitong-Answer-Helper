import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertRustTransformBoundary, transformRustSource } from '../../build/rust-host-compat-plugin';
import { attachGuestProxy, decodeExecutionResult, type CompatGuestElement } from '../../src/desktop-rust/CompatGuestView';
import { getRustHost, isRustDesktopHost, type GuestHostEvent, type GuestSnapshot, type RustHostTransport } from '../../src/desktop-rust/hostClient';

const original = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Rust build whitelist', () => {
  it('changes only the pinned desktop initializer and JSX tag while retaining business AST', () => {
    for (const file of ['src/store/appStore.ts', 'src/components/BrowserPanel.tsx']) {
      const before = original(file), after = transformRustSource(before, file);
      expect(after).not.toBe(before);
      expect(() => assertRustTransformBoundary(before, after, file)).not.toThrow();
      expect(original(file)).toBe(before);
    }
    expect(transformRustSource(original('src/store/appStore.ts'), 'src/store/appStore.ts')).toContain('isElectron: __studyPilotIsRustHost()');
    expect(transformRustSource(original('src/components/BrowserPanel.tsx'), 'src/components/BrowserPanel.tsx')).toContain('<__StudyPilotRustGuestView');
    expect(transformRustSource('export const safe = true;', 'src/desktop-rust/example.ts')).toBe('export const safe = true;');
  });

  it('fails closed on upstream node drift, extra JSX nodes and non-whitelisted business mutations', () => {
    const store = original('src/store/appStore.ts'), browser = original('src/components/BrowserPanel.tsx');
    expect(() => transformRustSource(store.replace("includes('electron')", "includes('rust')"), 'src/store/appStore.ts')).toThrow(/Frozen Rust transform input changed/);
    expect(() => transformRustSource(browser + '\nconst extra = <webview />;', 'src/components/BrowserPanel.tsx')).toThrow(/Frozen Rust transform input changed/);
    const converted = transformRustSource(store, 'src/store/appStore.ts');
    expect(() => assertRustTransformBoundary(store, converted.replace('MAX', 'MODIFIED_MAX') + '\nconst rewrite = true;', 'src/store/appStore.ts')).toThrow(/Business AST changed outside Rust whitelist/);
    expect(() => assertRustTransformBoundary('const x = 1;', 'const x = 2;', 'src/webAI/anything.ts')).toThrow(/Non-whitelisted Rust transform/);
    expect(() => transformRustSource(original('src/webAI/pageRequests.ts') + '\nconst bypass = true;', 'src/webAI/pageRequests.ts')).toThrow(/Frozen Rust transform input changed/);
    expect(() => transformRustSource("import { ipcRenderer } from 'electron';", 'src/desktop-rust/unsafe.ts')).toThrow(/Unadapted runtime import/);
    expect(() => transformRustSource("const ipc = require('electron');", 'src/desktop-rust/unsafe.ts')).toThrow(/Unadapted runtime import/);
    expect(() => transformRustSource("const ipc = import('electron');", 'src/desktop-rust/unsafe.ts')).toThrow(/Unadapted runtime import/);
  });

  it('uses an explicit native capability without changing the user agent', () => {
    const userAgent = 'Fixture Browser';
    vi.stubGlobal('navigator', { userAgent }); vi.stubGlobal('window', {});
    expect(isRustDesktopHost()).toBe(false);
    vi.stubGlobal('window', { __RUST_HOST__: { identity: 'rust', invoke: vi.fn(), listen: vi.fn() } });
    expect(isRustDesktopHost()).toBe(true);
    expect(navigator.userAgent).toBe(userAgent);
    expect(original('src/desktop-rust/bootstrap.ts').indexOf('await installLegacyApi()')).toBeLessThan(original('src/desktop-rust/bootstrap.ts').indexOf("await import('../main')"));
  });

  it('installs only the local Tauri invoke envelope and unwraps event payloads', async () => {
    let receive: (event: { payload: unknown }) => void = () => {};
    const invoke = vi.fn(async () => 'result'), unsubscribe = vi.fn();
    vi.stubGlobal('window', { __TAURI__: { core: { invoke }, event: { listen: vi.fn(async (_event, callback) => { receive = callback; return unsubscribe; }) } } });
    const host = getRustHost();
    expect(await host.invoke('browser:action', { action: 'reload' })).toBe('result');
    expect(invoke).toHaveBeenCalledWith('desktop_host', { command: 'browser:action', payload: { action: 'reload' } });
    const callback = vi.fn();
    const remove = await host.listen('browser:event', callback);
    receive({ payload: { ready: true } });
    expect(callback).toHaveBeenCalledWith({ ready: true });
    remove(); expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

class GuestElement extends EventTarget {
  dataset = { activeBrowser: 'true' };
  getBoundingClientRect() { return { x: 4, y: 8, width: 800, height: 600 }; }
}

function fixture(options: { delayedCreate?: boolean; delayedListen?: boolean; loading?: boolean } = {}) {
  const node = new GuestElement() as unknown as CompatGuestElement;
  const initial: GuestSnapshot = { guestId: 7, url: 'https://fixture.test/', title: 'Fixture', canGoBack: false, canGoForward: false, loading: options.loading ?? false, documentGeneration: 1 };
  let listener: ((event: GuestHostEvent) => void) | undefined, instanceId = '';
  let completeCreate: (snapshot: GuestSnapshot) => void = () => {}, completeListen: (unsubscribe: () => void) => void = () => {};
  const unsubscribe = vi.fn();
  const host: RustHostTransport = {
    identity: 'rust',
    invoke: vi.fn(async (command, payload: any) => {
      if (command === 'browser:create') {
        instanceId = payload.instanceId;
        return options.delayedCreate ? await new Promise(resolve => { completeCreate = resolve; }) : initial;
      }
      if (command === 'browser:action' && payload.action === 'executeJavaScript') return { protocol: 'studypilot-rust-evaluation-v1', value: { type: 'json', value: { answer: true } } };
      return undefined;
    }) as RustHostTransport['invoke'],
    listen: vi.fn((_event, callback) => {
      listener = callback as (event: GuestHostEvent) => void;
      return options.delayedListen ? new Promise(resolve => { completeListen = resolve; }) : unsubscribe;
    })
  };
  vi.stubGlobal('getComputedStyle', () => ({ display: 'block', visibility: 'visible' }));
  const proxy = attachGuestProxy(node, { url: initial.url, partition: 'persist:studypilot-sites' }, host);
  const emit = (event: string, snapshot = initial, properties: Record<string, unknown> = {}, patch: Partial<GuestHostEvent> = {}) => listener!({ instanceId, guestId: snapshot.guestId, documentGeneration: snapshot.documentGeneration, event, snapshot, properties, ...patch });
  return { node, host, proxy, initial, emit, unsubscribe, completeCreate: () => completeCreate(initial), completeListen: () => completeListen(unsubscribe) };
}

describe('Rust guest DOM proxy', () => {
  it('waits for real document readiness before executing once with the latest native generation', async () => {
    const f = fixture({ loading: true }); await f.proxy.ready;
    const result = f.node.executeJavaScript('Promise.resolve({answer:true})');
    await Promise.resolve(); await Promise.resolve();
    expect(vi.mocked(f.host.invoke).mock.calls.some(([command, payload]: any) => command === 'browser:action' && payload.action === 'executeJavaScript')).toBe(false);
    f.emit('did-start-navigation', { ...f.initial, documentGeneration: 2, loading: true });
    f.emit('dom-ready', { ...f.initial, documentGeneration: 2, loading: false });
    expect(await result).toEqual({ answer: true });
    const actions = vi.mocked(f.host.invoke).mock.calls.filter(([command, payload]: any) => command === 'browser:action' && payload.action === 'executeJavaScript');
    expect(actions).toHaveLength(1); expect(actions[0][1]).toMatchObject({ documentGeneration: 2 });
    f.proxy.dispose();
  });

  it('cancels pending document readiness on disposal and times out without executing any page script', async () => {
    vi.useFakeTimers();
    const f = fixture({ loading: true }); await f.proxy.ready;
    const pending = f.node.executeJavaScript('sideEffect()');
    const disposed = expect(pending).rejects.toThrow('网页已关闭。');
    await Promise.resolve(); await Promise.resolve(); f.proxy.dispose(); await disposed;
    const timeout = fixture({ loading: true }); await timeout.proxy.ready;
    const late = timeout.node.executeJavaScript('sideEffect()');
    const expired = expect(late).rejects.toThrow('网页尚未就绪。');
    await vi.advanceTimersByTimeAsync(15001); await expired;
    expect(vi.mocked(timeout.host.invoke).mock.calls.some(([command, payload]: any) => command === 'browser:action' && payload.action === 'executeJavaScript')).toBe(false);
    timeout.proxy.dispose();
  });

  it('forwards key-up cleanup while a replacement document is still loading', async () => {
    const f = fixture({ loading: true }); await f.proxy.ready;
    await f.node.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    expect(vi.mocked(f.host.invoke).mock.calls).toContainEqual(['browser:action', expect.objectContaining({ action: 'sendInputEvent', args: [{ type: 'keyUp', keyCode: 'Enter' }] })]);
    f.proxy.dispose();
  });
  it('reports an uninitialized native guest as retryable instead of leaking the invalid contents ID zero', async () => {
    const f = fixture({ delayedCreate: true });
    expect(() => f.node.getWebContentsId()).toThrow('网页尚未就绪。');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(() => f.node.getWebContentsId()).toThrow('网页尚未就绪。');
    f.completeCreate(); await f.proxy.ready;
    expect(f.node.getWebContentsId()).toBe(7);
    f.proxy.dispose();
  });
  it('preserves undefined, null, booleans and page objects using an unambiguous transport envelope', () => {
    const wrap = (value: unknown) => ({ protocol: 'studypilot-rust-evaluation-v1', value: { type: 'json', value } });
    expect(decodeExecutionResult({ protocol: 'studypilot-rust-evaluation-v1', value: { type: 'undefined' } })).toBeUndefined();
    for (const value of [null, false, 0, '', [1, 2], { protocol: 'studypilot-rust-evaluation-v1', value: { type: 'undefined' } }]) expect(decodeExecutionResult(wrap(value))).toEqual(value);
    for (const bad of [undefined, null, {}, { protocol: 'wrong', value: { type: 'undefined' } }, { protocol: 'studypilot-rust-evaluation-v1', value: { type: 'json' } }]) expect(() => decodeExecutionResult(bad)).toThrow('无效的脚本结果');
  });
  it('returns synchronous state snapshots and forwards original method arguments and DOM event properties', async () => {
    const f = fixture();
    await f.proxy.ready;
    expect(f.node.getWebContentsId()).toBe(7); expect(f.node.getURL()).toBe(f.initial.url);
    const received: unknown[] = [];
    f.node.addEventListener('ipc-message', (event: any) => received.push({ channel: event.channel, args: event.args }));
    const update = { ...f.initial, title: 'Loaded', canGoBack: true, documentGeneration: 2 };
    f.emit('dom-ready', update);
    f.emit('ipc-message', update, { channel: 'studypilot:question-result', args: [{ success: true }] });
    expect(f.node.getTitle()).toBe('Loaded'); expect(f.node.canGoBack()).toBe(true);
    expect(received).toEqual([{ channel: 'studypilot:question-result', args: [{ success: true }] }]);
    expect(await f.node.executeJavaScript('Promise.resolve({answer:true})', true)).toEqual({ answer: true });
    await f.node.loadURL('https://fixture.test/next'); await f.node.send('studypilot:apply-answer', { answer: 'A' });
    f.node.focus(); await f.node.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); await f.node.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    const actions = vi.mocked(f.host.invoke).mock.calls.filter(([command]) => command === 'browser:action').map(([, payload]) => payload as any);
    expect(actions.map(action => action.action)).toEqual(['executeJavaScript', 'loadURL', 'send', 'focus', 'sendInputEvent', 'sendInputEvent']);
    expect(actions[0]).toMatchObject({ guestId: 7, documentGeneration: 2, args: ['Promise.resolve({answer:true})', true] });
    expect(actions[2].args).toEqual(['studypilot:apply-answer', { answer: 'A' }]);
    f.proxy.dispose(); expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it('drops foreign and stale events, and destroys late-created native guests after disposal', async () => {
    const f = fixture(); await f.proxy.ready;
    f.emit('page-title-updated', { ...f.initial, title: 'New', documentGeneration: 3 });
    f.emit('page-title-updated', { ...f.initial, title: 'Old', documentGeneration: 2 });
    f.emit('page-title-updated', { ...f.initial, title: 'Foreign' }, {}, { instanceId: 'other', documentGeneration: 4 });
    expect(f.node.getTitle()).toBe('New');
    f.proxy.dispose();
    const late = fixture({ delayedCreate: true });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    late.proxy.dispose(); late.completeCreate();
    await expect(late.proxy.ready).rejects.toThrow('网页已关闭');
    expect(vi.mocked(late.host.invoke).mock.calls.filter(([command]) => command === 'browser:destroy')).toHaveLength(1);
    expect(late.unsubscribe).toHaveBeenCalledOnce();
  });

  it('releases subscriptions that resolve after unmount and never creates a guest', async () => {
    const f = fixture({ delayedListen: true });
    await Promise.resolve(); f.proxy.dispose(); f.completeListen();
    await expect(f.proxy.ready).rejects.toThrow('网页已关闭');
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.mocked(f.host.invoke).mock.calls.some(([command]) => command === 'browser:create')).toBe(false);
  });

  it('keeps native command failures observable as legacy Error objects without unhandled promises', async () => {
    const f = fixture(); await f.proxy.ready;
    const failures: unknown[] = [];
    f.node.addEventListener('did-fail-load', (event: any) => failures.push(event.errorDescription));
    vi.mocked(f.host.invoke).mockRejectedValueOnce('native document changed');
    await expect(f.node.executeJavaScript('1')).rejects.toThrow('native document changed');
    expect(failures).toContain('native document changed');
    f.proxy.dispose();
  });

  it('preserves a newer native lifecycle snapshot when create returns a stale snapshot of the same document', async () => {
    const f = fixture({ delayedCreate: true });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const newer = { ...f.initial, url: 'https://fixture.test/redirected', title: 'Latest document', loading: false };
    f.emit('dom-ready', newer);
    f.completeCreate();
    await f.proxy.ready;
    expect(f.node.getURL()).toBe(newer.url); expect(f.node.getTitle()).toBe(newer.title); expect(f.node.isLoading()).toBe(false);
    f.proxy.dispose();
  });

  it('waits for native stop completion before starting the following navigation', async () => {
    const f = fixture(); await f.proxy.ready;
    let releaseStop: () => void = () => {};
    const previous = f.host.invoke;
    const actions: string[] = [];
    f.host.invoke = vi.fn(async (command, payload: any) => {
      if (command === 'browser:action') {
        actions.push(payload.action);
        if (payload.action === 'stop') await new Promise<void>(resolve => { releaseStop = resolve; });
      }
      return previous(command, payload);
    }) as RustHostTransport['invoke'];
    f.node.stop(); const navigation = f.node.loadURL('https://fixture.test/next');
    await vi.waitFor(() => expect(actions).toEqual(['stop']));
    releaseStop(); await navigation;
    expect(actions).toEqual(['stop', 'loadURL']);
    f.proxy.dispose();
  });
});
