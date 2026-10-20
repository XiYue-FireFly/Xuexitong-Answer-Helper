import { ipcMain, net, webContents, type BrowserWindow, type WebContents } from 'electron';
import { createHash } from 'crypto';

export interface WebAITaskLease {
  sessionId: string;
  sourceContentsId: number;
  sourceUrl: string;
  aiContentsId?: number;
}
export interface QuestionMediaRead {
  sessionId: string;
  mediaId: string;
  questionHash: string;
  selector: string;
  sourceUrl?: string;
}
type Failure = { ok: false; error: string };
type Result = { ok: true } | Failure;
type MediaResult = { ok: true; bytes: number[]; mime: string; digest: string } | Failure;
type StoredMedia = { buffer: Buffer; mime: string; digest: string };
type Inspection = { sourceUrl?: string; elementId?: string; rect?: { x: number; y: number; width: number; height: number }; error?: string };
type Task = { lease: WebAITaskLease; documentId?: string; ready?: Promise<string>; source: WebContents; members: WebContents[]; bytes: number; media: Map<string, StoredMedia>; abort: AbortController };
const IMAGE_LIMIT = 8 * 1024 * 1024;
const TASK_LIMIT = 32 * 1024 * 1024;
const IMAGE_MIME = /^image\/(?:png|jpeg|jpg|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/i;
const token = (value: unknown): value is string => typeof value === 'string' && /^[\w.:-]{1,180}$/.test(value);
const failure = (error: string): Failure => ({ ok: false, error });
const httpUrl = (value: string) => { try { return /^https?:$/.test(new URL(value).protocol); } catch { return false; } };

/** This function is stringified and executed only inside the leased source. */
function inspectSourceMedia(selector: string, expectedUrl: string | undefined, documentId: string | undefined, expectedElementId?: string): Inspection {
  if (documentId && (window as any).__studyPilotTaskNavigation?.documentId !== documentId) return { error: '来源网页文档已改变' };
  const roots = '.questionLi, [data-question], [data-sp-question], [qid][qtype], [questionid][qtype], .question, .question-item, .subject-item, .exam-question, .singleQuestionDiv, .timu, .TiMu, .CeSheng, .questionCard';
  const materials = '[data-question-material], [data-material], .question-material, .shared-material, .reading-material, .material-content, .reading-passage, .passage, .material';
  const groups = '[data-question-group], [data-question-section], .question-group, .questionGroup, .question-section, .questionSection, .reading-group, .question-set, section, .section, .chapter';
  let element: Element | null;
  try { element = document.querySelector(selector); } catch { return { error: '图片定位无效' }; }
  if (!element || !element.matches('img, svg, canvas')) return { error: '题目图片已不存在' };
  let question = element.closest(roots);
  if (!question) {
    // Match enhanced capture's local mixed-question recovery. Keep a title
    // plus type/answer-control boundary rather than accepting the whole page.
    const titles = '[data-question-title], .question-title, .mark_name, .timu-title, .CeSheng_title, .Zy_TItle, .Zy_TItleTxt, .TiMu, .stem, .subject-title, .title, .q-text, .content';
    const choices = 'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], .num_option, .num_option_dx';
    for (let parent = element.parentElement, depth = 0; parent && depth < 5 && !/^(?:BODY|HTML)$/i.test(parent.tagName); parent = parent.parentElement, depth += 1) {
      if (!parent.querySelector(titles)) continue;
      const typeInputs = Array.from(parent.querySelectorAll<HTMLInputElement>('input[name]'));
      const localType = parent.getAttribute('qtype') || typeInputs.find(input => /^type(?!Name)/i.test(input.name))?.value || '';
      const typeName = typeInputs.find(input => /^typeName/i.test(input.name))?.value ||
        parent.querySelector('.colorShallow, .mark_name, .typeName, .question-type')?.textContent || '';
      const textEntry = parent.querySelector('textarea, input[type="text"], input:not([type]), [contenteditable="true"]');
      if (/^(?:0|1|2|3|4|21)$/.test(localType) || parent.querySelectorAll(choices).length >= 2 ||
        (textEntry && /填空|问答|简答|论述|作文|资料|材料|综合/.test(typeName))) { question = parent; break; }
    }
  }
  const material = element.closest(materials);
  const group = material?.closest(groups);
  if (!question && !(material && group?.querySelector(roots))) return { error: '图片不属于题目或公共材料' };
  if (element.closest('nav, header, footer, .toolbar, .avatar, .site-logo, [role="navigation"], [hidden], [contenteditable="true"], .student-answer, .studentAnswer, .my-answer, .myAnswer, [data-answer-value]')) return { error: '图片区域不可读取' };
  // aria-hidden affects accessibility, not visual visibility. Chaoxing marks
  // visible question stems this way; check rendered ancestors instead.
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return { error: '图片区域不可读取' };
  }
  const state = window as unknown as { __studyPilotTaskMediaElements?: WeakMap<Element, string> };
  const elements = state.__studyPilotTaskMediaElements ||= new WeakMap<Element, string>();
  let elementId = elements.get(element);
  if (!elementId) { elementId = `${Date.now()}:${Math.random().toString(36).slice(2)}`; elements.set(element, elementId); }
  if (expectedElementId && elementId !== expectedElementId) return { error: '题目图片元素已改变' };
  const image = element as HTMLImageElement;
  const urls = [image.currentSrc, element.getAttribute('src'), element.getAttribute('data-original'), element.getAttribute('data-src'), element.getAttribute('data-lazy-src'), element.getAttribute('data-url')]
    .filter(Boolean).map((value) => { try { return new URL(value!, element!.baseURI).href; } catch { return ''; } });
  if (expectedUrl && !urls.includes(expectedUrl)) return { error: '图片地址与页面不一致' };
  const sourceUrl = expectedUrl || (element.tagName.toLowerCase() === 'img' ? urls[0] : undefined);
  if (sourceUrl && !/^(?:https?:|data:image\/|blob:)/i.test(sourceUrl)) return { error: '图片协议不受支持' };
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const loaded = element.tagName.toLowerCase() !== 'img' || (image.complete && image.naturalWidth > 0);
  const visible = loaded && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
  return { elementId, ...(sourceUrl ? { sourceUrl } : {}), ...(visible ? { rect: { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) } } : {}) };
}

