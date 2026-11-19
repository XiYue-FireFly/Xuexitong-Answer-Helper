import type { QuestionMediaRead, WebAITaskLease } from '../../electron/web-ai-task-resources';
import type { RustHostTransport } from './hostClient';
export type { RustHostTransport } from './hostClient';

type Rect = { x: number; y: number; width: number; height: number };
type ChatChunk = { requestId: string; chunk: string };
type ChatRequest = { baseUrl: string; headers?: Record<string, string>; body?: Record<string, any>; stream?: boolean; requestId?: string; timeoutMs?: number };
type Callback = (payload: any) => void;
type RustWindow = Window & { __RUST_HOST__?: RustHostTransport; electronAPI?: LegacyApi };
const installations = new WeakMap<Window, Promise<LegacyApi>>();
const eventChannels = ['ai:chat-chunk', 'browser:navigated', 'browser:open-tab', 'system:status'] as const;

/** Install every event transport before the original application can invoke it. */
export async function installLegacyApi(): Promise<LegacyApi> {
  if (typeof window === 'undefined') throw new Error('Rust host requires a window');
  const target = window as RustWindow;
  const installed = installations.get(target);
  if (installed) return installed;
  const host = target.__RUST_HOST__;
  if (host?.identity !== 'rust' || typeof host.invoke !== 'function' || typeof host.listen !== 'function') throw new Error('Rust host transport is unavailable');
  if (target.electronAPI) throw new Error('Rust host facade would overwrite an existing desktop API');
  const installation = connect(target, host);
  installations.set(target, installation);
  try { return await installation; }
  catch (error) { installations.delete(target); throw error; }
}

function notifyTransportError(target: Window, command: string) {
  // Native errors can contain request URLs or credentials. Do not relay their text.
  target.dispatchEvent(new CustomEvent('rust-host-error', { detail: { command, error: 'Rust host transport failed' } }));
}

async function connect(target: RustWindow, host: RustHostTransport) {
  const subscribers = new Map<string, Set<Callback>>(eventChannels.map(channel => [channel, new Set()]));
  const releases: (() => void)[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    target.removeEventListener('pagehide', dispose);
    for (const release of releases.splice(0)) {
      try { release(); } catch { notifyTransportError(target, 'event:unsubscribe'); }
    }
    for (const callbacks of subscribers.values()) callbacks.clear();
  };
  target.addEventListener('pagehide', dispose, { once: true });
  try {
    for (const channel of eventChannels) {
      const release = await host.listen(channel, payload => {
        if (disposed) return;
        for (const callback of [...subscribers.get(channel)!]) {
          try { callback(payload); } catch { notifyTransportError(target, channel); }
        }
      });
      if (disposed) { release(); throw new Error('Rust host facade has been disposed'); }
      releases.push(release);
    }
  } catch (error) { dispose(); throw error; }
  const invoke = (command: string, payload?: unknown): Promise<any> => disposed
    ? Promise.reject(new Error('Rust host facade has been disposed')) : host.invoke(command, payload);
  const send = (command: string, payload?: unknown): void => {
    void invoke(command, payload).then(result => {
      if (result?.success === false || result?.ok === false) notifyTransportError(target, command);
    }).catch(() => notifyTransportError(target, command));
  };
  const on = <T>(channel: string, callback: (payload: T) => void): (() => void) => {
    if (disposed) throw new Error('Rust host facade has been disposed');
    if (typeof callback !== 'function') throw new TypeError('Desktop event callback must be a function');
    // Wrap each registration so registering one function twice stays independent.
    const subscription: Callback = payload => callback(payload);
    const callbacks = subscribers.get(channel)!;
    callbacks.add(subscription);
    return () => { callbacks.delete(subscription); };
  };
  const api = {
    minimize: () => send('window:minimize'),
    maximize: () => send('window:maximize'),
    close: () => send('window:close'),
    setTitlebarTheme: (theme: 'light' | 'dark') => invoke('window:set-titlebar-theme', theme),
    navigate: (url: string) => invoke('browser:navigate', url),
    screenshot: (rect?: Rect) => invoke('browser:screenshot', rect),
    captureGlass: (request: { guestId: number; region: Rect; viewport: Rect }) => invoke('glass:capture', request),
    captureAutomationSnapshot: () => invoke('automation:snapshot'),
    executeAutomationPlan: (payload: any) => invoke('automation:execute-plan', payload),
    getSettings: () => invoke('settings:get'),
    setSettings: (settings: any) => invoke('settings:set', settings),
    discoverAIModels: (payload: { baseUrl: string; apiKey?: string; authHeader?: 'authorization' | 'api-key' | 'none' }) => invoke('ai:discover-models', payload),
    getWebviewPreloadPath: () => invoke('settings:get-webview-preload'),
    getErrorLogPath: () => invoke('diagnostics:get-error-log-path'),
    getRecentErrorLogs: (limit?: number) => invoke('diagnostics:get-recent-error-logs', limit),
    checkForUpdates: () => invoke('app:check-update'),
    openExternalUrl: (url: string) => invoke('app:open-url', url),
    openInternalBrowserTab: (url: string) => invoke('browser:open-internal-tab', url),
    notify: (title: string, body: string) => invoke('app:notify', { title, body }),
    getWebviewSessionState: () => invoke('session:get-webview-state'),
    leaseWebAITask: (payload: WebAITaskLease) => invoke('web-ai:lease-task', payload),
    releaseWebAITask: (sessionId: string) => invoke('web-ai:release-task', sessionId),
    readQuestionMedia: (payload: QuestionMediaRead) => invoke('web-ai:read-question-media', payload),
    clearWebviewSession: () => invoke('session:clear-webview-login'),
    listCloudQuestionBanks: (source: string) => invoke('cloud-bank:list', source),
    downloadCloudQuestionBank: (payload: any) => invoke('cloud-bank:download', payload),
    uploadCloudQuestionBank: (payload: any) => invoke('cloud-bank:upload', payload),
    aiChat: (payload: ChatRequest) => invoke('ai:chat', payload),
    onAIChatChunk: (callback: (payload: ChatChunk) => void) => on('ai:chat-chunk', callback),
    log: (level: string, message: string) => send('system:log', { level, message }),
    recordError: (payload: any) => send('diagnostics:error-log', payload),
    onPageNavigated: (callback: (url: string) => void) => on('browser:navigated', callback),
    onOpenBrowserTab: (callback: (payload: { url: string; title?: string }) => void) => on('browser:open-tab', callback),
    onStatusChanged: (callback: (status: string) => void) => on('system:status', callback),
  };
  const frozenApi = Object.freeze(api);
  target.electronAPI = frozenApi;
  return frozenApi;
}

export type LegacyApi = Awaited<ReturnType<typeof connect>>;
