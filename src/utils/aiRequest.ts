// AI 请求通道：优先走主进程代理（打包后 file:// 页面直接 fetch 会被 CORS 拦截），
// 非 Electron 环境回退到渲染进程 fetch。

export interface AIChatProxyResult {
  ok: boolean;
  status: number;
  /** 非流式响应的完整文本（流式为 undefined） */
  text?: string;
  /** 流式：已解析的 SSE data 载荷文本列表由 onChunk 回调给出 */
  error?: string;
}

interface AIChatRequestOptions {
  baseUrl: string;
  headers: Record<string, string>;
  body: Record<string, any>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function electronAI() {
  return typeof window !== 'undefined' ? (window as any).electronAPI : null;
}

/** 非流式 chat/completions 请求，返回响应文本。 */
export async function aiChatText(options: AIChatRequestOptions): Promise<AIChatProxyResult> {
  const api = electronAI();
  if (api?.aiChat) {
    const result = await api.aiChat({
      baseUrl: options.baseUrl,
      headers: options.headers,
      body: options.body,
      stream: false,
      timeoutMs: options.timeoutMs ?? 30000
    });
    if (!result?.success) {
      return { ok: false, status: Number(result?.statusCode) || 0, error: result?.error || 'AI 请求失败。' };
    }
    return { ok: true, status: Number(result.statusCode) || 200, text: result.text || '' };
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);
  const abortFromSignal = () => controller.abort();
  options.signal?.addEventListener('abort', abortFromSignal);
  try {
    const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: options.headers,
      body: JSON.stringify(options.body),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, status: response.status, error: `接口返回 ${response.status}：${text.slice(0, 800)}` };
    return { ok: true, status: response.status, text };
  } finally {
    window.clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', abortFromSignal);
  }
}

interface AIChatStreamOptions extends AIChatRequestOptions {
  /** 每收到一段原始 SSE 文本回调一次 */
  onChunk: (text: string) => void;
  /** 服务商标致 JSON 而非 SSE 时回调完整响应文本（调用方按非流式解析） */
  onJsonResponse?: (text: string) => void;
}

/** 流式 chat/completions 请求；主进程通道不可用时回退到 fetch 流式读取。 */
export async function aiChatStream(options: AIChatStreamOptions): Promise<AIChatProxyResult> {
  const api = electronAI();
  if (api?.aiChat && api?.onAIChatChunk) {
    const requestId = `ai_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    // eslint 偏好 const，但这里需要在 Promise 执行器闭包内赋值，TS 控制流分析不应将其窄化为 null
    let unsubscribe = null as null | (() => void);
    const abortFromSignal = () => {
      unsubscribe?.();
    };
    try {
      await new Promise<void>((resolve, reject) => {
        unsubscribe = api.onAIChatChunk((payload: { requestId: string; chunk: string }) => {
          if (payload?.requestId === requestId) options.onChunk(String(payload.chunk || ''));
        });
        api.aiChat({
          baseUrl: options.baseUrl,
          headers: options.headers,
          body: options.body,
          stream: true,
          requestId,
          timeoutMs: options.timeoutMs ?? 60000
        }).then((result: any) => {
          if (!result?.success) {
            reject(new Error(result?.error || 'AI 请求失败。'));
            return;
          }
          // 服务商标致 JSON 而非 SSE 时整体返回文本，交给调用方按非流式解析
          if (result.json) {
            options.onJsonResponse?.(String(result.text || ''));
          }
          resolve();
        }).catch(reject);
      });
      return { ok: true, status: 200 };
    } catch (error: any) {
      return { ok: false, status: 0, error: error?.message || 'AI 请求失败。' };
    } finally {
      unsubscribe?.();
      options.signal?.removeEventListener('abort', abortFromSignal);
    }
  }

  // 浏览器/dev 环境：直接使用 fetch 流式读取
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 60000);
  const abortFromSignal = () => controller.abort();
  options.signal?.addEventListener('abort', abortFromSignal);
  try {
    const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: options.headers,
      body: JSON.stringify(options.body),
      signal: controller.signal
    });
    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, status: response.status, error: `接口返回 ${response.status}：${errorText.slice(0, 500)}` };
    }
    const contentType = response.headers.get('content-type') || '';
    if (response.body && !contentType.includes('application/json')) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        options.onChunk(decoder.decode(value, { stream: true }));
      }
    } else {
      options.onJsonResponse?.(await response.text());
    }
    return { ok: true, status: response.status };
  } finally {
    window.clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', abortFromSignal);
  }
}
