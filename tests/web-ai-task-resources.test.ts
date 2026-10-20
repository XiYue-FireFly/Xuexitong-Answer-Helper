import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { net } from 'electron';
import { createWebAITaskResourceManager } from '../electron/web-ai-task-resources';
import { AnswerElement } from './helpers/answer-dom';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, webContents: { fromId: vi.fn() }, net: { request: vi.fn() } }));
afterEach(() => vi.useRealTimers());

class Contents extends EventEmitter {
  destroyed = false;
  throttled = true;
  url = 'https://source.test/questions';
  hostWebContents: Contents | undefined;
  history: boolean[] = [];
  inspection: any = { sourceUrl: 'https://source.test/q.png' };
  documentImage: any = { mime: 'image/png', bytes: [7, 8, 9] };
  navGet = true;
  send = vi.fn();
  capturePage = vi.fn(async (_rect: any) => ({ toPNG: () => Buffer.from([5, 6, 7]) }));
  session = { fetch: vi.fn(async (_url: string, _options: any) => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'Content-Type': 'image/png' } })) };
  executeJavaScript = vi.fn(async (script: string) => {
    if (script.startsWith('(function inspectSourceMedia')) return this.inspection;
    if (script.startsWith('(async function readDocumentImage')) return this.documentImage;
    if (script.includes('const s = window.__studyPilotTaskNavigation')) return this.navGet;
    return 'document-one';
  });
  constructor(public id: number, public kind = 'webview') { super(); }
  getType() { return this.kind; }
  getURL() { return this.url; }
  isDestroyed() { return this.destroyed; }
  getBackgroundThrottling() { return this.throttled; }
  setBackgroundThrottling(value: boolean) { this.throttled = value; this.history.push(value); }
  destroy() { this.destroyed = true; this.emit('destroyed'); }
}

function setup(limits: { imageLimit?: number; taskLimit?: number; timeoutMs?: number } = {}) {
  const host = new Contents(1, 'window'); const source = new Contents(2); const ai = new Contents(3);
  source.hostWebContents = host; ai.hostWebContents = host;
  const contents = new Map([host, source, ai].map((item) => [item.id, item]));
  const manager = createWebAITaskResourceManager({ getMainWindow: () => ({ isDestroyed: () => false, webContents: host }) as any, getContents: (id) => contents.get(id) as any, ...limits });
  const lease = { sessionId: 'task-one', sourceContentsId: 2, sourceUrl: source.url, aiContentsId: 3 };
  const media = { sessionId: lease.sessionId, questionHash: 'web_hash', mediaId: 'media_one', selector: '#question img', sourceUrl: 'https://source.test/q.png' };
  return { host, source, ai, contents, manager, lease, media };
}

