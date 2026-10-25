import type { PlatformAPI } from './types';

/**
 * Electron (Windows) implementation — delegates to window.electronAPI.
 * Behaviour is unchanged from the original app.
 */
export function createElectronBridge(): PlatformAPI {
  const api = (): any => (typeof window !== 'undefined' ? (window as any).electronAPI : null);

  return {
    isElectron: true,
    isAndroid: false,

    getSettings: async () => api()?.getSettings?.() ?? null,
    setSettings: async (settings) => { await api()?.setSettings?.(settings); },

    aiChat: async (payload) => api()?.aiChat?.(payload),
    onAIChatChunk: (cb) => api()?.onAIChatChunk?.(cb) ?? (() => undefined),

    minimize: () => api()?.minimize?.(),
    maximize: () => api()?.maximize?.(),
    close: () => api()?.close?.(),
    notify: async (title, body) => { await api()?.notify?.(title, body); },
    openExternalUrl: async (url) => api()?.openExternalUrl?.(url) ?? { success: false, error: '不可用' },
    openInternalBrowserTab: async (url) => { await api()?.openInternalBrowserTab?.(url); },

    getRecentErrorLogs: async (limit) => api()?.getRecentErrorLogs?.(limit) ?? [],
    recordError: (payload) => api()?.recordError?.(payload),
    log: (level, message) => api()?.log?.(level, message),

    getWebviewSessionState: async () => api()?.getWebviewSessionState?.() ?? null,
    clearWebviewSession: async () => api()?.clearWebviewSession?.() ?? { success: false },
    getWebviewPreloadPath: async () => api()?.getWebviewPreloadPath?.() ?? null,

    checkForUpdates: async () => api()?.checkForUpdates?.() ?? { hasUpdate: false },

    listCloudQuestionBanks: async (source) => api()?.listCloudQuestionBanks?.(source) ?? { success: false },
    downloadCloudQuestionBank: async (payload) => api()?.downloadCloudQuestionBank?.(payload) ?? { success: false },
    uploadCloudQuestionBank: async (payload) => api()?.uploadCloudQuestionBank?.(payload) ?? { success: false },

    leaseWebAITask: async (payload) => api()?.leaseWebAITask?.(payload) ?? { ok: true, sessionId: 'mobile' },
    releaseWebAITask: async (sessionId) => { await api()?.releaseWebAITask?.(sessionId); },
    readQuestionMedia: async (payload) => api()?.readQuestionMedia?.(payload) ?? { ok: false, error: '移动端不支持读取题目图片。' },

    onPageNavigated: (cb) => api()?.onPageNavigated?.(cb) ?? (() => undefined),
    onOpenBrowserTab: (cb) => api()?.onOpenBrowserTab?.(cb) ?? (() => undefined),
    onStatusChanged: (cb) => api()?.onStatusChanged?.(cb) ?? (() => undefined),
  };
}
