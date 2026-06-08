import { ipcRenderer } from 'electron';

export function serializeBridgeError(error: any) {
  if (!error) return { message: 'Unknown WebView error' };
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

export function reportWebviewError(source: string, payload: any) {
  try {
    const nextPayload = payload || {};
    ipcRenderer.sendToHost('studypilot:error-log', {
      source,
      level: 'error',
      ...nextPayload,
      url: nextPayload.url || window.location.href,
      title: document.title
    });
  } catch {
    // Avoid throwing while reporting an error.
  }
}

export function installBridgeErrorHandlers() {
  window.addEventListener('error', (event) => {
    const error = serializeBridgeError(event.error || event.message);
    reportWebviewError('webview:window-error', {
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
    const error = serializeBridgeError(event.reason);
    reportWebviewError('webview:unhandledrejection', {
      message: error.message,
      stack: error.stack,
      details: {
        name: error.name
      }
    });
  });
}
