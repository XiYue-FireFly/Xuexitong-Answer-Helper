import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGuestTransport, createWebView2GuestTransport, GUEST_REQUEST_CHANNELS, type GuestEnvelope } from '../../src/desktop-rust/guestTransport';

const configuration = { protocolVersion: 1 as const, documentGeneration: 7, documentToken: 'native-document-token-test', dispatchHook: '__studypilot_test_document_123456' };

function harness(evaluate: (script: string) => unknown = script => (0, eval)(script)) {
  const sent: GuestEnvelope[] = [];
  const transport = createGuestTransport(configuration, { postMessage: message => sent.push(message), evaluate });
  return { sent, transport, dispatch: (message: Record<string, unknown>) => transport.dispatch({ documentGeneration: 7, ...message }) };
}

afterEach(() => { vi.useRealTimers(); });

describe('Rust guest transport', () => {
  it('posts one JSON string to WebView2 so wry can process it before native frame handlers', () => {
    const postMessage = vi.fn();
    const scope = { chrome: { webview: { postMessage } }, addEventListener: vi.fn() };
    const transport = createWebView2GuestTransport(configuration, scope as unknown as Window);
    transport.ipcRenderer.sendToHost('studypilot:web-document', 'legacy-document');
    expect(postMessage).toHaveBeenCalledOnce();
    const wire = postMessage.mock.calls[0][0];
    expect(typeof wire).toBe('string');
    expect(JSON.parse(wire)).toMatchObject({ protocol: 'studypilot-rust-page-v1', kind: 'event',
      documentGeneration: 7, documentToken: configuration.documentToken, payload: ['legacy-document'] });
  });
  it('keeps all seven legacy channels and sendToHost argument order without trusting payload identity', () => {
    const { sent, transport, dispatch } = harness();
    const received: unknown[][] = [];
    for (const channel of GUEST_REQUEST_CHANNELS) {
      transport.ipcRenderer.on(channel, (_event, ...args) => { received.push([channel, ...args]); });
      expect(dispatch({ kind: 'ipc', channel, args: [{ frameId: 'forged', documentGeneration: 999 }, false, null] })).toBe(true);
    }
    expect(received).toHaveLength(7);
    transport.ipcRenderer.sendToHost('studypilot:web-document', 'legacy-document', undefined);
    expect(sent[0]).toMatchObject({ kind: 'event', documentGeneration: 7, documentToken: configuration.documentToken, channel: 'studypilot:web-document', payload: ['legacy-document', null] });
    expect(sent[0]).not.toHaveProperty('frameId');
    expect(sent[0]).not.toHaveProperty('guestId');
    expect(Object.keys(transport.ipcRenderer).sort()).toEqual(['on', 'sendToHost']);
    expect(transport.webFrame).toEqual({});
  });

  it('validates the native document token and captures it independently of configuration mutation', async () => {
    for (const documentToken of ['', 'short', 'x'.repeat(129), 'contains whitespace and spaces']) {
      expect(() => createGuestTransport({ ...configuration, documentToken }, { postMessage() {}, evaluate() {} })).toThrow(/configuration/);
    }
    const mutable = { ...configuration };
    const sent: GuestEnvelope[] = [];
    const transport = createGuestTransport(mutable, { postMessage: message => sent.push(message), evaluate: () => null });
    mutable.documentToken = 'changed-native-token';
    transport.ipcRenderer.sendToHost('studypilot:web-document', 'legacy');
    transport.dispatch({ kind: 'evaluate', requestToken: 'token-test', documentGeneration: 7, script: 'null', deadline: Date.now() + 1000 });
    for (const channel of GUEST_REQUEST_CHANNELS) transport.ipcRenderer.on(channel, () => {});
    transport.markReady();
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent.every(message => message.documentToken === configuration.documentToken)).toBe(true);
  });

  it('rejects stale documents and unsupported commands before invoking page handlers', () => {
    const { transport, dispatch } = harness();
    const handler = vi.fn();
    transport.ipcRenderer.on('studypilot:snapshot', handler);
    expect(dispatch({ kind: 'ipc', channel: 'studypilot:snapshot', args: [], documentGeneration: 6 })).toBe(false);
    expect(dispatch({ kind: 'ipc', channel: 'shell:execute', args: [] })).toBe(false);
    expect(dispatch({ kind: 'ipc', channel: 'studypilot:snapshot', args: 'malformed' })).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('uses a native callable under strict CSP without evaluating the script string', async () => {
    const blockedEval = vi.fn(() => { throw new EvalError('unsafe-eval is blocked by CSP'); });
    const { sent, transport } = harness(blockedEval);
    expect(transport.dispatch({
      kind: 'evaluate', requestToken: 'native-callable', documentGeneration: 7,
      script: 'Promise.resolve({ answer: "B" })', deadline: Date.now() + 1000,
    }, () => Promise.resolve({ answer: 'B' }))).toBe(true);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(blockedEval).not.toHaveBeenCalled();
    expect(sent[0].payload).toEqual({ status: 'fulfilled', value: { type: 'json', value: { answer: 'B' } } });
  });

  it('awaits Promise values and distinguishes undefined, null, booleans, arrays and exceptions', async () => {
    const { sent, dispatch } = harness();
    for (const [requestToken, script] of [
      ['undefined', 'Promise.resolve(undefined)'], ['null', 'Promise.resolve(null)'],
      ['false', 'Promise.resolve(false)'], ['array', 'Promise.resolve([1, { answer: "A" }])'],
      ['error', 'Promise.reject(new TypeError("fixture failed"))'],
    ]) expect(dispatch({ kind: 'evaluate', requestToken, script, deadline: Date.now() + 1000 })).toBe(true);
    await vi.waitFor(() => expect(sent).toHaveLength(5));
    const payload = (token: string) => sent.find(message => message.requestToken === token)?.payload;
    expect(payload('undefined')).toEqual({ status: 'fulfilled', value: { type: 'undefined' } });
    expect(payload('null')).toEqual({ status: 'fulfilled', value: { type: 'json', value: null } });
    expect(payload('false')).toEqual({ status: 'fulfilled', value: { type: 'json', value: false } });
    expect(payload('array')).toEqual({ status: 'fulfilled', value: { type: 'json', value: [1, { answer: 'A' }] } });
    expect(payload('error')).toEqual({ status: 'rejected', error: { name: 'TypeError', message: 'fixture failed' } });
  });

  it('cancels and expires evaluations exactly once, ignores late completions and denies expired execution', async () => {
    vi.useFakeTimers();
    let resolveLate: (value: string) => void = () => {};
    const evaluate = vi.fn(() => new Promise<string>(resolve => { resolveLate = resolve; }));
    const { sent, dispatch } = harness(evaluate);
    expect(dispatch({ kind: 'evaluate', requestToken: 'late', script: 'late()', deadline: Date.now() + 50 })).toBe(true);
    expect(dispatch({ kind: 'evaluate', requestToken: 'late', script: 'duplicate()', deadline: Date.now() + 50 })).toBe(false);
    expect(dispatch({ kind: 'cancel', requestToken: 'late' })).toBe(true);
    resolveLate('must be ignored');
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual({ status: 'cancelled' });
    expect(dispatch({ kind: 'evaluate', requestToken: 'late', script: 'replay()', deadline: Date.now() + 50 })).toBe(false);
    expect(dispatch({ kind: 'evaluate', requestToken: 'expired', script: 'sideEffect()', deadline: Date.now() - 1 })).toBe(true);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(sent[1].payload).toEqual({ status: 'timeout' });
    dispatch({ kind: 'evaluate', requestToken: 'pending', script: 'pending()', deadline: Date.now() + 30 });
    await vi.advanceTimersByTimeAsync(31);
    expect(sent[2].payload).toEqual({ status: 'timeout' });
  });

  it('blocks non-JSON evaluation results and stops pending work on document disposal', async () => {
    const { sent, transport, dispatch } = harness();
    dispatch({ kind: 'evaluate', requestToken: 'bigint', script: 'Promise.resolve(1n)', deadline: Date.now() + 1000 });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].payload).toMatchObject({ status: 'rejected', error: { name: 'SerializationError' } });
    dispatch({ kind: 'evaluate', requestToken: 'pending', script: 'new Promise(() => {})', deadline: Date.now() + 1000 });
    transport.dispose();
    expect(sent[1].payload).toEqual({ status: 'cancelled' });
    expect(dispatch({ kind: 'evaluate', requestToken: 'after', script: '1', deadline: Date.now() + 1000 })).toBe(false);
  }, 60_000);

  it('rejects a changed matcher in a temporary source copy before producing a bridge artifact', async () => {
    const { buildRustPageBridge } = await import('../../scripts/build-rust-page-bridge.mjs');
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'studypilot-rust-bridge-negative-'));
    try {
      const documentDirectory = 'docs/migrations/rust-host';
      const manifest = JSON.parse(await readFile(`${documentDirectory}/core-manifest.json`, 'utf8'));
      const files = [...manifest.files.map((entry: { path: string }) => entry.path),
        ...['baseline', 'core-manifest', 'symbol-boundary', 'api-contract'].map(name => `${documentDirectory}/${name}.json`)];
      for (const relative of files) {
        const target = path.join(sourceRoot, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.resolve(relative), target);
      }
      const matcher = path.join(sourceRoot, 'electron/preload-webview/answer-matcher.ts');
      const before = await readFile(matcher, 'utf8');
      const changed = before.replace('===', '!==');
      expect(changed).not.toBe(before);
      await writeFile(matcher, changed, 'utf8');
      await expect(buildRustPageBridge({ sourceRoot })).rejects.toThrow(/Frozen source changed: electron\/preload-webview\/answer-matcher.ts/);
      await expect(readFile(path.join(sourceRoot, 'dist-rust-bridge/page-bridge.js'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile('electron/preload-webview/answer-matcher.ts', 'utf8')).toBe(before);
    } finally { await rm(sourceRoot, { recursive: true, force: true }); }
  }, 60_000);
});

