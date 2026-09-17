import type { WebProvider } from './protocol';

export type BrowserSource = { tabId: string; url: string };
export type WebCommand = { action: 'source' | 'open' | 'inspect' | 'prepare' | 'send' | 'focus'; provider?: WebProvider; tabId?: string; prompt?: string; isCancelled?: () => boolean };
export type WebPageState = { ready: boolean; busy: boolean; text: string; inputText?: string; attempted?: boolean; needsEnter?: boolean; reason?: string; error?: string };
export const WEB_AI_BROWSER_EVENT = 'studypilot:web-ai-browser';
export function browserCommand<T = BrowserSource & WebPageState>(command: WebCommand): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('浏览器操作超时，请检查页面是否已加载。')), 15000);
    window.dispatchEvent(new CustomEvent(WEB_AI_BROWSER_EVENT, { detail: { ...command, onComplete: (result: T & { error?: string }) => {
      window.clearTimeout(timer);
      if (result.error) reject(new Error(result.error)); else resolve(result);
    } } }));
  });
}

// Serialized into the selected WebView. Keep this function self-contained.
export function webPageAction(action: string, provider: string, prompt: string) {
  const adapters: Record<string, { hosts: string[]; input: string; send: string; stop: string; answer: string }> = {
    deepseek: { hosts: ['chat.deepseek.com'], input: 'textarea#chat-input, textarea[placeholder]',
      send: 'button[aria-label="发送"], [role="button"][aria-label="发送"], button[aria-label="Send"], [role="button"][aria-label="Send"], [data-testid="send-button"]',
      stop: '[aria-label="停止生成"], [aria-label="Stop generating"], [data-testid="stop-button"]', answer: '.ds-markdown' },
    doubao: { hosts: ['www.doubao.com', 'doubao.com'], input: 'textarea[data-testid="chat_input_input"], textarea, [contenteditable="true"][role="textbox"]',
      send: '[data-testid="chat_input_send_button"], button[aria-label="发送"], button[aria-label="Send"]',
      stop: '[data-testid="chat_input_stop_button"], [aria-label="停止生成"]', answer: '[data-testid="receive_message"] [class*="markdown"], [data-testid="message_text_content"]' },
    qwen: { hosts: ['www.qianwen.com', 'qianwen.com', 'www.tongyi.com', 'tongyi.com', 'chat.qwen.ai'], input: 'textarea, [contenteditable="true"][role="textbox"]',
      send: 'button[aria-label="发送"], button[aria-label="Send"], [data-testid="send-button"], button[type="submit"]',
      stop: '[aria-label="停止生成"], [aria-label="Stop generating"], [data-testid="stop-button"]', answer: '[data-message-author-role="assistant"], [class*="answerItem"] [class*="markdown"], .qwen-markdown' }
  };
  const adapter = adapters[provider];
  if (!adapter || !adapter.hosts.includes(location.hostname)) return { error: '当前标签不是所选 AI 网站，请返回对应聊天页。' };
  const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const first = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector)).find(visible);
  const input = first(adapter.input) as HTMLTextAreaElement | HTMLElement | undefined;
  const inputText = () => input instanceof HTMLTextAreaElement ? input.value : input?.innerText || '';
  const texts = Array.from(document.querySelectorAll<HTMLElement>(adapter.answer)).filter(visible).map(element => element.innerText).filter(Boolean);
  const busy = Boolean(first(adapter.stop));
  const state = { ready: Boolean(input), busy, text: texts[texts.length - 1] || '', inputText: input ? inputText() : undefined };
  if (action === 'inspect') return state;
  if (action === 'send' && (!input || busy)) return { ...state, attempted: false, reason: '等待聊天页就绪。' };
  if (!input || busy) return { error: busy ? 'AI 正在生成，请等待当前回答结束。' : '未找到输入框，请先登录并进入聊天页。' };
  if (action === 'prepare') {
    if (inputText().trim() && inputText() !== prompt) return { error: '输入框已有草稿，请先处理草稿再继续。' };
    input.focus();
    if (input instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, prompt);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const selection = window.getSelection();
      const range = document.createRange(); range.selectNodeContents(input);
      selection?.removeAllRanges(); selection?.addRange(range);
      if (!document.execCommand('insertText', false, prompt)) return { error: '当前网站输入框不兼容，请改用复制提示词。' };
    }
    return { ready: true, busy: false, text: texts[texts.length - 1] || '' };
  }
  if (action === 'send') {
    if (inputText().trim() !== prompt.trim()) return { ...state, attempted: false, reason: '输入框内容已变化，请检查后手动发送。' };
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(adapter.send)).filter(visible);
    const disabled = (element: HTMLElement) => element.matches(':disabled, [aria-disabled="true"], [data-disabled="true"]') ||
      Boolean(element.closest('[aria-disabled="true"], [inert]')) || getComputedStyle(element).pointerEvents === 'none';
    const send = candidates.find(element => !disabled(element));
    if (!send && candidates.length) return { ...state, attempted: false, reason: '正在等待发送按钮启用。' };
    // Some sites expose only an unlabelled icon. The host can send a real Enter key
    // to this focused composer; the workflow still checks for an actual response.
    if (!send) { input.focus(); return { ...state, needsEnter: true, attempted: false }; }
    send.click();
    return { ...state, attempted: true };
  }
  return { error: '不支持的网页操作。' };
}