/** Bounded data/blob reads stay in the owning document's origin. */
async function readDocumentImage(sourceUrl: string, limit: number, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(sourceUrl, { signal: controller.signal });
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!response.ok || !/^image\//.test(mime) || !response.body) return { error: '图片内容不可读取' };
    const reader = response.body.getReader();
    const chunks: number[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (chunks.length + value.length > limit) { await reader.cancel(); return { error: '单张图片超过 8 MiB' }; }
      for (const byte of value) chunks.push(byte);
    }
    return { bytes: chunks, mime };
  } finally { clearTimeout(timer); }
}

function installNavigationIntent() {
  const state = window as unknown as { __studyPilotTaskNavigation?: { installed: boolean; active: boolean; documentId: string; url: string; method: string; at: number } };
  if (state.__studyPilotTaskNavigation?.installed) { state.__studyPilotTaskNavigation.active = true; return state.__studyPilotTaskNavigation.documentId; }
  const documentId = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  state.__studyPilotTaskNavigation = { installed: true, active: true, documentId, url: '', method: '', at: 0 };
  document.addEventListener('click', (event) => {
    if (!state.__studyPilotTaskNavigation?.active) return;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element | null)?.closest('a[href]') as HTMLAnchorElement | null;
    if (anchor && !anchor.download && (!anchor.target || anchor.target === '_self') && /^https?:$/.test(new URL(anchor.href).protocol)) {
      // Stop site click handlers from converting a link intent into a POST.
      // The resulting location assignment is always a GET.
      event.preventDefault(); event.stopImmediatePropagation();
      state.__studyPilotTaskNavigation = { installed: true, active: true, documentId, url: anchor.href, method: 'GET', at: Date.now() };
      window.location.assign(anchor.href);
    }
  }, true);
  document.addEventListener('submit', (event) => {
    if (!state.__studyPilotTaskNavigation?.active) return;
    const form = event.target as HTMLFormElement;
    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
    const method = (submitter?.getAttribute('formmethod') || form.method || 'GET').toUpperCase();
    let url = submitter?.getAttribute('formaction') ? new URL(submitter.formAction, document.baseURI).href : form.action;
    if (method === 'GET') {
      const target = new URL(url, document.baseURI);
      const parameters = new URLSearchParams(Array.from(new FormData(form).entries()).filter((item): item is [string, string] => typeof item[1] === 'string'));
      if (submitter?.name) parameters.append(submitter.name, submitter.value);
      target.search = parameters.toString();
      url = target.href;
    }
    state.__studyPilotTaskNavigation = { installed: true, active: true, documentId, url, method, at: Date.now() };
    const target = submitter?.getAttribute('formtarget') || form.target;
    if (method === 'GET' && (!target || target === '_self') && /^https?:$/.test(new URL(url).protocol)) {
      event.preventDefault(); event.stopImmediatePropagation(); window.location.assign(url);
    }
  }, true);
  return documentId;
}