describe('native Web AI task leases', () => {
  it('never releases a new lease when an old initialization rejects after session reuse', async () => {
    const { manager, host, source, lease, media } = setup();
    let rejectOld!: (error: Error) => void;
    source.executeJavaScript.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    const old = manager.lease(host as any, lease);
    manager.release(host as any, lease.sessionId);
    expect(await manager.lease(host as any, lease)).toEqual({ ok: true });
    rejectOld(new Error('old document closed'));
    expect((await old).ok).toBe(false);
    expect((await manager.read(host as any, media)).ok).toBe(true);
    expect(source.throttled).toBe(false);
    manager.dispose();
  });
  it('waits for the shared initialization before acknowledging a concurrent lease', async () => {
    const { manager, host, source, lease } = setup();
    let initialize!: (value: string) => void;
    source.executeJavaScript.mockImplementationOnce(() => new Promise(resolve => { initialize = resolve; }));
    const first = manager.lease(host as any, lease);
    let acknowledged = false;
    const second = manager.lease(host as any, lease).then(result => { acknowledged = true; return result; });
    await Promise.resolve(); await Promise.resolve();
    expect(acknowledged).toBe(false);
    initialize('document-one');
    expect(await first).toEqual({ ok: true }); expect(await second).toEqual({ ok: true });
    manager.dispose();
  });
  it('rejects non-host callers, foreign webviews and stale source URLs before retaining resources', async () => {
    const { manager, host, source, ai, lease } = setup();
    expect((await manager.lease(source as any, lease)).ok).toBe(false);
    ai.hostWebContents = new Contents(10, 'window');
    expect((await manager.lease(host as any, lease)).ok).toBe(false);
    ai.hostWebContents = host;
    expect((await manager.lease(host as any, { ...lease, sourceUrl: 'https://source.test/other' })).ok).toBe(false);
    expect(host.history).toEqual([]); expect(source.history).toEqual([]);
  });

  it('reference counts shared source, AI and host resources and restores their original settings', async () => {
    const { manager, host, source, ai, lease } = setup();
    ai.throttled = false;
    expect(await manager.lease(host as any, lease)).toEqual({ ok: true });
    expect(await manager.lease(host as any, lease)).toEqual({ ok: true });
    await manager.lease(host as any, { ...lease, sessionId: 'task-two' });
    expect(source.listenerCount('will-navigate')).toBe(1);
    manager.release(host as any, lease.sessionId);
    expect([host.throttled, source.throttled, ai.throttled]).toEqual([false, false, false]);
    manager.release(host as any, 'task-two');
    expect([host.throttled, source.throttled, ai.throttled]).toEqual([true, true, false]);
    expect(source.history).toEqual([false, true]);
    expect(source.listenerCount('will-navigate')).toBe(0);
    expect(source.listenerCount('destroyed')).toBe(0);
  });

  it('clears task resources when a retained view is destroyed', async () => {
    const { manager, host, source, ai, lease, media } = setup();
    await manager.lease(host as any, lease);
    await manager.read(host as any, media);
    source.destroy();
    expect(host.throttled).toBe(true); expect(ai.throttled).toBe(true);
    expect((await manager.read(host as any, media)).ok).toBe(false);
    expect(manager.release(ai as any, lease.sessionId).ok).toBe(false);
  });

  it('binds an AI view after source-only lease and replaces it without releasing the source', async () => {
    const { manager, host, source, ai, contents, lease } = setup();
    await manager.lease(host as any, { ...lease, aiContentsId: undefined });
    await manager.lease(host as any, lease);
    await manager.lease(host as any, { ...lease, aiContentsId: undefined });
    expect(ai.throttled).toBe(false);
    const replacement = new Contents(4); replacement.hostWebContents = host; contents.set(4, replacement);
    expect(await manager.lease(host as any, { ...lease, aiContentsId: 4 })).toEqual({ ok: true });
    expect(ai.throttled).toBe(true); expect(replacement.throttled).toBe(false);
    expect(source.history).toEqual([false]);
    manager.dispose(); expect(replacement.throttled).toBe(true); expect(source.throttled).toBe(true);
  });

  it('blocks leased-source navigation and forwards confirmed GET only, while leaving the AI view alone', async () => {
    const { manager, host, source, ai, lease } = setup();
    await manager.lease(host as any, lease);
    const event = () => ({ url: 'https://source.test/next', isMainFrame: true, preventDefault: vi.fn() });
    const get = event(); source.emit('will-navigate', get); await Promise.resolve(); await Promise.resolve();
    expect(get.preventDefault).toHaveBeenCalledOnce();
    expect(host.send).toHaveBeenCalledWith('browser:open-tab', expect.objectContaining({ url: get.url, foreground: true }));
    source.navGet = false;
    const post = event(); source.emit('will-navigate', post); await Promise.resolve(); await Promise.resolve();
    expect(post.preventDefault).toHaveBeenCalledOnce(); expect(host.send).toHaveBeenCalledTimes(1);
    expect(ai.listenerCount('will-navigate')).toBe(0);
    manager.dispose();
  });
});