describe('frozen page bridge build', () => {
  it('bundles the original entry unchanged and preserves its document renewal and result channels', async () => {
    const script = path.resolve('scripts/build-rust-page-bridge.mjs');
    const { buildRustPageBridge } = await import(script);
    const built = await buildRustPageBridge({ write: false });
    const entry = await readFile('electron/preload-webview.ts');
    const source = built.manifest.inputs.find((input: { path: string }) => input.path === 'electron/preload-webview.ts');
    expect(source.sha256).toBe(createHash('sha256').update(entry).digest('hex'));
    expect(built.manifest.requestChannels).toEqual(GUEST_REQUEST_CHANNELS);
    expect(built.factorySource).not.toMatch(/require\(["']electron["']\)/);
    const messages: GuestEnvelope[] = [];
    const listeners = new Map<string, Function[]>();
    const window: any = {
      location: { href: 'http://127.0.0.1/fixture', hostname: '127.0.0.1', pathname: '/fixture' },
      addEventListener: (name: string, listener: Function) => listeners.set(name, [...(listeners.get(name) || []), listener]),
      removeEventListener: vi.fn(), chrome: { webview: { postMessage: (message: string) => messages.push(JSON.parse(message)) } },
      open: vi.fn(), setTimeout: () => 1, clearTimeout() {},
      dispatchEvent: () => true,
    };
    window.top = window;
    window.parent = window;
    const document: any = {
      title: 'Local fixture', readyState: 'loading', addEventListener: vi.fn(), querySelectorAll: () => [], querySelector: () => null,
      documentElement: { appendChild: () => {} }, createElement: () => ({ remove() {} }),
    };
    const context = createContext({ window, document, console: { log() {}, warn() {}, error() {} }, URL,
      setTimeout: () => 1, clearTimeout() {}, Promise, Date, Math, WeakSet, Set, Map,
      Element: class Element {}, HTMLAnchorElement: class HTMLAnchorElement {},
      CustomEvent: class CustomEvent { constructor(public type: string, public options: unknown) {} },
    });
    runInContext(`(${built.factorySource})(${JSON.stringify(configuration)})`, context);
    const hook = window[configuration.dispatchHook];
    expect(typeof hook).toBe('function');
    expect(Object.keys(window)).not.toContain(configuration.dispatchHook);
    expect(messages.find(message => message.kind === 'ready')?.payload).toMatchObject({ requestChannels: GUEST_REQUEST_CHANNELS });
    hook({ kind: 'ipc', documentGeneration: 7, channel: 'studypilot:web-document-request', args: [] });
    const firstId = messages.at(-1)?.payload[0];
    hook({ kind: 'ipc', documentGeneration: 7, channel: 'studypilot:web-document-request', args: [false] });
    expect(messages.at(-1)?.payload[0]).toBe(firstId);
    hook({ kind: 'ipc', documentGeneration: 7, channel: 'studypilot:web-document-request', args: [true] });
    expect(messages.at(-1)?.payload[0]).not.toBe(firstId);
    hook({ kind: 'ipc', documentGeneration: 7, channel: 'studypilot:extract-question', args: [{ operationId: 'op', documentId: 'stale', sessionId: 'session', targetTabId: 'tab' }] });
    expect(messages.at(-1)).toMatchObject({ channel: 'studypilot:question-result', payload: [{ success: false, operationId: 'op', sessionId: 'session', targetTabId: 'tab' }] });
  }, 60_000);
});
