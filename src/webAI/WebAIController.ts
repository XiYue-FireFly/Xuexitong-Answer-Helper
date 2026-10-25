import { appStore, type QuestionItem } from '../store/appStore';
import { answerActivity, type AnswerActivity, type AnswerActivityStore } from '../answerActivity/activityStore';
import { browserCommand, type BrowserSource, type WebCommand, type WebPageState } from './browserBridge';
import { buildWebPrompt, hasCompleteWebResponse, parseWebAnswer, prepareWebBatch, sameQuestions, validateWebPrompt, WEB_AI_PROVIDERS, type AnswerItem, type SkippedWebQuestion, type WebBatch, type WebProvider } from './protocol';
import { sendWebPrompt } from './sendPrompt';
import { composerTextMatches } from './composerText';
import { waitForWebAnswer, waitForWebComposer } from './pageMonitor';
import { buildWebReferences } from './questionContext';
import { mediaFileName, prepareQuestionMedia, releaseQuestionMedia, type MediaReader, type WebMediaAttachment } from './questionMedia';
import { getPlatformAPI } from '../platform';

const PENDING_KEY = 'studypilot-web-ai-pending-v1';
export type WebRunPhase = 'idle' | 'extracting' | 'preparing' | 'opening' | 'sending' | 'waiting_answer' | 'waiting_source' | 'validating' | 'importing' | 'checking_source' | 'applying' | 'paused' | 'needs_review' | 'partial' | 'completed' | 'failed' | 'stopped';
export type WebAISnapshot = {
  provider: WebProvider; mode: 'internal' | 'external'; flow: 'manual' | 'automatic';
  selected: string[]; batch: WebBatch | null; prompt: string; reply: string; message: string;
  busy: boolean; paused: boolean; imported: boolean; visible: boolean; position: number; canRetry: boolean;
  remaining: QuestionItem[]; skipped: SkippedWebQuestion[]; completedItems: AnswerItem[];
  aiTab: { id: string; provider: WebProvider } | null; source: BrowserSource | null;
  attemptedRequest: string; runId: string; phase: WebRunPhase;
};
type PageResult = { success: boolean; questions?: QuestionItem[]; data?: QuestionItem; skipped?: number; partial?: boolean; error?: string };
type AutomaticRun = {
  stage: 'extract' | 'media' | 'prepare' | 'open' | 'send' | 'import' | 'fill' | 'next';
  items: QuestionItem[]; remaining: QuestionItem[]; first: boolean; answers: AnswerItem[];
  source: BrowserSource | null; progress: AnswerActivity | null;
  blocked: QuestionItem[];
};
const MAX_MISSING_RETRIES = 3;
type WebStore = Pick<typeof appStore, 'getState' | 'setAutomationRunning' | 'setStatus' | 'addLog' | 'upsertQuestionBank' | 'setAnswerForQuestion'>;
export type Environment = {
  store: WebStore;
  browser: (command: WebCommand) => Promise<any>;
  page: (channel: string, detail: Record<string, unknown>) => Promise<PageResult>;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  notify: (title: string, body: string) => void;
  activity: AnswerActivityStore;
  sessionId: string;
  initialSource: BrowserSource | null;
  onQuestions: (questions: QuestionItem[]) => void;
  readMedia: MediaReader;
  withConversation: <T>(provider: WebProvider, action: () => Promise<T>) => Promise<T>;
  releaseBrowserTask: (id: string) => void;
};

function restorePending(key = PENDING_KEY) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    if (!value) return { batch: null, prompt: '', error: '' };
    if (typeof value.requestId !== 'string' || !value.requestId.trim() || !Array.isArray(value.questions) || !value.questions.length ||
      !value.questions.every((q: any) => q && typeof q.hash === 'string' && typeof q.question === 'string' && typeof q.type === 'string' &&
        (q.context == null || typeof q.context === 'string') && Array.isArray(q.options) && q.options.every((option: unknown) => typeof option === 'string') &&
        (q.optionTargets == null || (Array.isArray(q.optionTargets) && q.optionTargets.every((target: any) => target && typeof target.text === 'string' && typeof target.label === 'string'))))) throw new Error('草稿格式不完整');
    const prompt = buildWebPrompt(value);
    validateWebPrompt(prompt, value);
    return { batch: value as WebBatch, prompt, error: '' };
  } catch {
    return { batch: null, prompt: '', error: '上次提示词草稿已损坏或超过 300000 字符，请重新抓题并生成提示词。' };
  }
}

function requestPage(channel: string, detail: Record<string, unknown>): Promise<PageResult> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('原题目页面响应超时。')), channel === 'studypilot:apply-answers' ? 30000 : 15000);
    window.dispatchEvent(new CustomEvent(channel, { detail: { ...detail, onComplete: (result: PageResult) => {
      window.clearTimeout(timer);
      if (result?.success) resolve(result); else reject(new Error(result?.error || '页面操作失败。'));
    } } }));
  });
}

