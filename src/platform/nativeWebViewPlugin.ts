/**
 * Thin shim so the rest of the code can `import { NativeWebView } from './nativeWebViewPlugin'`
 * without knowing which platform it runs on.  The actual Kotlin plugin is registered by Capacitor
 * and called through `(window as any).Capacitor.Plugins.NativeWebView`.
 */

import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type NativeBrowserState = {
  tabId: string; activeTabId: string; url: string; title: string;
  canGoBack: boolean; canGoForward: boolean; loading: boolean;
};
const plugin = registerPlugin<any>('NativeWebView');
function getPlugin() { return plugin; }

export const NativeWebView = {
  /** Load a URL in the full-screen native WebView. */
  loadUrl: (url: string): Promise<void> =>
    getPlugin()?.loadUrl({ url }) ?? Promise.resolve(),

  /** Execute JavaScript inside the native WebView and return the result. */
  executeScript(code: string, tabId?: string): Promise<{ result: any }> {
    return getPlugin().executeScript({ code, tabId });
  },

  /** Show or hide the native WebView overlay. */
  setVisible(visible: boolean): Promise<void> {
    return getPlugin()?.setVisible({ visible }) ?? Promise.resolve();
  },

  /** Clear all cookies / storage for the WebView session. */
  clearSession(): Promise<void> {
    return getPlugin()?.clearSession() ?? Promise.resolve();
  },

  /** Navigate back in the WebView history. */
  goBack(): Promise<void> {
    return getPlugin()?.goBack() ?? Promise.resolve();
  },

  /** Navigate forward in the WebView history. */
  goForward(): Promise<void> {
    return getPlugin()?.goForward() ?? Promise.resolve();
  },

  /** Reload the current page. */
  reload(): Promise<void> {
    return getPlugin()?.reload() ?? Promise.resolve();
  },

  /** Ask the native layer for current URL and title. */
  getState(tabId?: string): Promise<NativeBrowserState> {
    return getPlugin().getState({ tabId });
  },

  createTab(url: string): Promise<NativeBrowserState> { return getPlugin().createTab({ url }); },
  focusTab(tabId: string): Promise<NativeBrowserState> { return getPlugin().focusTab({ tabId }); },
  listTabs(): Promise<{ tabs: NativeBrowserState[]; activeTabId: string }> { return getPlugin().listTabs(); },
  closeTab(tabId: string): Promise<void> { return getPlugin().closeTab({ tabId }); },
  sendEnter(tabId: string): Promise<void> { return getPlugin().sendEnter({ tabId }); },
  onNavigationChanged(callback: (state: NativeBrowserState) => void): Promise<PluginListenerHandle> {
    return getPlugin().addListener('navigationChanged', callback);
  },
  setLayout(layout: { headerHeight: number; tabHeight: number; panelTop: number; modalOpen: boolean }): Promise<void> {
    return getPlugin().setLayout(layout);
  },
  captureBackdrop(): Promise<{ dataUrl: string }> { return getPlugin().captureBackdrop(); },

  /** Lease a web-AI task session for image reading. */
  leaseWebAITask(payload: { sessionId: string; sourceUrl: string; sourceTabId?: string }): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
    return getPlugin()?.leaseWebAITask?.(payload) ?? Promise.resolve({ ok: true, sessionId: payload.sessionId });
  },

  /** Release a leased web-AI task session. */
  releaseWebAITask(payload: { sessionId: string }): Promise<void> {
    return getPlugin()?.releaseWebAITask?.(payload) ?? Promise.resolve();
  },

  /** Read image bytes from the question page for 含图题 support. */
  readQuestionMedia(payload: {
    sessionId: string;
    questionHash: string;
    mediaId: string;
    selector: string;
    sourceUrl?: string;
  }): Promise<{ ok: boolean; bytes?: number[]; mime?: string; digest?: string; error?: string }> {
    return getPlugin()?.readQuestionMedia?.(payload) ?? Promise.resolve({ ok: false, error: '原生图片插件不可用。' });
  },

  /** Inject the bundled content-bridge script into the study page WebView. */
  injectBridge(tabId?: string): Promise<void> {
    return getPlugin().injectBridge({ tabId });
  },

  /** Dispatch a CustomEvent inside the study page and wait for its result event. */
  dispatchBridgeEvent(payload: {
    event: string;
    detail?: Record<string, unknown>;
    resultChannel: string;
    tabId?: string;
  }): Promise<Record<string, any>> {
    return getPlugin()?.dispatchBridgeEvent?.({
      event: payload.event,
      detail: JSON.stringify(payload.detail ?? {}),
      resultChannel: payload.resultChannel,
      tabId: payload.tabId,
    }) ?? Promise.resolve({ success: false, error: '原生桥接不可用。' });
  },

  /** Get full diagnostics report from the native plugin (layout, WebView state, logs). */
  getDiagnostics(): Promise<{ report: string }> {
    return getPlugin()?.getDiagnostics?.() ?? Promise.resolve({ report: 'Plugin not available' });
  },

  /** Resize the browser/panel split. 1.0 = browser full screen, 0.55 = 55% browser. */
  resizeSplit(browserPercent: number): Promise<void> {
    return getPlugin()?.resizeSplit?.({ browserPercent }) ?? Promise.resolve();
  },
};