export function createWebAITaskResourceManager(dependencies: {
  getMainWindow: () => BrowserWindow | null;
  getContents: (id: number) => WebContents | undefined;
  imageLimit?: number;
  taskLimit?: number;
  timeoutMs?: number;
}) {
  const tasks = new Map<string, Task>();
  const references = new Map<number, { contents: WebContents; count: number; previous: boolean; destroyed: () => void }>();
  const navigation = new Map<number, { contents: WebContents; count: number; listener: (...args: any[]) => void }>();
  const imageLimit = dependencies.imageLimit ?? IMAGE_LIMIT;
  const taskLimit = dependencies.taskLimit ?? TASK_LIMIT;
  const timeoutMs = dependencies.timeoutMs ?? 10000;
  const ownsCaller = (sender: WebContents) => {
    const host = dependencies.getMainWindow();
    return Boolean(host && !host.isDestroyed() && !sender.isDestroyed() && host.webContents === sender);
  };
  const sourceUnchanged = (task: Task) => !task.source.isDestroyed() && task.source.getURL() === task.lease.sourceUrl;

  function unretain(contents: WebContents) {
    const reference = references.get(contents.id);
    if (!reference || --reference.count > 0) return;
    references.delete(contents.id);
    contents.removeListener('destroyed', reference.destroyed);
    if (!contents.isDestroyed()) contents.setBackgroundThrottling(reference.previous);
  }

  function releaseTask(sessionId: string) {
    const task = tasks.get(sessionId);
    if (!task) return;
    tasks.delete(sessionId);
    task.abort.abort();
    task.media.clear(); task.bytes = 0;
    const guard = navigation.get(task.source.id);
    if (guard && --guard.count === 0) {
      guard.contents.removeListener('will-navigate', guard.listener); navigation.delete(task.source.id);
      if (!guard.contents.isDestroyed()) void guard.contents.executeJavaScript('if (window.__studyPilotTaskNavigation) window.__studyPilotTaskNavigation.active = false;').catch(() => {});
    }
    for (const contents of task.members) unretain(contents);
  }

  function retain(contents: WebContents) {
    const current = references.get(contents.id);
    if (current) { current.count += 1; return; }
    const destroyed = () => { for (const [id, task] of tasks) if (task.members.includes(contents)) releaseTask(id); };
    const previous = contents.getBackgroundThrottling();
    contents.setBackgroundThrottling(false);
    contents.once('destroyed', destroyed);
    references.set(contents.id, { contents, count: 1, previous, destroyed });
  }

  async function lease(sender: WebContents, payload: WebAITaskLease): Promise<Result> {
    if (!ownsCaller(sender)) return failure('任务资源仅允许主窗口访问');
    if (!payload || !token(payload.sessionId) || !Number.isInteger(payload.sourceContentsId) || !httpUrl(payload.sourceUrl)) return failure('任务参数无效');
    const source = dependencies.getContents(payload.sourceContentsId);
    const ai = payload.aiContentsId === undefined ? undefined : dependencies.getContents(payload.aiContentsId);
    const owned = (contents: WebContents | undefined) => Boolean(contents && !contents.isDestroyed() && contents.getType() === 'webview' && contents.hostWebContents === sender);
    if (!owned(source) || (payload.aiContentsId !== undefined && (!owned(ai) || ai === source))) return failure('网页不属于当前主窗口');
    if (source!.getURL() !== payload.sourceUrl) return failure('原题目页面已改变，请返回原页面后重试');
    const old = tasks.get(payload.sessionId);
    if (old) {
      if (old.lease.sourceContentsId !== payload.sourceContentsId || old.lease.sourceUrl !== payload.sourceUrl) return failure('任务资源已绑定到其他原题目页面');
      try { await old.ready; } catch { return failure('无法保留任务网页资源'); }
      if (tasks.get(payload.sessionId) !== old || old.abort.signal.aborted || !sourceUnchanged(old)) return failure('任务网页已关闭或改变');
      if (ai && old.lease.aiContentsId !== ai.id) {
        try { retain(ai); } catch { return failure('无法保留 AI 网页资源'); }
        const previous = old.members.find((contents) => contents !== sender && contents !== source);
        if (previous) { old.members = old.members.filter((contents) => contents !== previous); unretain(previous); }
        old.members.push(ai); old.lease.aiContentsId = ai.id;
      }
      return { ok: true };
    }
    const members = [...new Set([sender, source!, ...(ai ? [ai] : [])])];
    const task: Task = { lease: { ...payload }, source: source!, members: [], bytes: 0, media: new Map(), abort: new AbortController() };
    tasks.set(payload.sessionId, task);
    try {
      for (const contents of members) { retain(contents); task.members.push(contents); }
      const existing = navigation.get(source!.id);
      if (existing) existing.count += 1;
      else {
        const listener = (event: Electron.Event<Electron.WebContentsWillNavigateEventParams>, legacyUrl?: string) => {
          if (event.isMainFrame === false) return;
          event.preventDefault();
          const url = event.url || legacyUrl || '';
          if (!httpUrl(url) || source!.isDestroyed()) return;
          // Electron does not expose the HTTP method on will-navigate. Never
          // replay unknown/script or POST navigations as GET requests.
          void source!.executeJavaScript(`(() => { const s = window.__studyPilotTaskNavigation; return !!(s && s.method === 'GET' && s.url === ${JSON.stringify(url)} && Date.now() - s.at < 3000); })()`)
            .then((isGet) => { if (isGet && navigation.has(source!.id) && ownsCaller(sender)) sender.send('browser:open-tab', { url, title: '新标签页', foreground: true }); }).catch(() => {});
        };
        navigation.set(source!.id, { contents: source!, count: 1, listener });
        source!.on('will-navigate', listener);
      }
      task.ready = source!.executeJavaScript(`(${installNavigationIntent.toString()})()`);
      task.documentId = await task.ready;
      if (tasks.get(payload.sessionId) !== task || task.abort.signal.aborted) return failure('任务网页已关闭');
      return { ok: true };
    } catch { if (tasks.get(payload.sessionId) === task) releaseTask(payload.sessionId); return failure('无法保留任务网页资源'); }
  }

  function release(sender: WebContents, sessionId: string): Result {
    if (!ownsCaller(sender)) return failure('任务资源仅允许主窗口访问');
    if (!token(sessionId)) return failure('任务标识无效');
    releaseTask(sessionId);
    return { ok: true };
  }

  async function boundedResponse(response: Response): Promise<StoredMedia> {
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!response.ok || !IMAGE_MIME.test(mime) || !response.body) throw new Error('图片内容类型不可用');
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > imageLimit) { await response.body.cancel(); throw new Error('单张图片超过 8 MiB'); }
    const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > imageLimit) { await reader.cancel(); throw new Error('单张图片超过 8 MiB'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    const buffer = Buffer.concat(chunks);
    if (!buffer.length) throw new Error('图片内容为空');
    return { buffer, mime, digest: createHash('sha256').update(buffer).digest('hex') };
  }

  function readRedirectedImage(task: Task, sourceUrl: string, signal: AbortSignal): Promise<StoredMedia> {
    return new Promise((resolve, reject) => {
      const origin = new URL(sourceUrl).origin;
      const request = net.request({ url: sourceUrl, session: task.source.session, credentials: 'include', redirect: 'manual',
        headers: { Referer: new URL(task.lease.sourceUrl).origin + '/' } });
      let settled = false;
      let redirects = 0;
      const finish = (error?: Error, media?: StoredMedia) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        if (error) { reject(error); request.abort(); } else resolve(media!);
      };
      const abort = () => finish(new Error('图片任务已失效'));
      request.on('error', error => finish(error));
      request.on('abort', abort);
      request.on('redirect', (_status, method, target) => {
        if (settled) return;
        try {
          const url = new URL(target);
          if (++redirects > 5 || method !== 'GET' || url.origin !== origin || !httpUrl(target) || url.username || url.password) throw new Error('图片重定向不可用');
          request.followRedirect();
        } catch { finish(new Error('图片重定向不可用')); }
      });
      request.on('response', response => {
        if (settled) return;
        const header = (name: string) => { const value = response.headers[name]; return Array.isArray(value) ? value[0] || '' : String(value || ''); };
        const mime = header('content-type').split(';')[0].trim().toLowerCase();
        response.on('error', error => finish(error));
        response.on('aborted', abort);
        if (response.statusCode < 200 || response.statusCode >= 300 || !IMAGE_MIME.test(mime)) { finish(new Error('图片内容类型不可用')); return; }
        if (Number(header('content-length')) > imageLimit) { finish(new Error('单张图片超过 8 MiB')); return; }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', chunk => {
          if (settled) return;
          size += chunk.length;
          if (size > imageLimit) { finish(new Error('单张图片超过 8 MiB')); return; }
          chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => {
          if (!size) { finish(new Error('图片内容为空')); return; }
          const buffer = Buffer.concat(chunks);
          finish(undefined, { buffer, mime, digest: createHash('sha256').update(buffer).digest('hex') });
        });
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else request.end();
    });
  }

  async function read(sender: WebContents, payload: QuestionMediaRead): Promise<MediaResult> {
    if (!ownsCaller(sender)) return failure('任务资源仅允许主窗口访问');
    if (!payload || !token(payload.sessionId) || !token(payload.mediaId) || !token(payload.questionHash) || typeof payload.selector !== 'string' || payload.selector.length > 3000 || (payload.sourceUrl !== undefined && (typeof payload.sourceUrl !== 'string' || payload.sourceUrl.length > IMAGE_LIMIT * 2))) return failure('图片参数无效');
    const task = tasks.get(payload.sessionId);
    if (!task || !task.documentId || !sourceUnchanged(task)) return failure('来源任务已结束或网页已改变');
    const key = `${payload.questionHash}:${payload.mediaId}`;
    const controller = new AbortController();
    const abort = () => controller.abort();
    task.abort.signal.addEventListener('abort', abort, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let abortListener: () => void = () => {};
    const deadline = new Promise<never>((_, reject) => {
      abortListener = () => reject(new Error(timedOut ? '图片读取超时' : '图片任务已失效'));
      controller.signal.addEventListener('abort', abortListener, { once: true });
      timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    });
    const readWork = async (): Promise<MediaResult> => {
      const inspectCurrent = (sourceUrl = payload.sourceUrl, elementId?: string): Promise<Inspection> => task.source.executeJavaScript(`(${inspectSourceMedia.toString()})(${JSON.stringify(payload.selector)}, ${JSON.stringify(sourceUrl)}, ${JSON.stringify(task.documentId)}, ${JSON.stringify(elementId)})`);
      const inspection = await inspectCurrent();
      if (!inspection || inspection.error) return failure(inspection?.error || '图片校验失败');
      const cached = task.media.get(key);
      if (controller.signal.aborted || !tasks.has(payload.sessionId) || !sourceUnchanged(task)) return failure('图片任务已失效');
      if (cached) return { ok: true, bytes: [...cached.buffer], mime: cached.mime, digest: cached.digest };
      let media: StoredMedia;
      let capturedRect: Inspection['rect'];
      try {
        if (inspection.sourceUrl && httpUrl(inspection.sourceUrl)) {
          try {
            const response = await task.source.session.fetch(inspection.sourceUrl, { credentials: 'include', referrer: task.lease.sourceUrl, signal: controller.signal, redirect: 'error' });
            media = await boundedResponse(response as unknown as Response);
          } catch (error) {
            if (controller.signal.aborted || !/redirect/i.test(error instanceof Error ? error.message : String(error))) throw error;
            media = await readRedirectedImage(task, inspection.sourceUrl, controller.signal);
          }
        } else if (inspection.sourceUrl && /^(?:data:image\/|blob:)/i.test(inspection.sourceUrl)) {
          const result = await task.source.executeJavaScript(`(${readDocumentImage.toString()})(${JSON.stringify(inspection.sourceUrl)}, ${imageLimit}, ${timeoutMs})`);
          if (result.error || !IMAGE_MIME.test(result.mime || '') || !Array.isArray(result.bytes) || !result.bytes.length || result.bytes.length > imageLimit) throw new Error('图片内容不可用');
          const buffer = Buffer.from(result.bytes);
          media = { buffer, mime: result.mime, digest: createHash('sha256').update(buffer).digest('hex') };
        } else throw new Error('图片需要页面截图');
      } catch (error) {
        if (controller.signal.aborted) throw error;
        const current = await inspectCurrent(inspection.sourceUrl, inspection.elementId);
        if (current.error) return failure(current.error);
        if (!current.rect) throw error;
        if (controller.signal.aborted || !tasks.has(payload.sessionId) || !sourceUnchanged(task)) return failure('图片任务已失效');
        capturedRect = current.rect;
        const image = await task.source.capturePage(current.rect);
        const buffer = image.toPNG();
        if (!buffer.length || buffer.length > imageLimit) throw new Error('截图超过单张图片限制');
        media = { buffer, mime: 'image/png', digest: createHash('sha256').update(buffer).digest('hex') };
      }
      const finalInspection = await inspectCurrent(inspection.sourceUrl, inspection.elementId);
      if (!finalInspection || finalInspection.error) return failure(finalInspection?.error || '图片校验失败');
      if (capturedRect && JSON.stringify(finalInspection.rect) !== JSON.stringify(capturedRect)) return failure('题目图片区域已改变');
      if (controller.signal.aborted || !tasks.has(payload.sessionId) || !sourceUnchanged(task)) return failure('图片任务已失效');
      const concurrent = task.media.get(key);
      if (concurrent) return { ok: true, bytes: [...concurrent.buffer], mime: concurrent.mime, digest: concurrent.digest };
      if (task.bytes + media.buffer.length > taskLimit) return failure('本任务图片总量超过 32 MiB');
      task.bytes += media.buffer.length; task.media.set(key, media);
      return { ok: true, bytes: [...media.buffer], mime: media.mime, digest: media.digest };
    };
    try { return await Promise.race([readWork(), deadline]); }
    catch (error) { return failure(error instanceof Error && /^(?:单张图片超过|本任务图片|图片读取超时|图片任务已失效|图片内容|图片需要|截图超过)/.test(error.message) ? error.message : '图片读取失败'); }
    finally { if (timeout) clearTimeout(timeout); task.abort.signal.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', abortListener); }
  }

  return { lease, release, read, dispose: () => { for (const id of [...tasks.keys()]) releaseTask(id); } };
}

export function registerWebAITaskResources(getMainWindow: () => BrowserWindow | null) {
  const manager = createWebAITaskResourceManager({ getMainWindow, getContents: (id) => webContents.fromId(id) });
  ipcMain.handle('web-ai:lease-task', (event, payload: WebAITaskLease) => manager.lease(event.sender, payload));
  ipcMain.handle('web-ai:release-task', (event, sessionId: string) => manager.release(event.sender, sessionId));
  ipcMain.handle('web-ai:read-question-media', (event, payload: QuestionMediaRead) => manager.read(event.sender, payload));
  return manager;
}
