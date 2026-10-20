import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserCommand, WEB_AI_BROWSER_EVENT, webPageAction, type WebCommand, type WebPageState } from '../src/webAI/browserBridge';
import { composerTextMatches } from '../src/webAI/composerText';

// Minimal DOM fixtures for the read-only inspector, including its serialized form.
class ElementFixture {
  children: ElementFixture[] = [];
  parentElement: ElementFixture | null = null;
  focused = false;
  clicks = 0;
  events: string[] = [];
  constructor(public tagName: string, public attributes: Record<string, string> = {}, public text = '') {}
  readonly nodeType = 1;
  get textContent(): string { return [this.text, ...this.children.map(child => child.textContent)].join(''); }
  get childNodes(): any[] { return [...(this.text ? [{ nodeType: 3, textContent: this.text }] : []), ...this.children]; }
  get innerText(): string { return [this.text, ...this.children.map(child => child.innerText)].join(''); }
  get className() { return this.attributes.class || ''; }
  focus() { this.focused = true; }
  click() { this.clicks++; }
  dispatchEvent(event: Event) { this.events.push(event.type); return true; }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  getClientRects() { return this.closest('[hidden]') ? [] : [{}]; }
  append(...children: ElementFixture[]) { children.forEach(child => { child.parentElement = this; this.children.push(child); }); return this; }
  matches(selectors: string): boolean {
    return selectors.split(',').some(selector => {
      const parts = selector.trim().split(/\s+(?![^\[]*\])/);
      const match = (node: ElementFixture, part: string) => {
        let valid = true;
        let rest = part.replace(/\[([^\s=*\]]+)\s*(\*?=)?\s*(?:"([^"]*)"|'([^']*)')?\s*\]/g, (_, name, operator, double, single) => {
          const actual = node.getAttribute(name); const expected = double ?? single ?? '';
          valid &&= operator === '*=' ? actual?.includes(expected) === true : operator === '=' ? actual === expected : actual !== null;
          return '';
        });
        rest = rest.replace(/:disabled/g, () => { valid &&= node.getAttribute('disabled') !== null; return ''; });
        rest = rest.replace(/#([\w-]+)/g, (_, id) => { valid &&= node.getAttribute('id') === id; return ''; });
        rest = rest.replace(/\.([\w-]+)/g, (_, name) => { valid &&= node.className.split(/\s+/).includes(name); return ''; });
        return valid && (!rest || rest === '*' || node.tagName === rest);
      };
      if (!match(this, parts.pop()!)) return false;
      let ancestor = this.parentElement;
      while (parts.length) {
        const part = parts.pop()!;
        while (ancestor && !match(ancestor, part)) ancestor = ancestor.parentElement;
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    });
  }
  closest(selectors: string): ElementFixture | null {
    for (let node: ElementFixture | null = this; node; node = node.parentElement) if (node.matches(selectors)) return node;
    return null;
  }
  contains(node: ElementFixture): boolean { return node === this || this.children.some(child => child.contains(node)); }
  querySelectorAll(selector: string): ElementFixture[] {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
}
class TextareaFixture extends ElementFixture {
  private content = '';
  get value() { return this.content; }
  set value(value: string) { this.content = value; }
}
const element = (tag: string, attributes: Record<string, string> = {}, text = '') => new ElementFixture(tag, attributes, text);
const providers = [
  { id: 'deepseek', hostname: 'chat.deepseek.com', path: '/', input: { id: 'chat-input' }, send: { 'aria-label': '发送' } },
  { id: 'doubao', hostname: 'www.doubao.com', path: '/chat/', input: { 'data-testid': 'chat_input_input' }, send: { 'data-testid': 'chat_input_send_button' } },
  { id: 'qwen', hostname: 'www.qianwen.com', path: '/', input: { placeholder: '提问' }, send: { type: 'submit' } }
];
function fixture(provider = providers[0], options: { send?: boolean; account?: boolean; disabled?: boolean; path?: string; editor?: Record<string, string>; paste?: boolean; pasteText?: string; pasteAttachment?: 'ready' | 'pending' | 'failed'; insertText?: string; insertAsync?: 'microtask' | 'timer' } = {}) {
  const input = options.editor ? element('div', options.editor) : new TextareaFixture('textarea', { placeholder: '发送消息', ...provider.input, ...(options.disabled ? { disabled: '' } : {}) });
  const form = element('form').append(input);
  if (options.send !== false) form.append(element('button', provider.send));
  const root = element('body').append(form);
  if (options.account) root.append(element('div', { 'data-testid': 'user-avatar' }));
  vi.stubGlobal('location', { hostname: provider.hostname, pathname: options.path ?? provider.path });
  let insertions = 0;
  if (options.paste) input.dispatchEvent = (event: Event) => {
    input.events.push(event.type);
    if (event.type === 'paste') {
      const text = options.pasteText ?? (event as ClipboardEvent).clipboardData!.getData('text/plain');
      if (options.pasteAttachment) form.append(element('div', { 'data-file-name': 'pasted.txt', 'data-status': options.pasteAttachment }, 'pasted.txt'));
      else input.text = text;
      event.preventDefault();
    }
    return !event.defaultPrevented;
  };
  vi.stubGlobal('DataTransfer', class {
    private text = '';
    setData(_type: string, value: string) { this.text = value; }
    getData() { return this.text; }
  });
  vi.stubGlobal('ClipboardEvent', class extends Event {
    clipboardData: DataTransfer | null;
    constructor(type: string, init: ClipboardEventInit) { super(type, init); this.clipboardData = init.clipboardData || null; }
  });
  let replaceSelection = false;
  vi.stubGlobal('document', { readyState: 'complete', querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    createRange: () => ({ selectNodeContents: () => { replaceSelection = true; } }),
    execCommand: (_command: string, _showUI: boolean, text: string) => {
      insertions++;
      const replace = replaceSelection; replaceSelection = false;
      const commit = () => { input.text = (replace ? '' : input.text) + (options.insertText ?? text); input.children = []; };
      if (options.insertAsync === 'microtask') queueMicrotask(commit);
      else if (options.insertAsync === 'timer') setTimeout(commit, 50);
      else commit();
      return true;
    }
  });
  vi.stubGlobal('window', { getSelection: () => ({ removeAllRanges: () => undefined, addRange: () => undefined }) });
  vi.stubGlobal('HTMLTextAreaElement', TextareaFixture);
  vi.stubGlobal('HTMLElement', ElementFixture);
  vi.stubGlobal('Element', ElementFixture);
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible', opacity: '1' }));
  const run = new Function(`return (${webPageAction.toString()})`)() as typeof webPageAction;
  const compare = new Function(`return (${composerTextMatches.toString()})`)() as typeof composerTextMatches;
  const inspect = (action: string, name: string, prompt: string, deadline = 0, attachments: any[] = []) => run(action, name, prompt, deadline, compare, attachments);
  return { root, form, input, insertions: () => insertions, inspect: () => inspect('inspect', provider.id, '') as WebPageState,
    prepare: async (prompt: string) => await inspect('prepare', provider.id, prompt) as WebPageState,
    expired: (action: string) => (inspect as Function)(action, provider.id, 'prompt', Date.now() - 1) as WebPageState,
    action: (action: string, prompt: string) => inspect(action, provider.id, prompt) as WebPageState,
    mediaAction: (action: string, prompt: string, attachments: any[]) => inspect(action, provider.id, prompt, 0, attachments) };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Web AI composer readiness without login checks', () => {
  it('confirms current outgoing images after the site remounts its textarea without accepting an older request', async () => {
    const page = fixture();
    const prompt = 'Return JSON such as {"requestId":"example"}.\n{"requestId":"current","questions":[]}';
    const files = [{ name: 'diagram.png', mime: 'image/png', bytes: [1] }];
    page.root.append(element('div', { class: 'ds-message' }, '{"requestId":"old","questions":[]}')
      .append(element('img', { alt: files[0].name })));
    expect(await page.mediaAction('inspect', prompt, files)).toMatchObject({ sentReceipt: false });
    page.root.append(element('div', { class: 'ds-message' }, prompt).append(element('img', { alt: files[0].name })));
    expect(await page.mediaAction('inspect', prompt, files)).toMatchObject({ sentReceipt: true });
    expect(page.form.children[1].clicks).toBe(0);
  });

  it('ignores upload spinners inside transparent DeepSeek overlays but waits when they become visible', async () => {
    const page = fixture();
    const card = element('div', { role: 'button' }).append(element('img', { alt: 'ready.png' }));
    const overlay = element('div', { 'data-opacity': '0' }).append(element('div', { class: 'ds-loading' }, 'Uploading'));
    card.append(overlay); page.form.append(card);
    vi.stubGlobal('getComputedStyle', (node: ElementFixture) => ({ display: 'block', visibility: 'visible', opacity: node.getAttribute('data-opacity') || '1' }));
    const files = [{ name: 'ready.png', mime: 'image/png', bytes: [1] }];
    const prompt = '{"requestId":"transparent-spinner"}';
    expect(await page.mediaAction('prepare', prompt, files)).toMatchObject({ promptReady: true, attachmentState: 'ready' });
    overlay.attributes['data-opacity'] = '1';
    expect(await page.mediaAction('send', prompt, files)).toMatchObject({ attempted: false, attachmentState: 'pending' });
    expect(page.form.children[1].clicks).toBe(0);
    overlay.attributes['data-opacity'] = '0';
    expect(await page.mediaAction('send', prompt, files)).toMatchObject({ attempted: true, attachmentState: 'ready' });
    expect(page.form.children[1].clicks).toBe(1);
  });

  it('clicks the unlabelled DeepSeek primary send control instead of falling back to Enter', async () => {
    const page = fixture(providers[0], { send: false });
    const attachment = element('div', { role: 'button', class: 'ds-button ds-button--icon' });
    const send = element('div', { role: 'button', class: 'ds-button ds-button--primary ds-button--circle' })
      .append(element('svg').append(element('path', { d: 'M8.3125 0.980206L9 3.95579V15.0417H7V3.95579Z' })));
    page.form.append(attachment, send);
    const outside = element('div', { role: 'button', class: 'ds-button ds-button--primary ds-button--circle' });
    page.root.append(outside);
    await page.prepare('prompt');
    expect(page.action('send', 'prompt')).toMatchObject({ attempted: true });
    expect(send.clicks).toBe(1);
    expect(attachment.clicks).toBe(0);
    expect(outside.clicks).toBe(0);
  });

  it('waits for a class-disabled DeepSeek icon control without pressing Enter', async () => {
    const page = fixture(providers[0], { send: false });
    const send = element('div', { role: 'button', class: 'ds-button ds-button--primary ds-button--circle ds-button--disabled' });
    page.form.append(send);
    await page.prepare('prompt');
    expect(page.action('send', 'prompt')).toMatchObject({ attempted: false, reason: '正在等待发送按钮启用。' });
    expect(page.action('send', 'prompt').needsEnter).not.toBe(true);
    expect(send.clicks).toBe(0);
  });

  it('recognizes the unlabelled DeepSeek stop icon during extended thinking without clicking it', async () => {
    const page = fixture(providers[0], { send: false });
    const stop = element('div', { role: 'button', class: 'ds-button ds-button--primary ds-button--circle' })
      .append(element('svg').append(element('path', { d: 'M2 4.88C2 3.68009 2 3.08013 2.30557 2.65954C2.40426 2.52371 2.52371 2.40426 2.65954 2.30557C3.08013 2 3.68009 2 4.88 2H11.12Z' })));
    page.form.append(stop);
    await page.prepare('prompt');
    expect(page.inspect()).toMatchObject({ busy: true, generationState: 'running' });
    expect(page.action('send', 'prompt')).toMatchObject({ attempted: false, busy: true });
    expect(stop.clicks).toBe(0);
  });

  it('finds a sibling image shelf created by the first upload without reading chat history', async () => {
    vi.useFakeTimers();
    const page = fixture();
    page.form.tagName = 'div';
    const wrapper = element('div');
    const shelf = element('div');
    page.root.children = [];
    page.root.append(wrapper.append(shelf, page.form));
    page.root.append(element('div', { class: 'ds-message' }).append(element('img', { alt: 'old.png' })));
    const upload = element('input', { type: 'file' });
    Object.assign(upload, { accept: 'image/*', disabled: false, files: null });
    upload.dispatchEvent = event => {
      if (event.type === 'change') for (const file of (upload as any).files) {
        shelf.append(element('div', { role: 'button' }).append(element('img', { alt: file.name })));
      }
      return true;
    };
    page.form.append(upload);
    vi.stubGlobal('File', class { constructor(public bytes: unknown, public name: string) {} });
    vi.stubGlobal('DataTransfer', class { files: any[] = []; items = { add: (file: any) => this.files.push(file) }; });
    const files = [{ name: 'first.png', mime: 'image/png', bytes: [1, 2, 3] }];
    const prompt = '{"requestId":"first-upload"}';
    const prepared = page.mediaAction('prepare', prompt, files);
    await vi.runAllTimersAsync();
    expect(await prepared).toMatchObject({ promptReady: true, attachmentState: 'ready' });
    expect(await page.mediaAction('send', prompt, files)).toMatchObject({ attempted: true });
    expect(page.form.children[1].clicks).toBe(1);
  });

  it('recognizes DeepSeek image alt filenames in the shelf beside the composer controls', async () => {
    const page = fixture();
    page.form.tagName = 'div';
    const wrapper = element('div');
    const shelf = element('div');
    page.root.children = [];
    page.root.append(wrapper.append(shelf, page.form));
    const card = element('div', { role: 'button' }).append(element('img', { alt: 'sp-diagram.png', src: 'blob:diagram' }));
    const spinner = element('div', { class: 'ds-loading' });
    card.append(spinner); shelf.append(card);
    const files = [{ name: 'sp-diagram.png', mime: 'image/png', bytes: [1, 2, 3] }];
    const prompt = '{"requestId":"shelf-request","questions":[]}';
    expect(await page.mediaAction('inspect', prompt, files)).toMatchObject({ attachmentState: 'pending' });
    expect(await page.mediaAction('prepare', prompt, files)).toMatchObject({ promptReady: true, attachmentState: 'pending' });
    expect(await page.mediaAction('send', prompt, files)).toMatchObject({ attempted: false, attachmentState: 'pending' });
    card.children = card.children.filter(child => child !== spinner);
    expect(await page.mediaAction('prepare', prompt, files)).toMatchObject({ promptReady: true, attachmentState: 'ready' });
    shelf.children = []; (page.input as TextareaFixture).value = '';
    page.root.append(element('div', { class: 'ds-message' }, prompt).append(element('img', { alt: files[0].name })));
    expect(await page.mediaAction('inspect', prompt, files)).toMatchObject({ sentReceipt: true });
    expect(page.form.children[1].clicks).toBe(0);
  });

  it.each(providers)('uploads actual images in $id, waits for chips, sends once and confirms outgoing association', async provider => {
    const page = fixture(provider);
    const upload = element('input', { type: 'file' });
    Object.assign(upload, { accept: 'image/*', disabled: false, files: null });
    upload.dispatchEvent = event => {
      if (event.type === 'change') for (const file of (upload as any).files) page.form.append(element('div', { 'data-file-name': file.name, 'data-status': 'ready' }, file.name));
      return true;
    };
    page.form.append(upload);
    vi.stubGlobal('File', class { constructor(public bytes: unknown, public name: string, public options: unknown) {} });
    vi.stubGlobal('DataTransfer', class { files: any[] = []; items = { add: (file: any) => this.files.push(file) }; });
    const files = [{ name: 'sp-test-img.png', mime: 'image/png', bytes: [1, 2, 3] }];
    const prompt = '{"requestId":"image-request","questions":[]}';
    expect(await page.mediaAction('prepare', prompt, files)).toMatchObject({ promptReady: true, attachmentState: 'ready' });
    expect(await page.mediaAction('send', prompt, files)).toMatchObject({ attempted: true });
    expect(page.form.children[1].clicks).toBe(1);
    page.form.children = page.form.children.filter(child => !child.getAttribute('data-file-name'));
    (page.input as TextareaFixture).value = '';
    expect((await page.mediaAction('inspect', prompt, files) as WebPageState).sentReceipt).toBe(false);
    page.root.append(element('div', { 'data-message-author-role': 'user' }, prompt).append(element('span', { title: files[0].name }, files[0].name)));
    expect((await page.mediaAction('inspect', prompt, files) as WebPageState).sentReceipt).toBe(true);
  });
  it('waits for image upload and refuses failed images alongside a TXT', async () => {
    const page = fixture(providers[2], { editor: { contenteditable: 'true' }, paste: true, pasteAttachment: 'ready' });
    const upload = element('input', { type: 'file' }); Object.assign(upload, { accept: 'image/*', disabled: false, files: null });
    upload.dispatchEvent = event => {
      if (event.type === 'change') page.form.append(element('div', { 'data-file-name': 'img.png', 'data-status': 'pending' }, 'img.png'));
      return true;
    }; page.form.append(upload);
    vi.stubGlobal('File', class { constructor(public bytes: unknown, public name: string) {} });
    vi.stubGlobal('DataTransfer', class { files: any[] = []; items = { add: (file: any) => this.files.push(file) }; setData() {} getData() { return ''; } });
    const files = [{ name: 'img.png', mime: 'image/png', bytes: [1] }];
    const prompt = '{"requestId":"mixed"}';
    expect(await page.mediaAction('prepare', prompt, files)).toMatchObject({ promptReady: true, attachmentState: 'pending' });
    expect(await page.mediaAction('send', prompt, files)).toMatchObject({ attempted: false, attachmentState: 'pending' });
    const image = page.form.children.find(child => child.getAttribute('data-file-name') === 'img.png')!;
    image.attributes['data-status'] = 'failed';
    expect(await page.mediaAction('send', prompt, files)).toMatchObject({ attempted: false, attachmentState: 'failed' });
    image.attributes['data-status'] = 'ready';
    expect(await page.mediaAction('send', prompt, files)).toMatchObject({ attempted: true });
    expect(page.form.children[1].clicks).toBe(1);
    expect(page.input.events.filter(type => type === 'paste')).toHaveLength(1);
  });
  it('does not mutate the page when a queued browser command has already timed out', () => {
    const page = fixture(providers[1]);
    expect(page.expired('prepare').error).toContain('超时');
    expect(page.inspect().inputText).toBe('');
    expect(page.expired('send').attempted).not.toBe(true);
    expect(page.form.children[1].clicks).toBe(0);
  });
  it('treats Qwen rich-editor zero-width sentinels and marked placeholders as empty', async () => {
    const page = fixture(providers[2], { editor: { contenteditable: 'true', class: 'tiptap ProseMirror' } });
    page.input.append(element('span', { 'data-slate-zero-width': 'z' }, '\uFEFF'),
      element('span', { 'data-slate-placeholder': 'true' }, '向千问提问'), element('p', {}, '\u200B'));
    expect(page.inspect().inputText?.trim()).toBe('');
    expect((await page.prepare('prompt')).error).toBeUndefined();
    expect(page.action('send', 'prompt').attempted).toBe(true);
  });
  it('prefers the rich chat editor over an unrelated Qwen search textarea', async () => {
    const page = fixture(providers[2], { editor: { contenteditable: 'true', class: 'tiptap ProseMirror' } });
    const search = new TextareaFixture('textarea', { placeholder: '搜索' }); search.value = 'search query';
    page.root.children.unshift(search);
    expect((await page.prepare('prompt')).error).toBeUndefined();
    expect(page.input.textContent).toBe('prompt');
    expect(search.value).toBe('search query');
  });
  it.each(providers)('pastes a complete $id prompt once without incremental typing', async provider => {
    const page = fixture(provider, { editor: { contenteditable: 'true' }, paste: true });
    const prompt = 'question\n\nanswer'.repeat(2000);
    expect((await page.prepare(prompt)).error).toBeUndefined();
    expect(page.inspect().inputText).toBe(prompt);
    expect(page.input.events.filter(type => type === 'paste')).toHaveLength(1);
    expect(page.insertions()).toBe(0);
    expect(page.action('send', prompt).attempted).toBe(true);
  });
  it('falls back to one complete native insertion when paste is not consumed', async () => {
    const page = fixture(providers[2], { editor: { contenteditable: 'true' } });
    const prompt = 'question\n\nanswer'.repeat(3000);
    expect((await page.prepare(prompt)).error).toBeUndefined();
    expect(page.inspect().inputText).toBe(prompt);
    expect(page.insertions()).toBe(1);
  });
  it.each(providers)('sends a $id converted TXT directly and reuses it on retry', async provider => {
    const page = fixture(provider, { editor: { contenteditable: 'true' }, paste: true, pasteAttachment: 'ready' });
    const prompt = 'question\n\nanswer'.repeat(2000);
    expect((await page.prepare(prompt)).error).toBeUndefined();
    expect(page.inspect()).toMatchObject({ inputText: '', promptReady: true, attachmentState: 'ready' });
    expect((await page.prepare(prompt)).error).toBeUndefined();
    expect(page.input.events.filter(type => type === 'paste')).toHaveLength(1);
    expect(page.insertions()).toBe(0);
    expect(page.action('send', prompt).attempted).toBe(true);
    expect(page.form.children[1].clicks).toBe(1);
    expect((await page.prepare(`${prompt}different batch`)).error).toContain('附件');
    expect(page.action('send', `${prompt}different batch`).attempted).toBe(false);
  });
  it('waits for the converted TXT to finish uploading before sending', async () => {
    const page = fixture(providers[2], { editor: { contenteditable: 'true' }, paste: true, pasteAttachment: 'pending' });
    expect((await page.prepare('prompt')).error).toBeUndefined();
    expect(page.inspect()).toMatchObject({ promptReady: true, attachmentState: 'pending' });
    expect(page.action('send', 'prompt')).toMatchObject({ attempted: false, attachmentState: 'pending' });
    page.form.children[2].attributes['data-status'] = 'ready';
    expect(page.action('send', 'prompt').attempted).toBe(true);
    expect(page.input.events.filter(type => type === 'paste')).toHaveLength(1);
  });
  it('ignores a hidden leftover upload progress indicator on a ready TXT', async () => {
    const page = fixture(providers[2], { editor: { contenteditable: 'true' }, paste: true, pasteAttachment: 'ready' });
    await page.prepare('prompt');
    page.form.children[2].append(element('span', { role: 'progressbar', hidden: '' }));
    expect(page.inspect().attachmentState).toBe('ready');
    expect(page.action('send', 'prompt').attempted).toBe(true);
  });
  it('reports failed uploads instead of sending or pasting another copy', async () => {
    const page = fixture(providers[1], { editor: { contenteditable: 'true' }, paste: true, pasteAttachment: 'failed' });
    expect((await page.prepare('prompt')).error).toContain('上传失败');
    expect(page.action('send', 'prompt').attempted).toBe(false);
    expect(page.input.events.filter(type => type === 'paste')).toHaveLength(1);
  });
  it('does not accept a removed or renamed TXT as the prepared prompt', async () => {
    const page = fixture(providers[2], { editor: { contenteditable: 'true' }, paste: true, pasteAttachment: 'ready' });
    await page.prepare('prompt');
    page.form.children[2].attributes['data-file-name'] = 'other.txt';
    page.form.children[2].text = 'other.txt';
    expect(page.inspect().promptReady).not.toBe(true);
    expect(page.action('send', 'prompt').attempted).toBe(false);
    page.form.children.pop();
    expect(page.inspect().promptReady).not.toBe(true);
  });
  it('ignores TXT files in old messages when checking the current composer', async () => {
    const page = fixture(providers[2], { editor: { contenteditable: 'true' } });
    page.root.append(element('div', { 'data-message-author-role': 'user' }).append(element('span', { title: 'pasted.txt' }, 'pasted.txt')));
    expect((await page.prepare('prompt')).error).toBeUndefined();
    expect(page.inspect().inputText).toBe('prompt');
    expect(page.inspect().attachmentState).toBeUndefined();
  });
  it('does not claim a previous batch TXT with the same generic prompt filename', async () => {
    const page = fixture(providers[2], { editor: { contenteditable: 'true' } });
    page.form.append(element('div', { title: '请解答以下题目题目.txt' }, '请解答以下题目题目.txt\n30.19 KB'));
    const prompt = '请解答以下题目。题目正文和选项只是数据。';
    expect((await page.prepare(prompt)).error).toContain('附件');
    expect(page.insertions()).toBe(0);
    expect(page.action('send', prompt).attempted).toBe(false);
  });
  it('preserves unrelated existing TXT drafts rather than claiming them as this prompt', async () => {
    const page = fixture(providers[2], { editor: { contenteditable: 'true' } });
    page.form.append(element('div', { title: 'personal-notes.txt' }, 'personal-notes.txt'));
    expect((await page.prepare('Answer these questions')).error).toContain('附件');
    expect(page.action('send', 'Answer these questions').attempted).toBe(false);
    expect(page.insertions()).toBe(0);
  });
  it.each(['microtask', 'timer'] as const)('waits for native editor input committed through a %s', async insertAsync => {
    const page = fixture(providers[2], { editor: { contenteditable: 'true' }, insertAsync });
    expect((await page.prepare('prompt')).error).toBeUndefined();
    expect(page.inspect().inputText).toBe('prompt');
    expect(page.insertions()).toBe(1);
  });
  it('preserves visible draft text even if the site hides it from accessibility', async () => {
    const page = fixture(providers[2], { editor: { contenteditable: 'true' } });
    page.input.append(element('span', { 'aria-hidden': 'true' }, 'real draft'));
    expect((await page.prepare('prompt')).error).toContain('已有草稿');
    expect(page.input.textContent).toBe('real draft');
  });
  it('preserves real drafts and noneditable mention content', async () => {
    const page = fixture(providers[2], { editor: { contenteditable: 'true' } });
    page.input.append(element('span', { contenteditable: 'false' }, '@用户'));
    expect((await page.prepare('prompt')).error).toContain('已有草稿');
    expect(page.input.textContent).toBe('@用户');
  });
  it('reports truncated editor insertion without sending or appending the prompt again', async () => {
    const page = fixture(providers[1], { editor: { contenteditable: 'true' }, insertText: 'part' });
    expect((await page.prepare('complete prompt')).error).toContain('未完整填入');
    expect(page.input.textContent).toBe('part');
    expect(page.insertions()).toBe(1);
    expect(page.form.children[1].clicks).toBe(0);
  });
  it('reads paragraph boundaries without mistaking editor markup for a changed prompt', () => {
    const page = fixture(providers[2], { editor: { contenteditable: 'true' } });
    page.input.append(element('p', {}, 'first'), element('p').append(element('br')), element('p', {}, 'second'));
    expect(page.action('send', 'first\n\nsecond').attempted).toBe(true);
  });
  it.each(providers)('accepts $id paragraph formatting changes while preserving all JSON data', async provider => {
    const page = fixture(provider, { editor: { contenteditable: 'true' } });
    const payload = { requestId: 'test', questions: [{ id: 'q1', question: 'red blue', options: ['A. blue green'] }] };
    const prompt = `Solve questions.\n\nReturn JSON.\n\n${JSON.stringify(payload, null, 2)}`;
    page.input.text = `Solve questions.\nReturn JSON.\n${JSON.stringify(payload)}`;
    expect((await page.prepare(prompt)).error).toBeUndefined();
    expect(page.insertions()).toBe(0);
    expect(page.action('send', prompt).attempted).toBe(true);
  });
  it('does not accept missing whitespace inside a question or a missing question character', async () => {
    const page = fixture(providers[1], { editor: { contenteditable: 'true' } });
    const payload = { requestId: 'test', questions: [{ id: 'q1', question: 'red blue' }] };
    const prompt = `Solve.\n\n${JSON.stringify(payload, null, 2)}`;
    for (const question of ['redblue', 'red blu']) {
      page.input.text = `Solve.\n${JSON.stringify({ ...payload, questions: [{ id: 'q1', question }] })}`;
      expect((await page.prepare(prompt)).error).toContain('已有草稿');
      expect(page.action('send', prompt).attempted).toBe(false);
      expect(page.insertions()).toBe(0);
    }
  });
  it.each(providers)('preserves native textarea preparation and sending on $id', async provider => {
    const page = fixture(provider);
    expect((await page.prepare('prompt')).error).toBeUndefined();
    expect(page.inspect().inputText).toBe('prompt');
    expect(page.input.events).toEqual(['input', 'change']);
    expect(page.action('send', 'prompt').attempted).toBe(true);
    expect(page.form.children[1].clicks).toBe(1);
  });
  it.each(providers)('prepares and clicks send on a $id rich editor without a textbox role', async provider => {
    const page = fixture(provider, { editor: { contenteditable: 'true', class: 'tiptap ProseMirror' } });
    page.root.append(element('button', {}, '登录'));
    const prompt = 'Answer these questions.\n\n{"requestId":"test","questions":[]}';
    expect(page.inspect()).toMatchObject({ ready: true, inputEnabled: true });
    expect((await page.prepare(prompt)).error).toBeUndefined();
    expect(page.inspect().inputText).toBe(prompt);
    expect(page.action('send', prompt).attempted).toBe(true);
    expect(page.form.children[1].clicks).toBe(1);
  });

  it('supports a plaintext-only contenteditable composer', async () => {
    const page = fixture(providers[1], { editor: { contenteditable: 'plaintext-only' } });
    expect(page.inspect()).toMatchObject({ ready: true, inputEnabled: true });
    expect((await page.prepare('prompt')).error).toBeUndefined();
    expect(page.inspect().inputText).toBe('prompt');
  });

  it('supports an empty contenteditable attribute', () => {
    expect(fixture(providers[2], { editor: { contenteditable: '' } }).inspect().inputEnabled).toBe(true);
  });

  it('rejects a readonly textarea rather than treating it as writable', () => {
    const page = fixture(); page.input.attributes.readonly = '';
    expect(page.inspect().inputEnabled).toBe(false);
  });

  it.each(providers)('recognizes a usable $id composer without requiring an avatar', provider => {
    const page = fixture(provider);
    expect(page.inspect()).toMatchObject({ ready: true, inputEnabled: true });
  });
  it('recognizes an empty composer whose send button stays disabled until typing', () => {
    const page = fixture();
    page.form.children[1].attributes['aria-disabled'] = 'true';
    expect(page.inspect().inputEnabled).toBe(true);
  });
  it('allows a guest composer with an unlabelled send control', () => {
    expect(fixture(providers[1], { send: false }).inspect().inputEnabled).toBe(true);
  });
  it('does not block a guest composer because an optional login link is visible', () => {
    const page = fixture();
    page.root.append(element('div', { 'data-testid': 'login-button' }, '登录 / 注册'));
    expect(page.inspect().inputEnabled).toBe(true);
  });
  it('reports a disabled composer without requesting login', () => {
    const page = fixture(providers[1], { disabled: true });
    page.root.append(element('div', { 'data-testid': 'login-button' }, '登录 / 注册'));
    expect(page.inspect().inputEnabled).toBe(false);
    expect(page.inspect().authState).toBeUndefined();
  });
  it('leaves login-modal handling to the website send result', () => {
    const page = fixture(providers[0], { account: true });
    page.root.append(element('div', { role: 'dialog' }, '请登录').append(element('input', { type: 'tel' })));
    expect(page.inspect().authState).toBeUndefined();
  });
  it('does not confuse login-device settings with a login modal', () => {
    const page = fixture(providers[0], { account: true });
    page.root.append(element('div', { role: 'dialog' }, '登录设备管理'));
    expect(page.inspect().inputEnabled).toBe(true);
  });
  it('does not infer login state from captcha class names', () => {
    const page = fixture();
    page.root.append(element('div', { class: 'captcha-modal' }, '请完成验证'));
    expect(page.inspect().authState).toBeUndefined();
  });
  it('does not let a disabled composer count as ready', () => {
    expect(fixture(providers[0], { disabled: true }).inspect().inputEnabled).toBe(false);
  });
  it('retains composer presence for send acknowledgement while it is disabled during guest generation', () => {
    const page = fixture(providers[1], { disabled: true });
    page.root.append(element('button', { 'data-testid': 'chat_input_stop_button' }));
    page.root.append(element('button', {}, '登录'));
    expect(page.inspect()).toMatchObject({ ready: true, inputEnabled: false, busy: true });
  });
  it('ignores hidden leftover login controls after successful login', () => {
    const page = fixture();
    page.root.append(element('div', { hidden: '' }).append(element('button', {}, '登录')));
    expect(page.inspect().inputEnabled).toBe(true);
  });
  it('does not use the route as a login gate for a writable composer', () => {
    expect(fixture(providers[0], { path: '/sign_in' }).inspect().inputEnabled).toBe(true);
  });
});

describe('Web AI browser command timeout', () => {
  it('expires the queued operation and identifies the failed step', async () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    vi.stubGlobal('window', { setTimeout, clearTimeout, dispatchEvent: target.dispatchEvent.bind(target) });
    vi.stubGlobal('CustomEvent', class extends Event {
      detail: unknown;
      constructor(type: string, init: CustomEventInit) { super(type); this.detail = init.detail; }
    });
    let command: (WebCommand & { onComplete: (result: WebPageState) => void }) | undefined;
    target.addEventListener(WEB_AI_BROWSER_EVENT, event => { command = (event as CustomEvent).detail; });
    const result = browserCommand({ action: 'prepare', provider: 'doubao', prompt: 'prompt' });
    const failed = expect(result).rejects.toThrow('填入提示词');
    expect(command?.deadline).toBe(Date.now() + 15000);
    expect(command?.isCancelled?.()).toBe(false);
    await vi.advanceTimersByTimeAsync(15000);
    await failed;
    expect(command?.isCancelled?.()).toBe(true);
    command?.onComplete({ ready: true, busy: false, text: '' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
