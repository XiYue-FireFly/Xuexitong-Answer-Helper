/**
 * Platform-agnostic API surface.
 * Implemented by electronBridge (Windows) and capacitorBridge (Android).
 */
export interface PlatformAPI {
  isElectron: boolean;
  isAndroid: boolean;

  // Storage
  getSettings(): Promise<any>;
  setSettings(settings: any): Promise<void>;

  // AI chat
  aiChat(payload: {
    baseUrl: string;
    headers?: Record<string, string>;
    body?: Record<string, any>;
    stream?: boolean;
    requestId?: string;
    timeoutMs?: number;
  }): Promise<{ success: boolean; text?: string; statusCode?: number; error?: string; json?: boolean }>;
  onAIChatChunk(cb: (payload: { requestId: string; chunk: string }) => void): () => void;

  // Window / app
  minimize(): void;
  maximize(): void;
  close(): void;
  notify(title: string, body: string): Promise<void>;
  openExternalUrl(url: string): Promise<{ success: boolean; error?: string }>;
  openInternalBrowserTab(url: string): Promise<void>;

  // Diagnostics
  getRecentErrorLogs(limit?: number): Promise<any[]>;
  recordError(payload: any): void;
  log(level: string, message: string): void;

  // Webview session (Electron-specific, no-op on Android)
  getWebviewSessionState(): Promise<any>;
  clearWebviewSession(): Promise<{ success: boolean }>;
  getWebviewPreloadPath(): Promise<string | null>;

  // Updates (Electron-specific, no-op on Android)
  checkForUpdates(): Promise<any>;

  // Cloud question bank
  listCloudQuestionBanks(source: string): Promise<any>;
  downloadCloudQuestionBank(payload: any): Promise<any>;
  uploadCloudQuestionBank(payload: any): Promise<any>;

  // Web-AI task management (Electron-specific, no-op on Android)
  leaseWebAITask(payload: any): Promise<any>;
  releaseWebAITask(sessionId: string): Promise<void>;
  readQuestionMedia(payload: any): Promise<any>;

  // Event listeners
  onPageNavigated(cb: (url: string) => void): () => void;
  onOpenBrowserTab(cb: (payload: { url: string; title?: string }) => void): () => void;
  onStatusChanged(cb: (status: string) => void): () => void;
  onAndroidWebViewNav?(cb: (payload: { url: string; title: string }) => void): () => void;
}