describe('native question media resources', () => {
  it.each(['valid', 'foreign-origin', 'file', 'loop', 'oversize', 'cancel'])('handles image CDN redirects with bounded native requests (%s)', async variant => {
    const { manager, host, source, lease, media } = setup({ imageLimit: variant === 'oversize' ? 2 : 8 });
    await manager.lease(host as any, lease);
    source.session.fetch.mockRejectedValue(new Error("Attempted to redirect, but redirect policy was 'error'"));
    const request = new EventEmitter() as EventEmitter & { end: () => void; abort: ReturnType<typeof vi.fn>; followRedirect: ReturnType<typeof vi.fn> };
    request.abort = vi.fn(() => request.emit('abort'));
    request.followRedirect = vi.fn();
    request.end = () => queueMicrotask(() => {
      if (variant === 'cancel') { manager.release(host as any, lease.sessionId); return; }
      const target = variant === 'file' ? 'file:///private.png' : variant === 'foreign-origin' ? 'https://other.test/image.png' : 'https://source.test/cdn/q.png';
      for (let i = 0; i < (variant === 'loop' ? 6 : 1); i++) request.emit('redirect', 301, 'GET', target);
      if (variant === 'file' || variant === 'foreign-origin' || variant === 'loop') return;
      const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'image/png', 'content-length': '3' } });
      request.emit('response', response); response.emit('data', Buffer.from([1, 2, 3])); response.emit('end');
    });
    vi.mocked(net.request).mockReturnValue(request as any);
    try {
      const result = await manager.read(host as any, media);
      expect(result.ok).toBe(variant === 'valid');
      expect(net.request).toHaveBeenCalledWith(expect.objectContaining({ session: source.session, credentials: 'include', redirect: 'manual' }));
      if (variant === 'valid') expect(result).toMatchObject({ bytes: [1, 2, 3], mime: 'image/png' });
      else expect(request.abort).toHaveBeenCalled();
      if (variant === 'file' || variant === 'foreign-origin') expect(request.followRedirect).not.toHaveBeenCalled();
    } finally { manager.dispose(); vi.mocked(net.request).mockClear(); }
  });

  it.each(['visible', 'hidden', 'display', 'visibility', 'answer', 'toolbar'])('validates actual visibility of aria-hidden question images (%s)', async variant => {
    const { manager, host, source, lease, media } = setup();
    await manager.lease(host as any, lease);
    const root = new AnswerElement('DIV', { class: 'questionLi' });
    const title = new AnswerElement('H3', { class: variant === 'answer' ? 'student-answer' : variant === 'toolbar' ? 'toolbar' : 'mark_name', 'aria-hidden': 'true', ...(variant === 'hidden' ? { hidden: '' } : {}) });
    const image = new AnswerElement('IMG', { src: media.sourceUrl });
    root.append(title.append(image));
    Object.assign(image, { baseURI: lease.sourceUrl, complete: false });
    const pageWindow = { __studyPilotTaskNavigation: { documentId: 'document-one' } };
    source.executeJavaScript.mockImplementation(async script => runInNewContext(script, { window: pageWindow, document: { querySelector: () => image }, URL,
      getComputedStyle: (element: unknown) => ({ display: element === title && variant === 'display' ? 'none' : 'block', visibility: element === title && variant === 'visibility' ? 'hidden' : 'visible' }), innerWidth: 1000, innerHeight: 800 }));
    try {
      expect((await manager.read(host as any, media)).ok).toBe(variant === 'visible');
      if (variant === 'visible') expect(source.session.fetch).toHaveBeenCalledOnce();
      else expect(source.session.fetch).not.toHaveBeenCalled();
    } finally { manager.dispose(); }
  });

  it('fetches with source credentials/referrer and caches memory bytes with a SHA-256 digest', async () => {
    const { manager, host, source, lease, media } = setup();
    await manager.lease(host as any, lease);
    const first = await manager.read(host as any, media);
    expect(first).toEqual({ ok: true, bytes: [1, 2, 3, 4], mime: 'image/png', digest: createHash('sha256').update(Buffer.from([1, 2, 3, 4])).digest('hex') });
    expect(source.session.fetch).toHaveBeenCalledWith(media.sourceUrl, expect.objectContaining({ credentials: 'include', referrer: lease.sourceUrl, redirect: 'error', signal: expect.any(AbortSignal) }));
    expect(await manager.read(host as any, media)).toEqual(first);
    expect(source.session.fetch).toHaveBeenCalledOnce();
    manager.release(host as any, lease.sessionId);
    expect((await manager.read(host as any, media)).ok).toBe(false);
  });

  it('rejects non-images and limits streamed individual and total task bytes', async () => {
    const first = setup({ imageLimit: 3 });
    await first.manager.lease(first.host as any, first.lease);
    expect(await first.manager.read(first.host as any, first.media)).toMatchObject({ ok: false, error: expect.stringContaining('8 MiB') });
    first.source.session.fetch.mockImplementation(async () => new Response('html', { headers: { 'content-type': 'text/html' } }));
    expect(await first.manager.read(first.host as any, first.media)).toMatchObject({ ok: false, error: expect.stringContaining('图片内容') });
    first.manager.dispose();
    const second = setup({ imageLimit: 8, taskLimit: 6 });
    await second.manager.lease(second.host as any, second.lease);
    expect((await second.manager.read(second.host as any, second.media)).ok).toBe(true);
    expect(await second.manager.read(second.host as any, { ...second.media, mediaId: 'media_two' })).toMatchObject({ ok: false, error: expect.stringContaining('32 MiB') });
    second.manager.dispose();
  });

  it('requires source DOM validation and never fetches a rejected or changed source document', async () => {
    const { manager, host, source, lease, media } = setup();
    await manager.lease(host as any, lease);
    source.inspection = { error: '图片地址与页面不一致' };
    expect((await manager.read(host as any, { ...media, sourceUrl: 'file:///secret.png' })).ok).toBe(false);
    expect(source.session.fetch).not.toHaveBeenCalled();
    source.url += '?changed';
    expect((await manager.read(host as any, media)).ok).toBe(false);
    manager.dispose();
  });

  it('uses a validated loaded visible rectangle for screenshot fallback', async () => {
    const { manager, host, source, lease, media } = setup();
    await manager.lease(host as any, lease);
    const rect = { x: 10, y: 20, width: 80, height: 60 };
    source.inspection = { rect };
    expect(await manager.read(host as any, { ...media, sourceUrl: undefined })).toMatchObject({ ok: true, bytes: [5, 6, 7], mime: 'image/png' });
    expect(source.capturePage).toHaveBeenCalledWith(rect);
    manager.dispose();
  });

  it('reads validated data/blob images inside the source and enforces the deadline', async () => {
    const { manager, host, source, lease, media } = setup();
    await manager.lease(host as any, lease);
    source.inspection = { sourceUrl: 'blob:https://source.test/one' };
    expect(await manager.read(host as any, { ...media, sourceUrl: source.inspection.sourceUrl })).toMatchObject({ ok: true, bytes: [7, 8, 9], mime: 'image/png' });
    expect(source.session.fetch).not.toHaveBeenCalled();
    manager.dispose();
    vi.useFakeTimers();
    const timed = setup({ timeoutMs: 50 });
    await timed.manager.lease(timed.host as any, timed.lease);
    timed.source.session.fetch.mockImplementation(() => new Promise(() => {}));
    const pending = timed.manager.read(timed.host as any, timed.media);
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toEqual({ ok: false, error: '图片读取超时' });
    timed.manager.dispose();
  });

  it('does not retain or return bytes from reads completed after task release', async () => {
    const { manager, host, source, lease, media } = setup();
    await manager.lease(host as any, lease);
    let complete!: (response: Response) => void;
    source.session.fetch.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = manager.read(host as any, media);
    await Promise.resolve();
    manager.release(host as any, lease.sessionId);
    complete(new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }));
    expect((await pending).ok).toBe(false);
  });

  it('rejects cached data after the leased document is replaced at the same URL', async () => {
    const { manager, host, source, lease, media } = setup();
    await manager.lease(host as any, lease);
    expect((await manager.read(host as any, media)).ok).toBe(true);
    source.inspection = { error: '来源网页文档已改变' };
    expect(await manager.read(host as any, media)).toEqual({ ok: false, error: '来源网页文档已改变' });
    expect(source.session.fetch).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it.each([false, true])('rejects a same-URL document replacement during fetch (fallback=%s)', async (fallback) => {
    const { manager, host, source, lease, media } = setup();
    await manager.lease(host as any, lease);
    source.inspection = { sourceUrl: media.sourceUrl, rect: { x: 0, y: 0, width: 40, height: 40 } };
    source.session.fetch.mockImplementation(async () => {
      source.inspection = { error: '来源网页文档已改变' };
      if (fallback) throw new Error('network failed');
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });
    });
    expect(await manager.read(host as any, media)).toEqual({ ok: false, error: '来源网页文档已改变' });
    expect(source.capturePage).not.toHaveBeenCalled();
    manager.dispose();
  });

  it.each(['standard', 'single', 'multiple', 'judgement', 'completion', 'essay', 'metadata', 'controls', 'text-type', 'text-metadata'])('executes the real scoped %s DOM check before allowing an image URL', async layout => {
    const { manager, host, source, lease, media } = setup();
    await manager.lease(host as any, lease);
    const qtypes: Record<string, string> = { single: '0', multiple: '1', judgement: '3', completion: '2', essay: '4' };
    const root = new AnswerElement('DIV', layout === 'standard' ? { class: 'questionLi' } : qtypes[layout] ? { qtype: qtypes[layout] } : {});
    if (layout !== 'standard') {
      root.append(new AnswerElement('DIV', { class: layout === 'text-type' ? 'mark_name' : 'question-title' }, layout === 'text-type' ? '论述题：请根据图示解释实验结果。' : '请选择图中的正确结果。'));
      if (layout === 'completion' || layout === 'essay' || layout.startsWith('text-')) root.append(new AnswerElement('TEXTAREA'));
      else root.append(new AnswerElement('INPUT', { type: 'radio', value: 'A' }), new AnswerElement('INPUT', { type: 'radio', value: 'B' }));
      if (layout === 'metadata') root.append(new AnswerElement('INPUT', { type: 'hidden', name: 'type123', value: '0' }));
      if (layout === 'text-metadata') root.append(new AnswerElement('INPUT', { type: 'hidden', name: 'typeName123', value: '填空题' }));
    }
    const image = new AnswerElement('IMG', { src: 'https://source.test/q.png' });
    root.append(image);
    Object.assign(image, { baseURI: lease.sourceUrl, complete: false });
    const pageWindow = { __studyPilotTaskNavigation: { documentId: 'document-one' } };
    source.executeJavaScript.mockImplementation(async (script) => runInNewContext(script, { window: pageWindow, document: { querySelector: () => image }, URL, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), innerWidth: 1000, innerHeight: 800 }));
    expect((await manager.read(host as any, media)).ok).toBe(true);
    expect(await manager.read(host as any, { ...media, mediaId: 'other', sourceUrl: 'https://source.test/not-in-dom.png' })).toMatchObject({ ok: false, error: '图片地址与页面不一致' });
    image.attrs.src = 'file:///secret.png';
    expect((await manager.read(host as any, { ...media, mediaId: 'file', sourceUrl: 'file:///secret.png' })).ok).toBe(false);
    root.children = []; image.parentElement = null;
    expect((await manager.read(host as any, { ...media, mediaId: 'chrome', sourceUrl: undefined })).ok).toBe(false);
    expect(source.session.fetch).toHaveBeenCalledOnce();
    manager.dispose();
  });
});
