import type { WebProvider } from './protocol';
import type { WebMediaAttachment } from './questionMedia';

export type BrowserSource = { tabId: string; url: string };
export type WebCommand = { action: 'source' | 'open' | 'inspect' | 'prepare' | 'send' | 'focus'; provider?: WebProvider; tabId?: string; prompt?: string; deadline?: number; sessionId?: string; resourceSource?: BrowserSource; attachments?: WebMediaAttachment[]; isCancelled?: () => boolean };
export type WebPageState = {
  ready: boolean; busy: boolean; text: string; inputText?: string; inputEnabled?: boolean; attempted?: boolean;
  needsEnter?: boolean; reason?: string; error?: string;
  promptReady?: boolean; attachmentState?: 'pending' | 'ready' | 'failed';
  authState?: 'ready' | 'required' | 'unknown';
  generationState?: 'running' | 'finished' | 'unknown';
  messageKey?: string;
  sentReceipt?: boolean;
};
export const WEB_AI_BROWSER_EVENT = 'studypilot:web-ai-browser';
export function webActionScript(command: WebCommand, compare: (actual: string, expected: string) => boolean) {
  const files = (command.attachments || []).map(file => ({ name: file.name, mime: file.mime,
    bytes: command.action === 'prepare' ? file.bytes : [] }));
  return `(${webPageAction.toString()})(${JSON.stringify(command.action)}, ${JSON.stringify(command.provider)}, ${JSON.stringify(command.prompt || '')}, ${JSON.stringify(command.deadline || 0)}, (${compare.toString()}), ${JSON.stringify(files)})`;
}
export function browserCommand<T = BrowserSource & WebPageState>(command: WebCommand): Promise<T> {
  return new Promise((resolve, reject) => {
    const labels = { source: '读取标签', open: '打开网站', inspect: '检查输入与回答', prepare: '填入提示词', send: '点击发送', focus: '切换标签' };
    const deadline = Date.now() + 15000;
    let settled = false;
    const timer = window.setTimeout(() => { settled = true; reject(new Error(`浏览器操作超时（${labels[command.action]}），请检查页面后点击“重试”。`)); }, 15000);
    window.dispatchEvent(new CustomEvent(WEB_AI_BROWSER_EVENT, { detail: { ...command, deadline,
      isCancelled: () => settled || Boolean(command.isCancelled?.()), onComplete: (result: T & { error?: string }) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (result.error) reject(new Error(result.error)); else resolve(result);
    } } }));
  });
}

