import { appStore, type QuestionItem, type AIAnswerResult } from '../store/appStore';
import { AnswerActivityStore, type ActivityFeedback, type AnswerActivity } from '../answerActivity/activityStore';
import { WebAIController, webAIController as legacyController, type Environment } from './WebAIController';
import { browserCommand, type BrowserSource, type WebCommand } from './browserBridge';
import { webPageRequests } from './pageRequests';
import { toWebBankQuestion } from './questionContext';
import { releaseQuestionMedia } from './questionMedia';
import type { WebProvider } from './protocol';

export type WebSession = { id: string; source: BrowserSource; title: string; questions: QuestionItem[]; controller: WebAIController; activity: AnswerActivityStore };
type SessionSnapshot = { sessions: WebSession[]; selectedId: string; controller: WebAIController; busy: boolean; tasks: { session: WebSession; task: AnswerActivity }[]; feedback: ActivityFeedback[] };

export class WebAISessionManager {
  private sessions = new Map<string, WebSession>();
  private selectedId = '';
  private active = new Set<string>();
  private listeners = new Set<() => void>();
  private conversations = new Map<WebProvider, Promise<unknown>>();
  private snapshot!: SessionSnapshot;
  constructor(private store = appStore, private overrides: Partial<Environment> = {}, private fallback = legacyController) {
    this.refresh();
    this.fallback.subscribe(() => this.refresh());
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private refresh() {
    const sessions = [...this.sessions.values()];
    this.snapshot = { sessions, selectedId: this.selectedId, controller: this.sessions.get(this.selectedId)?.controller || this.fallback,
      busy: this.active.size > 0 || sessions.some(session => session.controller.getSnapshot().busy) || this.fallback.getSnapshot().busy,
      tasks: sessions.flatMap(session => { const task = session.activity.getSnapshot().task; return task ? [{ session, task }] : []; }),
      feedback: sessions.flatMap(session => session.activity.getSnapshot().feedback) };
    this.listeners.forEach(listener => listener());
  }
  select(sessionId: string) { if (this.sessions.has(sessionId)) { this.selectedId = sessionId; this.refresh(); } }
  selectDefault() { this.selectedId = ''; this.refresh(); }
  selectForTab(source: BrowserSource, title = source.url) {
    const owner = [...this.sessions.values()].find(session => session.controller.getSnapshot().aiTab?.id === source.tabId);
    if (owner) { this.select(owner.id); return owner; }
    const session = this.getOrCreateForSource(source, title); this.select(session.id); return session;
  }
  getOrCreateForSource(source: BrowserSource, title = source.url): WebSession {
    const old = [...this.sessions.values()].find(session => session.source.tabId === source.tabId);
    if (old) {
      // Never retarget an inflight/retryable task to the document the user browsed to.
      const state = old.controller.getSnapshot();
      if (old.source.url === source.url || state.busy || state.canRetry) return old;
      this.disposeSession(old.id);
    }
    const id = crypto.randomUUID();
    const settings = structuredClone(this.store.getState().settings);
    let questions: QuestionItem[] = [];
    let answerMap: Record<string, AIAnswerResult> = {};
    let status: ReturnType<typeof appStore.getState>['status'] = 'idle';
    let statusText = '就绪';
    const activity = new AnswerActivityStore();
    const environment: Partial<Environment> = {
      ...this.overrides, sessionId: id, initialSource: { ...source }, activity,
      withConversation: (provider, action) => {
        // Landing pages may restore the same server conversation in multiple
        // tabs sharing login storage. Serialize this site's send/read section
        // until an independently identified conversation can be guaranteed.
        const next = (this.conversations.get(provider) || Promise.resolve()).catch(() => undefined).then(action);
        this.conversations.set(provider, next);
        void next.finally(() => { if (this.conversations.get(provider) === next) this.conversations.delete(provider); }).catch(() => undefined);
        return next;
      },
      store: {
        getState: () => {
          const global = this.store.getState();
          const external = this.active.size === 0;
          return { ...global, settings: { ...settings, allowRealPageAutomation: global.settings.allowRealPageAutomation }, questions, answerMap,
            currentQuestion: questions[0] || null, currentQuestionIndex: 0, currentAnswer: questions[0] ? answerMap[questions[0].hash] || null : null,
            batchRunning: external && global.batchRunning, liveRunning: global.liveRunning,
            status: external && ['calling_ai', 'executing'].includes(global.status) ? global.status : status, statusText };
        },
        setAutomationRunning: patch => { if (patch.batchRunning) this.acquireRun(id); else if (patch.batchRunning === false) this.releaseRun(id); },
        setStatus: (next, text) => { status = next; statusText = text; this.refresh(); },
        addLog: (level, text) => this.store.addLog(level, `[${title}] ${text}`),
        upsertQuestionBank: (question, answer) => this.store.upsertQuestionBank(toWebBankQuestion(question), answer, { exactContext: true }),
        setAnswerForQuestion: (question, answer) => { answerMap = { ...answerMap, [question.hash]: answer }; this.refresh(); }
      },
      onQuestions: items => { questions = items; const session = this.sessions.get(id); if (session) session.questions = items; this.refresh(); },
      browser: command => (this.overrides.browser || browserCommand)({ ...command, sessionId: id,
        ...(command.action === 'source' && !command.tabId ? { tabId: source.tabId } : {}) }),
      notify: this.overrides.notify || ((heading, body) => {
        const elApi = (window as any).electronAPI;
        if (elApi?.notify) void elApi.notify(heading, `${title}：${body}`)?.catch(() => undefined);
        else {
          void import('../platform').then(({ getPlatformAPI }) =>
            getPlatformAPI().notify(heading, `${title}：${body}`)).catch(() => undefined);
        }
      })
    };
    const controller = new WebAIController(environment);
    const session = { id, source: { ...source }, title, questions, controller, activity };
    this.sessions.set(id, session);
    controller.subscribe(() => this.refresh()); activity.subscribe(() => this.refresh()); this.refresh();
    return session;
  }
  acquireRun(id: string) {
    const first = !this.active.size; this.active.add(id);
    this.refresh();
    if (first) this.store.setAutomationRunning({ batchRunning: true });
  }
  releaseRun(id: string) {
    if (!this.active.delete(id)) return;
    webPageRequests.cancelSession(id);
    releaseQuestionMedia(id);
    if (!this.active.size) this.store.setAutomationRunning({ batchRunning: false });
    void (globalThis as any).window?.electronAPI?.releaseWebAITask?.(id)?.catch(() => undefined);
    this.refresh();
  }
  runningForTab(tabId: string) {
    return [...this.sessions.values()].find(session => this.active.has(session.id) &&
      (session.source.tabId === tabId || session.controller.getSnapshot().aiTab?.id === tabId));
  }
  disposeSession(id: string) {
    const session = this.sessions.get(id); if (!session) return;
    session.controller.stop(); this.releaseRun(id); webPageRequests.cancelSession(id); this.sessions.delete(id);
    if (this.selectedId === id) this.selectedId = ''; this.refresh();
  }
}

export const webAISessions = new WebAISessionManager();