function abortableWait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const stopped = () => { clearTimeout(timer); signal.removeEventListener('abort', stopped); reject(new Error('操作已停止。')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stopped); resolve(); }, milliseconds);
    signal.addEventListener('abort', stopped, { once: true });
    if (signal.aborted) stopped();
  });
}

export class WebAIController {
  private listeners = new Set<() => void>();
  private env: Environment;
  private state: WebAISnapshot;
  private token = 0;
  private abort = new AbortController();
  private resumePhase: WebRunPhase = 'idle';
  private pausedAt: number | null = null;
  private pausedDuration = 0;
  private ownsLock = false;
  private extractionFeedback = new Set<string>();
  private retryAction: ((token: number) => Promise<void>) | null = null;
  private retryPhase: WebRunPhase = 'idle';
  private sendState: { requestId: string; baseline: string; baselineKey?: string; uncertain: boolean; confirmed: boolean; generationStarted?: boolean } | null = null;
  private referenceQuestions: QuestionItem[] = [];
  private attachments: WebMediaAttachment[] = [];

  constructor(environment: Partial<Environment> = {}) {
    this.env = { store: appStore, browser: browserCommand, page: requestPage, wait: abortableWait, now: Date.now,
      notify: (title, body) => { const api = (window as any).electronAPI; if (api?.notify) void api.notify(title, body).catch(() => undefined); },
      activity: answerActivity, sessionId: '', initialSource: null, onQuestions: () => undefined,
      readMedia: payload => {
        const elApi = (globalThis as any).window?.electronAPI;
        if (elApi?.readQuestionMedia) return elApi.readQuestionMedia(payload);
        const platform = getPlatformAPI();
        if (platform.isAndroid) return platform.readQuestionMedia(payload);
        return Promise.resolve({ ok: false, error: '当前环境不能读取题目图片。' });
      },
      withConversation: async (_provider, action) => action(),
      releaseBrowserTask: id => {
        // Electron session resources are managed by WebAISessionManager.
        if ((globalThis as any).window?.electronAPI) {
          if (!this.env.sessionId) void (globalThis as any).window.electronAPI.releaseWebAITask?.(id)?.catch(() => undefined);
        } else if ((globalThis as any).window?.Capacitor?.getPlatform?.() === 'android') {
          const platform = getPlatformAPI();
          if (platform.isAndroid) void platform.releaseWebAITask(id).catch(() => undefined);
        }
      }, ...environment };
    const pending = typeof localStorage === 'undefined' ? { batch: null, prompt: '', error: '' } : restorePending(this.pendingKey());
    let provider: WebProvider = 'deepseek';
    try { const saved = pending.batch?.provider || localStorage.getItem(this.env.sessionId ? `${this.pendingKey()}:provider` : 'studypilot-web-ai-provider'); provider = WEB_AI_PROVIDERS.find(item => item.id === saved)?.id || provider; } catch { /* Optional preference. */ }
    this.state = { provider, mode: 'internal', flow: 'automatic', selected: this.env.store.getState().questions.map(q => q.hash),
      batch: pending.batch, prompt: pending.prompt, message: pending.error, reply: '', busy: false, paused: false,
      imported: false, visible: false, canRetry: false, position: pending.batch ? 1 : 0, remaining: [], skipped: [], completedItems: [],
      aiTab: null, source: this.env.initialSource, attemptedRequest: '', runId: '', phase: 'idle' };
  }

