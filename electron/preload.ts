import { contextBridge, ipcRenderer } from 'electron';

function serializeError(error: any) {
  if (!error) return { message: 'Unknown error' };
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
      name: error.name
    };
  }
  if (typeof error === 'object') {
    return {
      message: String(error.message || error.reason || error.error || JSON.stringify(error)),
      stack: error.stack ? String(error.stack) : undefined,
      name: error.name ? String(error.name) : undefined
    };
  }
  return { message: String(error) };
}

function reportRendererError(source: string, payload: any) {
  ipcRenderer.send('diagnostics:error-log', {
    source,
    level: 'error',
    ...payload,
    url: window.location.href
  });
}

window.addEventListener('error', (event) => {
  const error = serializeError(event.error || event.message);
  reportRendererError('renderer:window-error', {
    message: error.message,
    stack: error.stack,
    line: event.lineno,
    column: event.colno,
    details: {
      filename: event.filename,
      name: error.name
    }
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const error = serializeError(event.reason);
  reportRendererError('renderer:unhandledrejection', {
    message: error.message,
    stack: error.stack,
    details: {
      name: error.name
    }
  });
});

// Expose IPC APIs safely to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  
  // Navigation & Page Operations
  navigate: (url: string) => ipcRenderer.invoke('browser:navigate', url),
  screenshot: (rect?: { x: number; y: number; width: number; height: number }) => 
    ipcRenderer.invoke('browser:screenshot', rect),
  
  // Automation operations
  captureAutomationSnapshot: () => ipcRenderer.invoke('automation:snapshot'),
  executeAutomationPlan: (payload: any) => ipcRenderer.invoke('automation:execute-plan', payload),
  
  // Database / Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings: any) => ipcRenderer.invoke('settings:set', settings),
  getWebviewPreloadPath: () => ipcRenderer.invoke('settings:get-webview-preload'),
  getErrorLogPath: () => ipcRenderer.invoke('diagnostics:get-error-log-path'),
  clearWebviewSession: () => ipcRenderer.invoke('session:clear-webview-login'),
  
  // System logging
  log: (level: string, message: string) => ipcRenderer.send('system:log', { level, message }),
  recordError: (payload: any) => ipcRenderer.send('diagnostics:error-log', payload),
  
  // Listener events
  onPageNavigated: (callback: (url: string) => void) => {
    const subscription = (_event: any, url: string) => callback(url);
    ipcRenderer.on('browser:navigated', subscription);
    return () => ipcRenderer.removeListener('browser:navigated', subscription);
  },

  onOpenBrowserTab: (callback: (payload: { url: string; title?: string }) => void) => {
    const subscription = (_event: any, payload: { url: string; title?: string }) => callback(payload);
    ipcRenderer.on('browser:open-tab', subscription);
    return () => ipcRenderer.removeListener('browser:open-tab', subscription);
  },
  
  onStatusChanged: (callback: (status: string) => void) => {
    const subscription = (_event: any, status: string) => callback(status);
    ipcRenderer.on('system:status', subscription);
    return () => ipcRenderer.removeListener('system:status', subscription);
  }
});
