import React, { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { getRustHost, type GuestAction, type GuestBounds, type GuestCreateRequest, type GuestHostEvent, type GuestSnapshot, type RustHostTransport, type Unlisten } from './hostClient';

export type CompatGuestElement = HTMLElement & {
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  isLoading(): boolean;
  getWebContentsId(): number;
  loadURL(url: string): Promise<void>;
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>;
  send(channel: string, ...args: unknown[]): Promise<void>;
  sendInputEvent(event: { type: 'keyDown' | 'keyUp'; keyCode: string }): Promise<void>;
  reload(): void;
  stop(): void;
  goBack(): void;
  goForward(): void;
};

export interface CompatGuestViewProps extends React.HTMLAttributes<HTMLElement> {
  src: string;
  preload?: string;
  partition?: string;
  webpreferences?: string;
  'data-active-browser'?: string;
}

const EVENTS = new Set(['did-start-loading', 'did-start-navigation', 'did-stop-loading', 'did-fail-load',
  'did-navigate', 'did-navigate-in-page', 'page-title-updated', 'dom-ready', 'ipc-message',
  'render-process-gone', 'destroyed', 'new-window', 'found-in-page', 'console-message']);
let sequence = 0;

function validSnapshot(value: GuestSnapshot): boolean {
  return !!value && Number.isSafeInteger(value.guestId) && value.guestId > 0 && typeof value.url === 'string'
    && typeof value.title === 'string' && typeof value.canGoBack === 'boolean' && typeof value.canGoForward === 'boolean'
    && typeof value.loading === 'boolean' && Number.isSafeInteger(value.documentGeneration) && value.documentGeneration >= 0;
}

export function decodeExecutionResult<T>(response: unknown): T {
  if (!response || typeof response !== 'object') throw new Error('Rust 宿主返回无效的脚本结果。');
  const result = response as { protocol?: unknown; value?: { type?: unknown; value?: unknown } };
  if (result.protocol !== 'studypilot-rust-evaluation-v1' || !result.value || typeof result.value !== 'object') throw new Error('Rust 宿主返回无效的脚本结果。');
  if (result.value.type === 'undefined') return undefined as T;
  if (result.value.type === 'json' && Object.prototype.hasOwnProperty.call(result.value, 'value')) return result.value.value as T;
  throw new Error('Rust 宿主返回无效的脚本结果。');
}

/** DOM-only adapter: all website execution and native input remain host commands. */
export function attachGuestProxy(element: HTMLElement, initial: Omit<GuestCreateRequest, 'instanceId' | 'bounds' | 'active'>,
  host: RustHostTransport = getRustHost()) {
  const instanceId = `rust-guest-${Date.now().toString(36)}-${++sequence}`;
  let disposed = false, unsubscribe: Unlisten | undefined, snapshot: GuestSnapshot = {
    guestId: 0, url: initial.url, title: '', canGoBack: false, canGoForward: false, loading: true, documentGeneration: 0
  };
  let lastLayout = '', receivedSnapshot = false;
  let documentReady = false;
  const documentWaiters = new Set<() => void>();
  const wakeDocumentWaiters = () => { for (const wake of [...documentWaiters]) wake(); };
  let focusBarrier: Promise<unknown> = Promise.resolve(), navigationBarrier: Promise<unknown> = Promise.resolve();
  const dispatch = (name: string, properties: Record<string, unknown> = {}) => {
    const event = new Event(name);
    for (const [key, value] of Object.entries(properties)) if (!['type', 'target', 'currentTarget', 'isTrusted', 'srcElement'].includes(key)) Object.defineProperty(event, key, { value, enumerable: true });
    element.dispatchEvent(event);
  };
  const report = (error: unknown) => { if (!disposed) dispatch('did-fail-load', { errorCode: -2, errorDescription: error instanceof Error ? error.message : String(error), isMainFrame: true }); };
  const observed = <T,>(promise: Promise<T>): Promise<T> => { void promise.catch(report); return promise; };
  const layout = () => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    const bounds: GuestBounds = { x: rect.x, y: rect.y, width: Math.max(0, rect.width), height: Math.max(0, rect.height) };
    const active = element.dataset.activeBrowser === 'true' && style.visibility !== 'hidden' && style.display !== 'none' && bounds.width > 0 && bounds.height > 0;
    return { bounds, active };
  };
  const destroyed = new Set<number>();
  const destroy = (guestId: number) => {
    if (guestId <= 0 || destroyed.has(guestId)) return;
    destroyed.add(guestId);
    void host.invoke('browser:destroy', { instanceId, guestId }).catch(() => {});
  };
  const ready = Promise.resolve().then(async () => {
    const remove = await host.listen<GuestHostEvent>('browser:event', message => {
      if (disposed || message.instanceId !== instanceId || !EVENTS.has(message.event)) return;
      if (snapshot.guestId && message.guestId !== snapshot.guestId) return;
      if (!Number.isSafeInteger(message.documentGeneration) || message.documentGeneration < snapshot.documentGeneration) return;
      const previousGeneration = snapshot.documentGeneration;
      if (message.snapshot) {
        if (!validSnapshot(message.snapshot) || message.snapshot.guestId !== message.guestId || message.snapshot.documentGeneration !== message.documentGeneration) return;
        snapshot = { ...message.snapshot };
        receivedSnapshot = true;
      } else if (message.documentGeneration !== snapshot.documentGeneration) return;
      if (snapshot.documentGeneration > previousGeneration || snapshot.loading
        || ['did-start-navigation', 'did-start-loading', 'render-process-gone', 'destroyed'].includes(message.event)) documentReady = false;
      if (['dom-ready', 'did-stop-loading'].includes(message.event) && !snapshot.loading) documentReady = true;
      wakeDocumentWaiters();
      dispatch(message.event, message.properties);
    });
    if (disposed) { remove(); throw new Error('网页已关闭。'); }
    unsubscribe = remove;
    const created = await host.invoke<GuestSnapshot>('browser:create', { ...initial, instanceId, ...layout() });
    if (!validSnapshot(created)) { if (Number.isSafeInteger(created?.guestId)) destroy(created.guestId); throw new Error('Rust 宿主返回无效的网页状态。'); }
    if (disposed) { destroy(created.guestId); throw new Error('网页已关闭。'); }
    if (snapshot.guestId && snapshot.guestId !== created.guestId) { destroy(created.guestId); throw new Error('Rust 网页实例标识不一致。'); }
    // Native create can complete after lifecycle events. A same-generation
    // event already reflects a later state than the captured create response.
    if (!receivedSnapshot || created.documentGeneration > snapshot.documentGeneration) { snapshot = { ...created }; documentReady = !created.loading; }
    wakeDocumentWaiters();
    return snapshot;
  });
  observed(ready);
  const waitForDocument = (): Promise<void> => {
    if (disposed) return Promise.reject(new Error('网页已关闭。'));
    if (documentReady && !snapshot.loading) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); documentWaiters.delete(check); if (error) reject(error); else resolve(); };
      const check = () => { if (disposed) finish(new Error('网页已关闭。')); else if (documentReady && !snapshot.loading) finish(); };
      const timer = setTimeout(() => finish(new Error('网页尚未就绪。')), 15000);
      documentWaiters.add(check); check();
    });
  };
  const action = async <T,>(name: GuestAction, args: unknown[] = []): Promise<T> => {
    try {
      await ready;
      if (disposed) throw new Error('网页已关闭。');
      const releaseKey = name === 'sendInputEvent' && (args[0] as { type?: unknown })?.type === 'keyUp';
      if (name === 'executeJavaScript' || name === 'sendInputEvent' && !releaseKey) await waitForDocument();
      // A keyUp is cleanup for an already-sent keyDown. Navigation or a failed
      // focus request must not delay that cleanup behind a new DOM handshake.
      if (name === 'sendInputEvent' && !releaseKey) await focusBarrier;
      return await host.invoke<T>('browser:action', { instanceId, guestId: snapshot.guestId, documentGeneration: snapshot.documentGeneration, action: name, args });
    } catch (error) {
      // Tauri command errors are strings; legacy callers read error.message.
      throw error instanceof Error ? error : new Error(String(error));
    }
  };
  const methods = {
    getURL: () => snapshot.url, getTitle: () => snapshot.title, canGoBack: () => snapshot.canGoBack,
    canGoForward: () => snapshot.canGoForward, isLoading: () => snapshot.loading,
    getWebContentsId: () => { if (!snapshot.guestId) throw new Error('网页尚未就绪。'); return snapshot.guestId; },
    loadURL: (url: string) => {
      const pending = observed(navigationBarrier.catch(() => undefined).then(() => action<void>('loadURL', [url])));
      navigationBarrier = pending;
      return pending;
    },
    executeJavaScript: <T,>(code: string, userGesture = false) => observed(action<unknown>('executeJavaScript', [code, userGesture]).then(decodeExecutionResult<T>)),
    send: (channel: string, ...args: unknown[]) => observed(action<void>('send', [channel, ...args])),
    sendInputEvent: (event: { type: 'keyDown' | 'keyUp'; keyCode: string }) => observed(action<void>('sendInputEvent', [event])),
    reload: () => { navigationBarrier = observed(navigationBarrier.catch(() => undefined).then(() => action<void>('reload'))); },
    stop: () => { navigationBarrier = observed(navigationBarrier.catch(() => undefined).then(() => action<void>('stop'))); },
    goBack: () => { navigationBarrier = observed(navigationBarrier.catch(() => undefined).then(() => action<void>('goBack'))); },
    goForward: () => { navigationBarrier = observed(navigationBarrier.catch(() => undefined).then(() => action<void>('goForward'))); },
    focus: () => { focusBarrier = observed(action<void>('focus')); }
  };
  const previous = new Map(Object.keys(methods).map(name => [name, Object.getOwnPropertyDescriptor(element, name)]));
  Object.defineProperties(element, Object.fromEntries(Object.entries(methods).map(([name, value]) => [name, { configurable: true, value }])));
  const updateLayout = () => {
    if (disposed || !snapshot.guestId) return;
    const current = layout(), encoded = JSON.stringify(current);
    if (encoded === lastLayout) return;
    lastLayout = encoded;
    const updating = observed(host.invoke('browser:update-layout', { instanceId, guestId: snapshot.guestId, ...current }));
    void updating.catch(() => { if (lastLayout === encoded) lastLayout = ''; });
  };
  void ready.then(updateLayout, () => { unsubscribe?.(); unsubscribe = undefined; destroy(snapshot.guestId); });
  return { ready, updateLayout, dispose: () => {
    if (disposed) return;
    disposed = true;
    wakeDocumentWaiters();
    unsubscribe?.(); unsubscribe = undefined;
    destroy(snapshot.guestId);
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(element, name, descriptor);
      else delete (element as unknown as Record<string, unknown>)[name];
    }
  } };
}