  private pendingKey() { return this.env.sessionId ? `${PENDING_KEY}:${this.env.sessionId}` : PENDING_KEY; }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<WebAISnapshot>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  edit(patch: Partial<Pick<WebAISnapshot, 'provider' | 'mode' | 'flow' | 'selected' | 'prompt' | 'reply' | 'visible'>>) {
    if (this.state.busy && Object.keys(patch).some(key => key !== 'visible')) return;
    const changesTask = Object.keys(patch).some(key => key !== 'visible' && patch[key as keyof typeof patch] !== this.state[key as keyof typeof patch]);
    if (changesTask) this.retryAction = null;
    this.update({ ...patch, ...(changesTask ? { canRetry: false } : {}), ...(patch.reply !== undefined && patch.reply !== this.state.reply ? { imported: false } : {}) });
  }
  private phase(phase: WebRunPhase, message: string) {
    const terminal = ['completed', 'partial', 'failed', 'needs_review'].includes(phase);
    if (this.state.paused && phase !== 'paused' && !terminal) { this.resumePhase = phase; return; }
    this.update({ phase, message, ...(terminal ? { paused: false } : {}) });
    this.env.activity.phase(this.state.runId, phase, message, this.state.paused);
  }
  private begin(phase: WebRunPhase) {
    const app = this.env.store.getState();
    if (this.state.busy || app.batchRunning || app.liveRunning || ['calling_ai', 'executing'].includes(app.status)) {
      if (!this.state.busy) this.update({ message: '请先等待当前任务结束。' });
      return null;
    }
    this.abort = new AbortController();
    this.pausedAt = null;
    this.pausedDuration = 0;
    const token = ++this.token;
    this.ownsLock = true;
    this.update({ busy: true, paused: false, canRetry: false, ...(this.state.flow === 'automatic' ? { visible: false } : {}), phase, runId: `web:${this.env.sessionId}:${this.env.now()}:${token}` });
    this.env.store.setAutomationRunning({ batchRunning: true });
    return token;
  }
  private check(token: number) {
    if (token !== this.token || this.abort.signal.aborted) throw new Error('操作已停止。');
  }
  private async checkpoint(token: number) {
    this.check(token);
    while (this.state.paused) { await this.env.wait(250, this.abort.signal); this.check(token); }
    if (!this.env.store.getState().settings.allowRealPageAutomation && this.state.mode === 'internal') throw new Error('真实 WebView 已关闭，任务停止。');
  }
  private async wait(milliseconds: number, token: number) {
    await this.checkpoint(token);
    this.check(token);
    await this.env.wait(milliseconds, this.abort.signal);
    await this.checkpoint(token);
  }
  private finish(token: number) {
    if (token !== this.token) return;
    this.ownsLock = false;
    this.env.store.setAutomationRunning({ batchRunning: false });
    this.update({ busy: false, paused: false });
    this.attachments = [];
    releaseQuestionMedia(this.env.sessionId || this.state.runId);
    this.env.releaseBrowserTask(this.env.sessionId || this.state.runId);
  }
  private async perform(phase: WebRunPhase, action: (token: number) => Promise<void>) {
    const token = this.begin(phase);
    if (token === null) return;
    this.retryAction = action;
    try { await action(token); if (token === this.token && !this.state.canRetry) this.retryAction = null; }
    catch (error) {
      if (token !== this.token) return;
      this.retryPhase = this.state.phase;
      const message = `${(error as Error).message}${/重试/.test((error as Error).message) ? '' : ' 请检查页面后点击“重试”。'}`;
      this.update({ canRetry: true, visible: true });
      this.phase('failed', message);
      this.env.activity.finish(this.state.runId, 'failed', message);
      this.env.store.setStatus('error', message);
      this.env.notify('网页 AI 需要重试', message);
    } finally { this.finish(token); }
  }
  private notice = (message: string) => {
    this.update({ message, visible: true });
    this.env.activity.phase(this.state.runId, this.state.phase, message, this.state.paused);
    this.env.store.addLog('warn', message);
    this.env.notify('网页 AI 需要查看', message);
  };
  private monitorOptions(token: number) {
    const tab = this.state.aiTab!;
    return {
      inspect: async (): Promise<WebPageState> => { await this.checkpoint(token); this.check(token); return this.env.browser({ ...this.mediaBinding(), action: 'inspect', provider: tab.provider, tabId: tab.id, prompt: this.state.prompt, attachments: this.attachments, isCancelled: () => token !== this.token }); },
      wait: (milliseconds: number) => this.wait(milliseconds, token),
      now: () => { const now = this.env.now(); return now - this.pausedDuration - (this.pausedAt === null ? 0 : now - this.pausedAt); },
      checkCancelled: () => this.check(token), onNotice: this.notice
    };
  }
  private saveBatch() {
    try {
      if (this.state.batch) localStorage.setItem(this.pendingKey(), JSON.stringify(this.state.batch)); else localStorage.removeItem(this.pendingKey());
      localStorage.setItem(this.env.sessionId ? `${this.pendingKey()}:provider` : 'studypilot-web-ai-provider', this.state.provider);
    } catch { /* The in-memory workflow can continue without draft storage. */ }
  }
  private prepare(items: QuestionItem[], nextBatch: boolean) {
    const next = prepareWebBatch(items, this.state.provider, buildWebReferences(this.referenceQuestions.length ? this.referenceQuestions : this.env.store.getState().questions, this.state.completedItems));
    this.update({ batch: next.batch, prompt: next.prompt, remaining: next.remaining, reply: '', imported: false, attemptedRequest: '',
      skipped: nextBatch ? [...this.state.skipped, ...next.skipped.filter(item => !this.state.skipped.some(old => old.questionHash === item.questionHash))] : next.skipped,
      position: nextBatch ? this.state.position + (next.batch ? 1 : 0) : next.batch ? 1 : 0 });
    this.saveBatch();
    return next;
  }
  generate = (nextBatch = false) => {
    if (this.state.busy) return;
    this.retryAction = null;
    this.update({ canRetry: false });
    try {
      const items = nextBatch ? this.state.remaining : this.env.store.getState().questions.filter(q => this.state.selected.includes(q.hash)).map((q, i) => q.index ? q : { ...q, index: i + 1 });
      if (!nextBatch) this.update({ completedItems: [], ...(items.some(q => !q.pageUrl || q.pageUrl !== this.state.source?.url) ? { source: null, aiTab: null } : {}) });
      const next = this.prepare(items, nextBatch);
      this.update({ message: next.batch ? `已生成 ${next.batch.questions.length} 题提示词，共 ${next.prompt.length.toLocaleString()} 字符，待处理 ${next.remaining.length} 题。` : '剩余题目均超过单批字符上限，已跳过本次发送；原题和此前已入库答案保留。' });
    } catch (error) { this.update({ message: (error as Error).message }); }
  };
  private async extract(source: BrowserSource, token: number, reset = false) {
    await this.checkpoint(token);
    this.check(token);
    const result = await this.env.page('studypilot:extract-question-request', { sessionId: this.env.sessionId || undefined, targetTabId: source.tabId, expectedUrl: source.url, resetProgress: reset, isCancelled: () => token !== this.token });
    this.check(token);
    if (!result.success) throw new Error(result.error || '题目抓取失败。');
    const items = (Array.isArray(result.questions) ? result.questions : result.data ? [result.data] : []).filter(Boolean);
    if (!items.length) throw new Error('当前页面未识别到可用题目。');
    if (reset) { this.env.onQuestions(items); this.referenceQuestions = items; }
    return items;
  }
  extractQuestions = () => this.perform('extracting', async token => {
    await this.checkpoint(token);
    this.check(token);
    const source = await this.env.browser({ action: 'source', tabId: this.state.source?.tabId }) as BrowserSource;
    this.check(token);
    this.update({ source });
    const extracted = await this.extract(source, token, true);
    this.check(token);
    this.update({ selected: extracted.map(q => q.hash), batch: null, prompt: '', reply: '', imported: false, completedItems: [], remaining: [], skipped: [], attemptedRequest: '', position: 0 });
    this.phase('idle', `已抓取 ${extracted.length} 道题，请点击“生成提示词”。`);
    this.env.store.setStatus('done', `网页 AI 已抓取 ${extracted.length} 道题。`);
  });
  private async openInternal(token: number) {
    await this.checkpoint(token);
    this.check(token);
    let opened: BrowserSource;
    let created = false;
    try {
      if (this.state.aiTab?.provider !== this.state.provider) throw new Error('new tab');
      opened = await this.env.browser({ action: this.env.sessionId ? 'source' : 'focus', provider: this.state.provider, tabId: this.state.aiTab.id });
    } catch {
      this.check(token);
      opened = await this.env.browser({ action: 'open', provider: this.state.provider });
      created = true;
    }
    this.check(token);
    this.update({ aiTab: { id: opened.tabId, provider: this.state.provider }, visible: false });
    // Opening a tab returns before React registers its WebView in the browser bridge.
    if (created) {
      for (let attempt = 0; ; attempt++) {
        await this.checkpoint(token);
        this.check(token);
        try {
          await this.env.browser({ action: this.env.sessionId ? 'source' : 'focus', provider: this.state.provider, tabId: opened.tabId, isCancelled: () => token !== this.token });
          this.check(token);
          break;
        } catch (error) {
          this.check(token);
          if (!/原标签已关闭|网页尚未就绪/.test((error as Error).message)) throw error;
          if (attempt >= 49) throw new Error('新打开的 AI 标签未能就绪，请检查标签页后重试。');
          await this.wait(200, token);
        }
      }
    }
  }
  openWebsite = () => this.perform('opening', async token => {
    const batch = this.state.batch;
    if (!batch || batch.provider && batch.provider !== this.state.provider) throw new Error('请先为所选网站生成提示词。');
    if (this.state.mode === 'external') {
      const api = (window as any).electronAPI;
      if (!api?.openExternalUrl) { this.update({ message: '请使用下方网站链接打开聊天页。' }); return; }
      const result = await api.openExternalUrl(WEB_AI_PROVIDERS.find(p => p.id === this.state.provider)!.url);
      this.check(token);
      if (!result?.success) throw new Error(result?.error || '打开系统浏览器失败。');
    } else {
      await this.checkpoint(token);
      this.check(token);
      const source = await this.env.browser({ action: 'source', tabId: this.state.source?.tabId }) as BrowserSource;
      this.check(token);
      if (batch.questions.some(q => q.pageUrl && q.pageUrl !== source.url)) throw new Error('请先切回抓题来源标签，再打开 AI 网站。');
      this.update({ source });
      await this.openInternal(token);
    }
    this.phase('idle', '网站已打开，可以发送提示词。');
  });
  private async sendAndRead(token: number, automatic: boolean) {
    this.phase('preparing', '等待网站会话发送资源；其他题页任务继续运行。');
    return this.env.withConversation(this.state.provider, () => this.sendAndReadInConversation(token, automatic));
  }
  private mediaBinding(): Partial<WebCommand> {
    return this.state.batch?.questions.some(question => question.media?.length) && this.state.source
      ? { sessionId: this.env.sessionId || this.state.runId, resourceSource: this.state.source } : {};
  }
  private async sendAndReadInConversation(token: number, automatic: boolean) {
    this.check(token);
    let { batch, prompt } = this.state;
    const { aiTab } = this.state;
    if (!batch || !aiTab || aiTab.provider !== this.state.provider || this.state.mode !== 'internal') throw new Error('请先打开本批所选 AI 网站。');
    validateWebPrompt(prompt, batch);
    await this.checkpoint(token);
    this.check(token);
    if (batch.questions.some(question => question.media?.length)) {
      if (!this.state.source) throw new Error('含图题需要绑定原题目页面，请重新抓题。');
      await this.env.browser({ ...this.mediaBinding(), action: 'source', tabId: this.state.source.tabId });
      const media = await prepareQuestionMedia(this.env.sessionId || this.state.runId, batch.questions, this.env.readMedia, () => token !== this.token);
      this.check(token);
      if (media.failures.length) throw new Error(`第 ${media.failures[0].question.index || '?'} 题图片尚未就绪：${media.failures[0].reason}`);
      this.attachments = media.attachments;
      // Manual drafts can be generated before the original MIME is known.
      // Update only attachment names, preserving any user edits in the text.
      for (let index = 0; index < batch.questions.length; index++) {
        const question = batch.questions[index];
        question.media?.forEach((image, imageIndex) => {
          const previous = mediaFileName(question, image);
          const current = mediaFileName(media.ready[index], media.ready[index].media![imageIndex]);
          if (previous !== current) prompt = prompt.split(previous).join(current);
        });
      }
      batch = { ...batch, questions: media.ready };
      validateWebPrompt(prompt, batch);
      this.update({ batch, prompt });
      this.saveBatch();
    } else this.attachments = [];
    if (!this.env.sessionId) await this.env.browser({ action: 'focus', tabId: aiTab.id });
    this.check(token);
    this.phase('preparing', '正在检查 AI 网页输入区。');
    this.env.store.setStatus('idle', '正在检查 AI 网页输入区。');
    const options = this.monitorOptions(token);
    let before = await options.inspect();
    const previous = this.sendState?.requestId === batch.requestId ? this.sendState : null;
    const attempted = this.state.attemptedRequest === batch.requestId;
    const unchangedDraft = (before.promptReady || before.inputText !== undefined && composerTextMatches(before.inputText, prompt)) && before.text === previous?.baseline && !before.busy && before.generationState !== 'running';
    const shouldSend = !hasCompleteWebResponse(before.text, batch.requestId) && (!attempted || Boolean(previous && !previous.confirmed && !previous.uncertain && unchangedDraft));
    if (attempted && previous?.uncertain && unchangedDraft) throw new Error('上次发送状态不确定，请先在网页确认是否已经发送；可手动发送或使用“提取答案”继续。');
    if (shouldSend) {
      let initial = true;
      before = await waitForWebComposer({ ...options, inspect: async () => { if (initial) { initial = false; return before; } return options.inspect(); } });
    }
    await this.checkpoint(token);
    this.check(token);
    if (shouldSend) {
      this.phase('sending', '正在发送提示词。');
      this.env.store.setStatus('calling_ai', '网页 AI：发送提示词。');
      const baseline = await this.env.browser({ ...this.mediaBinding(), action: 'prepare', provider: aiTab.provider, tabId: aiTab.id, prompt, attachments: this.attachments, isCancelled: () => token !== this.token }) as WebPageState;
      this.check(token);
      this.sendState = { requestId: batch.requestId, baseline: baseline.text, baselineKey: before.messageKey, uncertain: false, confirmed: false };
      const acknowledged = await sendWebPrompt({ ...options, baseline: baseline.text, requireAttachmentReceipt: this.attachments.length > 0,
        wait: () => this.wait(500, token), onManualSend: this.notice,
        send: async () => {
          await this.checkpoint(token);
          this.check(token);
          try {
            const result = await this.env.browser({ ...this.mediaBinding(), action: 'send', provider: aiTab.provider, tabId: aiTab.id, prompt, attachments: this.attachments, isCancelled: () => token !== this.token }) as WebPageState;
            this.check(token);
            if (result.attempted) this.update({ attemptedRequest: batch.requestId });
            return result;
          } catch (error) {
            if (token === this.token) { this.update({ attemptedRequest: batch.requestId }); this.sendState!.uncertain = true; }
            throw error;
          }
        }
      });
      this.sendState.confirmed = true;
      this.sendState.generationStarted = acknowledged.busy || acknowledged.generationState === 'running';
    }
    this.check(token);
    this.update({ attemptedRequest: batch.requestId, visible: false });
    this.phase('waiting_answer', '提示词已发送，正在等待并自动提取答案。');
    const reply = await waitForWebAnswer({ ...options, requestId: batch.requestId, acceptIncomplete: automatic,
      baseline: this.sendState?.requestId === batch.requestId ? this.sendState.baseline : before.text,
      baselineKey: this.sendState?.requestId === batch.requestId ? this.sendState.baselineKey : before.messageKey,
      generationStarted: this.sendState?.requestId === batch.requestId && this.sendState.generationStarted });
    this.check(token);
    this.update({ reply, imported: false, visible: !automatic });
    this.phase('validating', '已提取回答，正在核对本批答案。');
    const preview = parseWebAnswer(reply, batch, `${WEB_AI_PROVIDERS.find(p => p.id === batch.provider)?.name || 'AI'} 网页`, automatic);
    if (automatic ? preview.items.length > 0 : preview.automatic) {
      this.env.activity.resolved(this.state.runId, preview.items.map(item => item.question.hash));
      this.extracted(batch.requestId);
    }
    return preview;
  }
  private extracted(requestId: string) {
    if (this.extractionFeedback.has(requestId)) return;
    this.extractionFeedback.add(requestId);
    this.env.activity.extracted(this.state.runId, requestId);
  }
  send = () => this.perform('sending', async token => {
    this.env.activity.begin(this.state.runId, 'web-read', this.state.batch?.questions.map(q => q.hash) || []);
    await this.sendAndRead(token, false);
    this.phase('idle', '已自动提取答案，请核对预览后确认入库。');
    this.env.activity.finish(this.state.runId, 'partial', '已提取答案，等待核对入库。');
    this.env.store.setStatus('done', '网页 AI 回答已提取。');
  });
  read = () => this.perform('waiting_answer', async token => {
    const { batch, aiTab } = this.state;
    if (!batch || !aiTab || this.state.mode !== 'internal' || aiTab.provider !== this.state.provider) throw new Error('请先打开对应 AI 网站。');
    const page = await this.env.browser({ action: 'inspect', provider: aiTab.provider, tabId: aiTab.id }) as WebPageState;
    this.check(token);
    if (page.busy || page.generationState === 'running') throw new Error('回答仍在生成，请等待完成后再提取答案。');
    if (!page.text.trim()) throw new Error('尚未找到回答，请等待生成完成或粘贴回答。');
    this.update({ reply: page.text, imported: page.text === this.state.reply && this.state.imported, visible: true });
    this.env.activity.begin(this.state.runId, 'web-read', batch.questions.map(q => q.hash));
    if (parseWebAnswer(page.text, batch, 'AI 网页').automatic) this.extracted(batch.requestId);
    this.env.activity.finish(this.state.runId, 'partial', '已提取答案，等待核对入库。');
    this.phase('idle', '已提取答案，请核对预览后确认入库。');
  });
  private importItems(items: AnswerItem[]) {
    items.forEach(item => { this.env.store.upsertQuestionBank(item.question, item.answer); this.env.store.setAnswerForQuestion(item.question, item.answer); });
    this.update({ completedItems: [...this.state.completedItems.filter(old => !items.some(item => item.question.hash === old.question.hash)), ...items], imported: true });
  }
  importPreview = () => {
    if (this.state.busy || !this.state.batch) return;
    const preview = parseWebAnswer(this.state.reply, this.state.batch, `${WEB_AI_PROVIDERS.find(p => p.id === this.state.batch?.provider)?.name || 'AI'} 网页`);
    if (!preview.items.length) return;
    this.importItems(preview.items);
    this.update({ message: `已导入 ${preview.items.length} 道有效答案。` });
  };
  private async fill(items: AnswerItem[], token: number, handled = new Set<string>()) {
    const source = this.state.source;
    if (!source) throw new Error('原题目来源已丢失，请重新抓题。');
    await this.checkpoint(token);
    this.check(token);
    this.phase('checking_source', '正在核对原题目页面。');
    if (!this.env.sessionId) await this.env.browser({ action: 'focus', tabId: source.tabId });
    this.check(token);
    let actual: QuestionItem[];
    for (;;) {
      await this.checkpoint(token);
      try {
        actual = await this.extract(source, token);
        if (!sameQuestions(items.map(item => item.question), actual)) throw new Error('原题目页面身份已变化，等待原题恢复。');
        break;
      } catch (error) {
        if (!this.env.sessionId || !/原题目页面|原标签|尚未就绪|重新加载|未.*识别到.*题目/.test((error as Error).message)) throw error;
        if (this.state.phase !== 'waiting_source') this.notice('答案已准备，等待原题目页面恢复；其他页面任务继续运行。');
        this.phase('waiting_source', '答案已准备，等待原题目页面恢复。');
        await this.wait(1500, token);
      }
    }
    this.check(token);
    if (!sameQuestions(items.map(item => item.question), actual)) throw new Error('原页面题目或选项已变化，已停止填入；答案保留在题库。');
    for (const item of items) {
      if (handled.has(item.question.hash)) continue;
      await this.checkpoint(token);
      this.check(token);
      this.phase('applying', `正在填入第 ${item.question.index || actual.findIndex(q => q.hash === item.question.hash) + 1} 题。`);
      const question = actual.find(candidate => candidate.hash === item.question.hash)!;
      let result: PageResult;
      try {
        result = await this.env.page('studypilot:apply-answers', { sessionId: this.env.sessionId || undefined, items: [{ ...item, question }], targetTabId: source.tabId, expectedUrl: source.url, isCancelled: () => token !== this.token });
      } catch (error) {
        if (this.env.sessionId && /原题目页面|原标签|尚未就绪|重新加载/.test((error as Error).message)) { await this.fill(items, token, handled); return; }
        throw error;
      }
      this.check(token);
      if (!result.success) throw new Error(result.error || '答案填入失败。');
      if (result.partial || result.skipped) this.env.activity.skip(this.state.runId, [question.hash]);
      else this.env.activity.applied(this.state.runId, question.hash);
      handled.add(question.hash);
    }
  }
  private beginActivity(kind: 'web-auto' | 'web-read', targets: string[], progress: AnswerActivity | null = null) {
    this.env.activity.begin(this.state.runId, kind, targets);
    if (!progress) return;
    this.env.activity.resolved(this.state.runId, progress.resolved);
    progress.applied.forEach(hash => this.env.activity.applied(this.state.runId, hash));
    this.env.activity.skip(this.state.runId, progress.skipped);
  }
  approveFill = () => {
    const handled = new Set<string>();
    let progress: AnswerActivity | null = null;
    return this.perform('checking_source', async token => {
      if (!this.state.completedItems.length) throw new Error('请先录入有效答案。');
      this.beginActivity('web-auto', this.state.completedItems.map(item => item.question.hash), progress);
      this.env.store.setStatus('executing', '网页 AI：正在核对原题目。');
      try { await this.fill(this.state.completedItems, token, handled); }
      catch (error) { progress = this.env.activity.getSnapshot().task; throw error; }
      await this.checkpoint(token);
      this.check(token);
      this.env.activity.finish(this.state.runId, 'completed', '答案填入完成。');
      const complete = this.env.activity.getSnapshot().task?.outcome === 'completed';
      this.phase(complete ? 'completed' : 'partial', complete ? '已填入原题目页面。' : '部分答案未填入，请查看原题目页面。');
      this.env.store.setStatus('done', '网页 AI 答案填入完成。');
    });
  };
  startAutomatic = () => {
    const run: AutomaticRun = { stage: 'extract', items: [], remaining: [], first: true, answers: [], source: null, progress: null, blocked: [] };
    const handled = new Set<string>();
    return this.perform('extracting', async token => {
      // Each explicit retry gets a fresh bounded allowance for unresolved questions.
      const missingAttempts = new Map<string, number>();
      if (this.state.mode !== 'internal') throw new Error('自动答题需要使用应用内浏览器。');
      await this.checkpoint(token);
      this.check(token);
      if (run.progress) this.beginActivity('web-auto', run.progress.targets, run.progress);
      else {
        this.update({ flow: 'automatic', completedItems: [], skipped: [], position: 0, reply: '', imported: false, batch: null, prompt: '', attemptedRequest: '' });
      }
      try {
        for (;;) {
          await this.checkpoint(token);
          this.check(token);
          if (run.stage === 'extract') {
            this.phase('extracting', '正在抓取当前页面全部题目。');
            run.source ||= await this.env.browser({ action: 'source' }) as BrowserSource;
            this.check(token);
            this.update({ source: run.source });
            const captured = await this.extract(run.source, token, true);
            run.items = captured;
            this.check(token);
            this.update({ selected: captured.map(q => q.hash) });
            this.beginActivity('web-auto', run.items.map(q => q.hash));
            run.remaining = run.items;
            run.stage = 'media';
          }
          if (run.stage === 'media') {
            this.phase('preparing', '正在准备题目图片。');
            await this.env.browser({ action: 'source', tabId: run.source!.tabId, sessionId: this.env.sessionId || this.state.runId, resourceSource: run.source! });
            const media = await prepareQuestionMedia(this.env.sessionId || this.state.runId, run.remaining, this.env.readMedia, () => token !== this.token);
            this.check(token);
            run.blocked = media.failures.map(item => item.question);
            media.failures.forEach(item => this.env.store.addLog('warn', `第 ${item.question.index || '?'} 题图片待处理：${item.reason}`));
            run.remaining = media.ready;
            run.stage = 'prepare';
          }
          if (run.stage === 'prepare') {
            if (!run.remaining.length) run.stage = 'fill';
            else {
              this.phase('preparing', '正在生成本批提示词。');
              const next = this.prepare(run.remaining, !run.first);
              run.first = false;
              this.env.activity.skip(this.state.runId, next.skipped.map(item => item.questionHash));
              run.remaining = next.remaining;
              run.stage = next.batch ? 'open' : 'fill';
            }
          }
          if (run.stage === 'open') {
            this.phase('opening', '正在打开网页 AI。');
            await this.openInternal(token);
            run.stage = 'send';
          }
          if (run.stage === 'send') {
            try {
              const preview = await this.sendAndRead(token, true);
              const unsafeImages = preview.items.filter(item => item.question.media?.length && item.answer.warnings.length > 0);
              run.blocked.push(...unsafeImages.map(item => item.question));
              run.answers = preview.items.filter(item => !unsafeImages.includes(item));
              run.stage = 'import';
            } catch (error) {
              // A rejected upload has not sent a message. Defer these image
              // questions and continue the remaining valid text questions.
              const media = this.state.batch!.questions.filter(question => question.media?.length);
              if (!media.length || this.state.attemptedRequest === this.state.batch!.requestId || !/图片|附件|上传/.test((error as Error).message)) throw error;
              run.blocked.push(...media);
              run.remaining = [...this.state.batch!.questions.filter(question => !question.media?.length), ...run.remaining];
              // Keep the failed draft available for inspection, and use a new
              // conversation for unrelated valid questions.
              this.update({ aiTab: null });
              this.sendState = null;
              this.env.store.addLog('warn', `本批含图题等待处理：${(error as Error).message}`);
              run.stage = 'prepare';
              continue;
            }
          }
          await this.checkpoint(token);
          this.check(token);
          if (run.stage === 'import') {
            this.phase('importing', '正在录入已校验答案。');
            if (run.answers.length) this.importItems(run.answers);
            const answered = new Set(run.answers.map(item => item.question.hash));
            const missing = this.state.batch!.questions.filter(question => !answered.has(question.hash) && !run.blocked.some(item => item.hash === question.hash));
            const retryable: QuestionItem[] = [];
            const exhausted: QuestionItem[] = [];
            for (const question of missing) {
              const count = (missingAttempts.get(question.hash) || 0) + 1;
              missingAttempts.set(question.hash, count);
              (count > MAX_MISSING_RETRIES ? exhausted : retryable).push(question);
            }
            if (exhausted.length) {
              this.env.activity.skip(this.state.runId, exhausted.map(question => question.hash));
              this.update({ skipped: [...this.state.skipped, ...exhausted.map(question => ({ questionHash: question.hash,
                questionIndex: question.index || run.items.findIndex(item => item.hash === question.hash) + 1,
                promptLength: 0, reason: 'no-valid-answer' as const }))] });
              this.env.store.addLog('warn', `${exhausted.length} 道题在补发 ${MAX_MISSING_RETRIES} 轮后仍无有效答案，已跳过并继续后续题目。`);
            }
            run.remaining = [...retryable, ...run.remaining];
            this.update({ remaining: run.remaining });
            run.stage = 'prepare';
            if (retryable.length) {
              const message = `本批已录入 ${run.answers.length}/${this.state.batch!.questions.length} 题，正在自动补发 ${retryable.length} 道未录入题目。`;
              this.update({ message });
              this.env.store.addLog('info', message);
            }
          }
          if (run.stage === 'fill') {
            if (this.state.completedItems.length) await this.fill(this.state.completedItems, token, handled);
            run.stage = 'next';
          }
          await this.checkpoint(token);
          this.check(token);
          if (run.stage === 'next') break;
        }
      } catch (error) {
        const progress = this.env.activity.getSnapshot().task;
        run.progress = progress?.id === this.state.runId ? progress : null;
        throw error;
      }
      const task = this.env.activity.getSnapshot().task!;
      const complete = task.targets.length > 0 && task.applied.length === task.targets.length && !task.skipped.length;
      const message = complete ? `全部 ${run.items.length} 道题已完成并填回，未提交。` : `已填入 ${task.applied.length}/${run.items.length} 题，${task.skipped.length} 题已跳过，请查看。`;
      if (run.blocked.length) {
        run.remaining = run.blocked;
        run.stage = 'media';
        run.progress = task;
        const message = `已填入 ${task.applied.length}/${run.items.length} 题；${run.blocked.length} 道含图题等待处理，点击重试只补齐待处理题。`;
        this.update({ visible: true, canRetry: true });
        this.phase('partial', message);
        this.env.activity.finish(this.state.runId, 'partial', message);
        this.env.store.setStatus('done', message);
        return;
      }
      this.update({ visible: !complete });
      this.phase(complete ? 'completed' : 'partial', message);
      this.env.activity.finish(this.state.runId, complete ? 'completed' : 'partial', message);
      this.env.store.setStatus('done', message);
    });
  };
  retry = () => {
    if (this.state.busy || !this.state.canRetry || !this.retryAction) return Promise.resolve();
    const action = this.retryAction;
    return this.perform(this.retryPhase, action);
  };
  togglePause = () => {
    if (!this.state.busy) return;
    if (this.state.paused) {
      if (this.pausedAt !== null) this.pausedDuration += this.env.now() - this.pausedAt;
      this.pausedAt = null;
      this.update({ paused: false, visible: false }); this.phase(this.resumePhase, '已继续自动答题。');
    } else {
      this.pausedAt = this.env.now();
      this.resumePhase = this.state.phase;
      this.update({ paused: true, visible: true }); this.phase('paused', '任务已暂停，继续后将从当前步骤恢复。');
    }
  };
  stop = () => {
    if (!this.state.busy) return;
    const id = this.state.runId;
    this.token++;
    this.retryAction = null;
    this.abort.abort();
    releaseQuestionMedia(this.env.sessionId || id);
    this.env.releaseBrowserTask(this.env.sessionId || id);
    this.attachments = [];
    if (this.ownsLock) {
      this.ownsLock = false;
      this.env.store.setStatus('idle', '网页 AI 操作已停止。');
      this.env.store.setAutomationRunning({ batchRunning: false });
    }
    this.update({ busy: false, paused: false, canRetry: false, phase: 'stopped', message: '已停止当前操作，网站上已发送的请求可能仍在生成。' });
    this.env.activity.finish(id, 'stopped', '任务已停止。');
  };
  copy = async () => {
    try { if (this.state.batch) validateWebPrompt(this.state.prompt, this.state.batch); await navigator.clipboard.writeText(this.state.prompt); this.update({ message: '提示词已复制。' }); }
    catch (error) { this.update({ message: `复制失败：${(error as Error).message}` }); }
  };
}

export const webAIController = new WebAIController();
