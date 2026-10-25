import type { PlatformAPI } from './types';
import { NativeWebView } from './nativeWebViewPlugin';

const DB_KEY = 'studypilot_settings_v1';

function loadSettings(): any {
  try {
    const raw = localStorage.getItem(DB_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveSettings(settings: any) {
  try { localStorage.setItem(DB_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

type ChunkListener = (payload: { requestId: string; chunk: string }) => void;
const chunkListeners = new Set<ChunkListener>();

const navListeners = new Set<(url: string) => void>();
const tabListeners = new Set<(p: { url: string; title?: string }) => void>();
const androidNavListeners = new Set<(p: { url: string; title: string }) => void>();

// The NativeWebViewPlugin in Kotlin fires this event through the bridge
if (typeof window !== 'undefined') {
  (window as any).__nativeWebViewNav = (url: string, title: string) => {
    navListeners.forEach((cb) => cb(url));
    androidNavListeners.forEach((cb) => cb({ url, title }));
  };
}

/**
 * Capacitor / Android implementation.
 * AI requests go through direct fetch (CORS works from an Android WebView).
 * Settings are persisted in localStorage (Capacitor Preferences would need a plugin).
 * Native-OS notifications use Capacitor's LocalNotifications plugin when available.
 */
export function createCapacitorBridge(): PlatformAPI {
  const chunkCallbacks = new Map<string, (chunk: string) => void>();
  if ((window as any).Capacitor?.getPlatform?.() === 'android') {
    void NativeWebView.onNavigationChanged(state => {
      if (state.tabId !== state.activeTabId) return;
      navListeners.forEach(cb => cb(state.url));
      androidNavListeners.forEach(cb => cb(state));
    }).catch(error => console.error('浏览器导航监听失败', error));
  }

  return {
    isElectron: false,
    isAndroid: true,

    getSettings: async () => loadSettings(),
    setSettings: async (settings) => saveSettings(settings),

    aiChat: async (payload) => {
      const requestId = payload.requestId ?? `ai_${Date.now()}`;
      const url = `${payload.baseUrl.replace(/\/$/, '')}/chat/completions`;
      const body = { ...payload.body };
      const isStream = payload.stream && body.stream !== false;
      if (!isStream) body.stream = false;

      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), payload.timeoutMs ?? 60_000);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(payload.headers ?? {}) },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          const txt = await response.text().catch(() => '');
          return { success: false, statusCode: response.status, error: `接口返回 ${response.status}：${txt.slice(0, 500)}` };
        }
        const contentType = response.headers.get('content-type') ?? '';
        const isJson = contentType.includes('application/json');

        if (isStream && response.body && !isJson) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let done = false;
          while (!done) {
            const { value, done: d } = await reader.read();
            done = d;
            if (value) {
              const chunk = decoder.decode(value, { stream: !done });
              chunkListeners.forEach((cb) => cb({ requestId, chunk }));
              chunkCallbacks.get(requestId)?.(chunk);
            }
          }
          return { success: true, statusCode: 200 };
        }
        const text = await response.text();
        if (isJson && isStream) return { success: true, statusCode: 200, text, json: true };
        return { success: true, statusCode: 200, text };
      } catch (err: any) {
        return { success: false, statusCode: 0, error: err?.message ?? 'AI 请求失败。' };
      } finally {
        window.clearTimeout(timeoutId);
        chunkCallbacks.delete(requestId);
      }
    },

    onAIChatChunk: (cb) => {
      chunkListeners.add(cb);
      return () => chunkListeners.delete(cb);
    },

    minimize: () => { /* no-op on Android */ },
    maximize: () => { /* no-op on Android */ },
    close: () => { /* no-op on Android */ },

    notify: async (title, body) => {
      try {
        const { LocalNotifications } = await import('@capacitor/local-notifications');
        await LocalNotifications.schedule({
          notifications: [{ id: Date.now(), title, body }],
        });
      } catch { /* plugin not available in dev */ }
    },

    openExternalUrl: async (url) => {
      try {
        const { Browser } = await import('@capacitor/browser');
        await Browser.open({ url });
        return { success: true };
      } catch {
        window.open(url, '_blank');
        return { success: true };
      }
    },

    openInternalBrowserTab: async (url) => {
      tabListeners.forEach((cb) => cb({ url }));
    },

    getRecentErrorLogs: async () => {
      try {
        const raw = localStorage.getItem('studypilot_error_logs');
        return raw ? JSON.parse(raw) : [];
      } catch { return []; }
    },
    recordError: (payload) => {
      try {
        const logs = JSON.parse(localStorage.getItem('studypilot_error_logs') ?? '[]');
        logs.unshift({ ...payload, ts: Date.now() });
        localStorage.setItem('studypilot_error_logs', JSON.stringify(logs.slice(0, 200)));
      } catch { /* ignore */ }
    },
    log: (_level, _message) => { /* no-op; console already available */ },

    getWebviewSessionState: async () => ({ success: true, persistent: true, partition: 'android-native' }),
    clearWebviewSession: async () => {
      try {
        const { NativeWebView } = await import('./nativeWebViewPlugin');
        await NativeWebView.clearSession();
        return { success: true };
      } catch { return { success: false }; }
    },
    getWebviewPreloadPath: async () => null,
    checkForUpdates: async () => ({ hasUpdate: false }),

    listCloudQuestionBanks: async (source) => {
      const repos: Record<string, any> = {
        github: { owner: 'XiYue-FireFly', repo: 'Xuexitong-Answer-Helper-Question-bank', branch: 'main', rawBaseUrl: 'https://raw.githubusercontent.com/XiYue-FireFly/Xuexitong-Answer-Helper-Question-bank/main', contentsApiUrl: 'https://api.github.com/repos/XiYue-FireFly/Xuexitong-Answer-Helper-Question-bank/contents' },
        gitee: { owner: 'SunandMoon-FireFly', repo: 'xuexitong-answer-helper-question-bank', branch: 'main', rawBaseUrl: 'https://gitee.com/SunandMoon-FireFly/xuexitong-answer-helper-question-bank/raw/main', contentsApiUrl: 'https://gitee.com/api/v5/repos/SunandMoon-FireFly/xuexitong-answer-helper-question-bank/contents' },
      };
      const repo = repos[source] ?? repos.github;
      try {
        const res = await fetch(`${repo.rawBaseUrl}/manifest.json`);
        const manifest = await res.json();
        return { success: true, files: manifest?.files ?? [], repo };
      } catch { return { success: false, files: [] }; }
    },
    downloadCloudQuestionBank: async (payload) => {
      try {
        const res = await fetch(payload.url);
        const text = await res.text();
        return { success: true, content: text };
      } catch (err: any) { return { success: false, error: err?.message }; }
    },
    uploadCloudQuestionBank: async () => ({ success: false, error: '安卓端暂不支持上传题库到云端，请使用 Windows 端。' }),

    leaseWebAITask: async (payload) => {
      try {
        const { NativeWebView } = await import('./nativeWebViewPlugin');
        const result = await (NativeWebView as any).leaseWebAITask?.({
          sessionId: payload.sessionId,
          sourceUrl: payload.sourceUrl || '',
        }) ?? { ok: true, sessionId: payload.sessionId };
        return result;
      } catch {
        return { ok: true, sessionId: payload.sessionId ?? `android_${Date.now()}` };
      }
    },
    releaseWebAITask: async (sessionId) => {
      try {
        const { NativeWebView } = await import('./nativeWebViewPlugin');
        await (NativeWebView as any).releaseWebAITask?.({ sessionId });
      } catch { /* no-op */ }
    },
    readQuestionMedia: async (payload) => {
      try {
        const { NativeWebView } = await import('./nativeWebViewPlugin');
        const result = await (NativeWebView as any).readQuestionMedia?.(payload);
        if (!result) return { ok: false, error: '图片读取返回空结果。' };
        return result;
      } catch (err: any) {
        return { ok: false, error: err?.message ?? '图片读取失败。' };
      }
    },

    onPageNavigated: (cb) => { navListeners.add(cb); return () => navListeners.delete(cb); },
    onOpenBrowserTab: (cb) => { tabListeners.add(cb); return () => tabListeners.delete(cb); },
    onStatusChanged: (_cb) => () => undefined,
    onAndroidWebViewNav: (cb) => { androidNavListeners.add(cb); return () => androidNavListeners.delete(cb); },
  };
}