export const CompatGuestView = forwardRef<CompatGuestElement, CompatGuestViewProps>(function CompatGuestView(props, forwardedRef) {
  const element = useRef<HTMLElement | null>(null), proxy = useRef<ReturnType<typeof attachGuestProxy>>();
  useLayoutEffect(() => {
    if (!element.current) return;
    const node = element.current;
    const attached = attachGuestProxy(node, { url: props.src, partition: props.partition, preload: props.preload, webPreferences: props.webpreferences });
    proxy.current = attached;
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(attached.updateLayout);
    observer?.observe(node);
    const mutations = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(attached.updateLayout);
    mutations?.observe(node, { attributes: true, attributeFilter: ['style', 'class', 'data-active-browser'] });
    window.addEventListener('resize', attached.updateLayout);
    document.addEventListener('scroll', attached.updateLayout, true);
    return () => {
      observer?.disconnect(); mutations?.disconnect();
      window.removeEventListener('resize', attached.updateLayout);
      document.removeEventListener('scroll', attached.updateLayout, true);
      attached.dispose(); proxy.current = undefined;
    };
  }, [props.src, props.partition, props.preload, props.webpreferences]);
  useImperativeHandle(forwardedRef, () => element.current as CompatGuestElement, [props.src, props.partition, props.preload, props.webpreferences]);
  useLayoutEffect(() => { proxy.current?.updateLayout(); });
  return React.createElement('webview', { ...props, ref: element });
});