// Serialized into the selected WebView. Keep this function self-contained.
export function webPageAction(action: string, provider: string, prompt: string, deadline: number, matchesText: (actual: string, expected: string) => boolean, attachments: { name: string; mime: string; bytes: number[] }[] = []) {
  if (deadline && Date.now() >= deadline) return { error: '网页操作已超时，请检查页面后点击“重试”。' };
  const adapters: Record<string, { hosts: string[]; input: string; send: string; stop: string; answer: string }> = {
    deepseek: { hosts: ['chat.deepseek.com'], input: 'textarea#chat-input, textarea[placeholder]',
      send: 'button[aria-label="发送"], [role="button"][aria-label="发送"], button[aria-label="Send"], [role="button"][aria-label="Send"], [data-testid="send-button"]',
      stop: '[aria-label="停止生成"], [aria-label="Stop generating"], [data-testid="stop-button"]', answer: '.ds-markdown' },
    doubao: { hosts: ['www.doubao.com', 'doubao.com'], input: 'textarea[data-testid="chat_input_input"], textarea, [contenteditable="true"][role="textbox"]',
      send: '[data-testid="chat_input_send_button"], button[aria-label="发送"], button[aria-label="Send"]',
      stop: '[data-testid="chat_input_stop_button"], [aria-label="停止生成"]', answer: '[data-testid="receive_message"] [class*="markdown"], [data-testid="message_text_content"]' },
    qwen: { hosts: ['www.qianwen.com', 'qianwen.com', 'www.tongyi.com', 'tongyi.com', 'chat.qwen.ai'], input: '[contenteditable="true"][role="textbox"], .tiptap[contenteditable="true"], .ProseMirror[contenteditable="true"], [data-slate-editor="true"], [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], textarea',
      send: 'button[aria-label="发送"], button[aria-label="Send"], [data-testid="send-button"], button[type="submit"]',
      stop: '[aria-label="停止生成"], [aria-label="Stop generating"], [data-testid="stop-button"]', answer: '[data-message-author-role="assistant"], [class*="answerItem"] [class*="markdown"], .qwen-markdown' }
  };
  const adapter = adapters[provider];
  if (!adapter || !adapter.hosts.includes(location.hostname)) return { error: '当前标签不是所选 AI 网站，请返回对应聊天页。' };
  const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const first = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector)).find(visible);
  const input = (adapter.input.split(',').map(selector => first(selector.trim())).find(Boolean) || first('[contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""]')) as HTMLTextAreaElement | HTMLElement | undefined;
  const normalize = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[\u200B\uFEFF]/g, '');
  // Read editable text, excluding Slate placeholders while retaining actual drafts and mentions.
  const richText = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent || '';
    if (!(node instanceof HTMLElement)) return '';
    if (node.matches('[data-slate-placeholder="true"], [data-slate-zero-width]')) return '';
    if (node.tagName.toLowerCase() === 'br') return '\n';
    const text = Array.from(node.childNodes).map(richText).join('');
    return node !== input && /^(p|div|li)$/.test(node.tagName.toLowerCase()) && !text.endsWith('\n') ? `${text}\n` : text;
  };
  const inputText = () => normalize(input instanceof HTMLTextAreaElement ? input.value : input ? richText(input) : '');
  type Receipt = { prompt: string; files: string[] };
  const composerInput = input as (HTMLElement & { __studyPilotPrompt?: Receipt }) | undefined;
  const primarySelector = 'button.ds-button--primary.ds-button--circle, [role="button"].ds-button--primary.ds-button--circle';
  let composer: HTMLElement | null = null;
  let fallback: HTMLElement | null = null;
  for (let candidate = input?.parentElement, depth = 0; candidate && depth < 8; candidate = candidate.parentElement, depth++) {
    if (candidate.matches('body, html')) break;
    fallback ??= candidate;
    // Mobile attachment remove buttons can be beside the textarea, with the
    // actual send arrow in a sibling footer. Find their shared composer instead
    // of stopping at the first ancestor that happens to contain any button.
    if (candidate.matches('form') || candidate.querySelectorAll(adapter.send).length ||
      provider === 'deepseek' && candidate.querySelectorAll(primarySelector).length) {
      composer = candidate; break;
    }
  }
  composer ??= fallback;
  // DeepSeek's icon-only primary control is shared by send and stop. Keep
  // lookup within this composer so history, upload and sidebar controls cannot match.
  const primaryControls = provider === 'deepseek' ? Array.from(composer?.querySelectorAll<HTMLElement>(primarySelector) || []).filter(visible) : [];
  const iconControl = primaryControls.length === 1 ? primaryControls[0] : undefined;
  const stopIcon = iconControl && Array.from(iconControl.querySelectorAll('svg path, svg rect')).some(shape => {
    if (shape.tagName.toLowerCase() === 'rect') {
      const width = Number(shape.getAttribute('width'));
      return width > 0 && width === Number(shape.getAttribute('height'));
    }
    // Rounded-square path used by the current DeepSeek stop button.
    return /^M\s*2[ ,]+4\.88(?:[ ,]|C)/i.test((shape.getAttribute('d') || '').trim());
  });
  // Only inspect file chips next to the composer, never attachments in chat history.
  const files = () => {
    const rendered = (element: Element, boundary: Element) => {
      for (let current: Element | null = element; current && boundary.contains(current); current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
      }
      return true;
    };
    const renderedText = (node: Node, boundary: Element): string => {
      if (node.nodeType === 3) return node.textContent || '';
      if (!(node instanceof Element) || !rendered(node, boundary)) return '';
      return Array.from(node.childNodes).map(child => renderedText(child, boundary)).join(' ');
    };
    // The first upload can create DeepSeek's sibling shelf after this action starts.
    const shelfParent = composer?.parentElement;
    const scope = shelfParent && !shelfParent.matches('body, html') &&
      !shelfParent.querySelectorAll(adapter.answer + ', [data-message-id], [data-msg-id], [data-message-author-role], .ds-message').length &&
      shelfParent.querySelectorAll('img[alt], [data-file-name], [data-filename]').length ? shelfParent : composer;
    const found = new Map<string, 'pending' | 'ready' | 'failed'>();
    const nodes = scope?.querySelectorAll<HTMLElement>('[data-file-name], [data-filename], img[alt], [title], [aria-label], [class*="file"], [class*="File"], [class*="attachment"], [class*="Attachment"], span, a, p') || [];
    for (const node of Array.from(nodes)) {
      if (!visible(node) || input?.contains(node) || node.closest('[data-message-id], [data-msg-id], [data-message-author-role], [data-testid="receive_message"], [data-testid="send_message"]')) continue;
      const label = node.getAttribute('data-file-name') || node.getAttribute('data-filename') || node.getAttribute('alt') || node.getAttribute('title') || node.getAttribute('aria-label') || node.innerText;
      const name = label?.match(/(?:^|\n)([^\n\r<>]{1,180}\.(?:txt|png|jpe?g|webp|gif|bmp|avif|svg|ico))(?=$|\s)/i)?.[1].trim();
      if (!name) continue;
      const card = node.closest<HTMLElement>('[data-file-name], [data-filename], [data-status], [data-state], [data-upload-status], [aria-busy="true"], [class*="file"], [class*="File"], [class*="attachment"], [class*="Attachment"]') || (node.matches('img[alt]') ? node.closest<HTMLElement>('[role="button"]') : null) || node;
      const status = [card.getAttribute('data-status'), card.getAttribute('data-state'), card.getAttribute('data-upload-status'), renderedText(card, card)].join(' ');
      const failed = /failed|error|上传失败|解析失败|重试/i.test(status);
      const pending = /pending|uploading|loading|processing|parsing|上传中|正在上传|解析中|处理中/i.test(status) || card.matches('[aria-busy="true"]') ||
        Array.from(card.querySelectorAll('[role="progressbar"], [aria-busy="true"], [class*="loading"], [class*="Loading"]')).some(indicator => rendered(indicator, card) && visible(indicator));
      const next = failed ? 'failed' : pending ? 'pending' : 'ready';
      const old = found.get(name);
      found.set(name, old === 'failed' || next === 'failed' ? 'failed' : old === 'pending' || next === 'pending' ? 'pending' : 'ready');
    }
    return Array.from(found, ([name, status]) => ({ name, status }));
  };
  const attachmentMatches = (expected: string) => {
    const receipt = composerInput?.__studyPilotPrompt;
    const current = files();
    const images = attachments.map(file => file.name);
    const textFiles = current.filter(file => !images.includes(file.name));
    return Boolean(receipt && receipt.prompt === expected && current.length && current.length === receipt.files.length &&
      current.every(file => receipt.files.includes(file.name)) && images.every(name => current.some(file => file.name === name)) &&
      textFiles.length <= 1 && textFiles.every(file => /\.txt$/i.test(file.name)) &&
      (textFiles.length ? !inputText().trim() : matchesText(inputText(), expected)));
  };
  const attachmentState = () => {
    const current = files();
    return current.length ? current.some(file => file.status === 'failed') ? 'failed' : current.some(file => file.status === 'pending') ? 'pending' : 'ready' : undefined;
  };
  const matchesPrompt = () => files().length ? attachmentMatches(prompt) : matchesText(inputText(), prompt);
  const texts = Array.from(document.querySelectorAll<HTMLElement>(adapter.answer)).filter(visible).map(element => element.innerText).filter(Boolean);
  const busy = Boolean(first(adapter.stop) || stopIcon);
  // The instructions include an example requestId before the actual batch.
  const requestId = Array.from(prompt.matchAll(/"requestId"\s*:\s*"([^"\n]+)"/g)).pop()?.[1];
  const receipt = composerInput?.__studyPilotPrompt;
  // Sending may remount the textarea, losing its ephemeral preparation receipt.
  // The bound request ID plus every expected outgoing filename remains evidence.
  const expectedFiles = receipt?.prompt === prompt ? receipt.files : attachments.map(file => file.name);
  const sentReceipt = Boolean(requestId && Array.from(document.querySelectorAll<HTMLElement>(
    '[data-message-author-role="user"], [data-testid="send_message"], [data-role="user"], [class*="user-message"], [class*="userMessage"], .ds-message'
  )).some(message => {
    if (!visible(message) || composer?.contains(message)) return false;
    const text = [message.innerText, ...Array.from(message.querySelectorAll<HTMLElement>('img[alt], [title], [aria-label], [data-file-name], [data-filename]')).map(node =>
      node.getAttribute('alt') || node.getAttribute('title') || node.getAttribute('aria-label') || node.getAttribute('data-file-name') || node.getAttribute('data-filename') || '')].join('\n');
    const txt = expectedFiles.filter(name => /\.txt$/i.test(name));
    return (text.includes(requestId) || txt.some(name => text.includes(name))) && expectedFiles.every(name => text.includes(name)) && attachments.every(file => text.includes(file.name));
  }));
  const state = { ready: Boolean(input), busy, text: texts[texts.length - 1] || '', inputText: input ? inputText() : undefined,
    sentReceipt,
    attachmentState: attachmentState(), promptReady: Boolean(composerInput?.__studyPilotPrompt &&
      (attachmentMatches(prompt || composerInput.__studyPilotPrompt.prompt) || (!files().length && matchesText(inputText(), prompt || composerInput.__studyPilotPrompt.prompt)))) };
  if (action === 'inspect') {
    const inputEnabled = input && !input.matches(':disabled, [readonly], [aria-readonly="true"], [aria-disabled="true"], [contenteditable="false"]') && !input.closest('[inert], [aria-disabled="true"]');
    const messages = Array.from(document.querySelectorAll<HTMLElement>(adapter.answer)).filter(visible).filter(element => Boolean(element.innerText));
    const last = messages[messages.length - 1];
    const message = last?.closest<HTMLElement>('[data-message-id], [data-msg-id], [data-message-author-role="assistant"], [data-testid="receive_message"], [class*="answerItem"]') || last;
    const messageKey = message?.getAttribute('data-message-id') || message?.getAttribute('data-msg-id') || `${provider}:assistant:${messages.length - 1}`;
    const finished = Boolean(message?.matches('[data-is-streaming="false"], [data-streaming="false"], [data-message-status="completed"], [data-status="complete"]'));
    const running = busy || Boolean(message?.matches('[data-is-streaming="true"], [data-streaming="true"]'));
    return { ...state, inputEnabled: Boolean(inputEnabled), messageKey, generationState: running ? 'running' : finished ? 'finished' : 'unknown' };
  }
  if (action === 'send' && (!input || busy)) return { ...state, attempted: false, reason: '等待聊天页就绪。' };
  if (!input || busy) return { error: busy ? 'AI 正在生成，请等待当前回答结束。' : '未找到输入框，请检查聊天页面后点击“重试”。' };
  if (action === 'prepare') return (async () => {
    const existingFiles = files();
    const expectedNames = attachments.map(file => file.name);
    const matchingImages = existingFiles.every(file => expectedNames.includes(file.name));
    if (existingFiles.length && !attachmentMatches(prompt) && !matchingImages) {
      return { error: '输入区已有其他附件，请先处理附件后点击“重试”。' };
    }
    if (inputText().trim() && !matchesText(inputText(), prompt) && !matchesPrompt()) return { error: '输入框已有草稿，请先处理草稿再继续。' };
    const prepared = () => attachmentState() === 'failed' ? { error: 'TXT 附件上传失败，请在网页重试上传后点击“重试”。' } :
      { ...state, inputText: inputText(), promptReady: true, attachmentState: attachmentState() };
    if (matchesPrompt()) return prepared();
    if (attachments.length) {
      const missing = attachments.filter(file => !existingFiles.some(current => current.name === file.name));
      if (missing.length) {
        if (typeof DataTransfer === 'undefined' || typeof File === 'undefined') return { error: '当前 AI 页面不支持图片附件上传。' };
        const transfer = new DataTransfer();
        for (const file of missing) transfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.mime }));
        const upload = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).find(element => {
          const accept = element.accept || '';
          return (!accept || /image|png|jpe?g|\*/i.test(accept)) && !element.disabled;
        });
        if (upload) {
          upload.files = transfer.files;
          upload.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (typeof ClipboardEvent !== 'undefined') input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
        else return { error: '未找到图片上传入口，请在 AI 网页上传图片后重试。' };
        // A synthetic upload is only an attempt. Require each named chip from
        // the site before allowing this prompt to be sent.
        for (let attempt = 0; ; attempt++) {
          const current = files();
          if (expectedNames.every(name => current.some(file => file.name === name))) break;
          if (attempt >= 80 || deadline && Date.now() >= deadline) return { error: 'AI 网页未确认全部图片附件，已保留题目，请检查上传入口后重试。' };
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      composerInput!.__studyPilotPrompt = { prompt, files: files().map(file => file.name) };
    }
    const alreadyText = matchesText(inputText(), prompt);
    if (!alreadyText) {
    input.focus();
    if (input instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, prompt);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const selection = window.getSelection();
      const range = document.createRange(); range.selectNodeContents(input);
      selection?.removeAllRanges(); selection?.addRange(range);
      let consumed = false;
      if (typeof DataTransfer !== 'undefined' && typeof ClipboardEvent !== 'undefined') {
        const data = new DataTransfer(); data.setData('text/plain', prompt);
        const paste = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
        input.dispatchEvent(paste);
        consumed = paste.defaultPrevented;
      }
      // One complete paste may become a TXT. Do not append or type it incrementally.
      if (!consumed && !inputText().trim() && !files().some(file => /\.txt$/i.test(file.name))) {
        input.focus(); range.selectNodeContents(input);
        selection?.removeAllRanges(); selection?.addRange(range);
        if (!document.execCommand('insertText', false, prompt)) return { error: '当前网站输入框不兼容，请改用复制提示词。' };
      }
    }
    }
    // Editors may commit native input after the DOM event has returned.
    for (let attempt = 0; attempt <= 40; attempt++) {
      const converted = files();
      if (converted.some(file => !expectedNames.includes(file.name) && !/\.txt$/i.test(file.name)) || converted.filter(file => /\.txt$/i.test(file.name)).length > 1) return { error: '输入区出现非本批附件，请核对后重试。' };
      if (converted.length && expectedNames.every(name => converted.some(file => file.name === name))) composerInput!.__studyPilotPrompt = { prompt, files: converted.map(file => file.name) };
      if (matchesPrompt()) {
        composerInput!.__studyPilotPrompt = { prompt, files: converted.map(file => file.name) };
        return prepared();
      }
      if (attempt === 40) break;
      await new Promise(resolve => setTimeout(resolve, 50));
      if (deadline && Date.now() >= deadline) return { error: '填入提示词已超时，请检查页面后点击“重试”。' };
    }
    return { error: `提示词未完整填入（已识别 ${inputText().trim().length}/${normalize(prompt).trim().length} 字符），请检查网页后点击“重试”。` };
  })();
  if (action === 'send') {
    if (!matchesPrompt()) return { ...state, attempted: false, reason: '输入框内容已变化，请检查后手动发送。' };
    if (state.attachmentState === 'failed') return { ...state, attempted: false, reason: '附件上传失败，请在网页重试上传。' };
    if (state.attachmentState === 'pending') return { ...state, attempted: false, reason: '正在等待附件上传完成。' };
    const candidates = Array.from(composer?.querySelectorAll<HTMLElement>(adapter.send) || []).filter(visible);
    if (!candidates.length && iconControl && !stopIcon) candidates.push(iconControl);
    const disabled = (element: HTMLElement) => element.matches(':disabled, [aria-disabled="true"], [data-disabled="true"], .ds-button--disabled') ||
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
