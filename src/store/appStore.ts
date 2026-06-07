import { useEffect, useState } from 'react';

export type AutomationAction = 'click' | 'fill' | 'select' | 'wait';
export type AutomationStatus = 'idle' | 'scanning' | 'planning' | 'awaiting_approval' | 'executing' | 'extracting_question' | 'calling_ai' | 'done' | 'error';
export type QuestionType = 'single' | 'multiple' | 'judgement' | 'completion' | 'essay' | 'unknown';

export interface PageControl {
  selector: string;
  tag: string;
  type?: string;
  text: string;
  value?: string;
  placeholder?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  controls: PageControl[];
  capturedAt: number;
}

export interface AutomationStep {
  id: string;
  action: AutomationAction;
  selector?: string;
  value?: string;
  label: string;
  required: boolean;
}

export interface AutomationPlan {
  id: string;
  goal: string;
  source: 'mock' | 'webview' | 'manual';
  steps: AutomationStep[];
  risk: 'low' | 'medium' | 'high';
  approved: boolean;
  createdAt: number;
  executedAt?: number;
  result?: string;
}

export interface QuestionItem {
  id: string;
  hash: string;
  question: string;
  options: string[];
  optionTargets?: QuestionOptionTarget[];
  type: QuestionType;
  source: 'mock' | 'webview' | 'manual';
  pageUrl?: string;
  pageTitle?: string;
  capturedAt: number;
  index?: number;
  selector?: string;
}

export interface QuestionOptionTarget {
  label: string;
  text: string;
  selector?: string;
  inputSelector?: string;
  clickSelector?: string;
}

export interface AIAnswerResult {
  questionHash: string;
  provider: string;
  model: string;
  answer: string;
  choiceLabels: string[];
  matchedOptions: string[];
  confidence: number;
  analysis: string;
  warnings: string[];
  createdAt: number;
}

export interface QuestionBankEntry {
  id: string;
  questionKey: string;
  question: string;
  options: string[];
  answer: AIAnswerResult;
  updatedAt: number;
  hits: number;
}

export interface ManualQuestionBankInput {
  question: string;
  options: string[];
  answer: string;
  analysis?: string;
  type?: QuestionType;
}

export interface AIProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AppLog {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

export interface AppSettings {
  allowRealPageAutomation: boolean;
  requireApprovalBeforeExecute: boolean;
  mockModeUrl: string;
  theme: 'dark' | 'light';
  providers: AIProviderConfig[];
  activeProviderId: string;
}

const defaultProviders: AIProviderConfig[] = [
  {
    id: 'dashscope',
    name: '阿里云 DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    model: 'qwen-plus'
  },
  {
    id: 'openai',
    name: 'OpenAI 兼容接口',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini'
  },
  {
    id: 'custom',
    name: '自定义兼容接口',
    baseUrl: 'https://example.com/v1',
    apiKey: '',
    model: 'custom-model'
  }
];

const defaultSettings: AppSettings = {
  allowRealPageAutomation: false,
  requireApprovalBeforeExecute: true,
  mockModeUrl: 'https://study-demo.studypilot.local/automation',
  theme: 'dark',
  providers: defaultProviders,
  activeProviderId: 'dashscope'
};

function normalizeSettings(input: Partial<AppSettings> | null): AppSettings {
  if (!input) return defaultSettings;
  return {
    ...defaultSettings,
    ...input,
    providers: input.providers?.length ? input.providers : defaultProviders,
    activeProviderId: input.activeProviderId || defaultSettings.activeProviderId
  };
}

const QUESTION_BANK_FUZZY_THRESHOLD = 0.8;
const QUESTION_BANK_FUZZY_MIN_KEY_LENGTH = 12;

class GlobalStore {
  private listeners = new Set<() => void>();

  private state = {
    settings: this.loadSettings(),
    status: 'idle' as AutomationStatus,
    statusText: '就绪',
    logs: [] as AppLog[],
    snapshot: null as PageSnapshot | null,
    currentPlan: null as AutomationPlan | null,
    questions: [] as QuestionItem[],
    currentQuestionIndex: 0,
    currentAnswer: null as AIAnswerResult | null,
    answerMap: {} as Record<string, AIAnswerResult>,
    questionBank: this.loadQuestionBank(),
    history: this.loadHistory(),
    answerHistory: this.loadAnswerHistory(),
    isElectron: typeof window !== 'undefined' && navigator.userAgent.toLowerCase().includes('electron')
  };

  constructor() {
    this.addLog('info', 'StudyPilot 已初始化。');
  }

  getState() {
    return {
      ...this.state,
      currentQuestion: this.state.questions[this.state.currentQuestionIndex] || null
    };
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }

  private loadSettings(): AppSettings {
    try {
      const saved = localStorage.getItem('studypilot_settings_v3');
      if (saved) return normalizeSettings(JSON.parse(saved));
      const legacy = localStorage.getItem('studypilot_settings_v2');
      if (legacy) return normalizeSettings(JSON.parse(legacy));
    } catch {
      // 使用默认设置。
    }
    return defaultSettings;
  }

  private saveSettings(settings: AppSettings) {
    localStorage.setItem('studypilot_settings_v3', JSON.stringify(settings));
  }

  private loadHistory(): AutomationPlan[] {
    try {
      const saved = localStorage.getItem('studypilot_automation_history');
      if (saved) return JSON.parse(saved);
    } catch {
      // 空历史即可。
    }
    return [];
  }

  private saveHistory(history: AutomationPlan[]) {
    localStorage.setItem('studypilot_automation_history', JSON.stringify(history));
  }

  private loadAnswerHistory(): { question: QuestionItem; answer: AIAnswerResult }[] {
    try {
      const saved = localStorage.getItem('studypilot_answer_history');
      if (saved) return JSON.parse(saved);
    } catch {
      // 空历史即可。
    }
    return [];
  }

  private saveAnswerHistory(history: { question: QuestionItem; answer: AIAnswerResult }[]) {
    localStorage.setItem('studypilot_answer_history', JSON.stringify(history));
  }

  private loadQuestionBank(): QuestionBankEntry[] {
    try {
      const saved = localStorage.getItem('studypilot_question_bank_v1');
      if (saved) return this.dedupeQuestionBank(JSON.parse(saved));
    } catch {
      // 空题库即可。
    }
    return [];
  }

  private saveQuestionBank(bank: QuestionBankEntry[]) {
    localStorage.setItem('studypilot_question_bank_v1', JSON.stringify(bank));
  }

  exportQuestionBank() {
    return this.state.questionBank.map((entry) => ({
      ...entry,
      answer: { ...entry.answer },
      options: [...entry.options]
    }));
  }

  private dedupeQuestionBank(bank: QuestionBankEntry[]) {
    const seen = new Set<string>();
    return (Array.isArray(bank) ? bank : []).filter((item) => {
      const key = item.questionKey || this.normalizeQuestionKey(item.question);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      item.questionKey = key;
      return true;
    });
  }

  normalizeQuestionKey(question: QuestionItem | string) {
    const text = typeof question === 'string' ? question : question.question;
    return text
      .replace(/\s+/g, '')
      .replace(/[，。,.、；;：:？！?!"'“”‘’【】\[\]（）()]/g, '')
      .toLowerCase()
      .slice(0, 500);
  }

  normalizeQuestionContentKey(question: QuestionItem) {
    const questionKey = this.normalizeQuestionKey(question);
    const optionKey = (question.options || [])
      .map((option) => this.normalizeQuestionKey(String(option).replace(/^\s*[A-D]\s*[.\s:：、。)]*/i, '')))
      .filter(Boolean)
      .sort()
      .join('|');
    return optionKey ? `${questionKey}::${optionKey}` : questionKey;
  }

  private textSimilarity(left: string, right: string) {
    if (left === right) return 1;
    if (left.length < QUESTION_BANK_FUZZY_MIN_KEY_LENGTH || right.length < QUESTION_BANK_FUZZY_MIN_KEY_LENGTH) return 0;

    const shorter = left.length <= right.length ? left : right;
    const longer = left.length > right.length ? left : right;
    const containmentScore = longer.includes(shorter) ? shorter.length / longer.length : 0;
    const lengthBalance = shorter.length / longer.length;
    const grams = new Map<string, number>();

    for (let index = 0; index < left.length - 1; index += 1) {
      const gram = left.slice(index, index + 2);
      grams.set(gram, (grams.get(gram) || 0) + 1);
    }

    let intersection = 0;
    for (let index = 0; index < right.length - 1; index += 1) {
      const gram = right.slice(index, index + 2);
      const count = grams.get(gram) || 0;
      if (count > 0) {
        grams.set(gram, count - 1);
        intersection += 1;
      }
    }

    const diceScore = (2 * intersection) / (left.length + right.length - 2);
    const previous = new Array(right.length + 1).fill(0);
    const current = new Array(right.length + 1).fill(0);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        current[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
          ? previous[rightIndex - 1] + 1
          : Math.max(previous[rightIndex], current[rightIndex - 1]);
      }
      for (let index = 0; index <= right.length; index += 1) {
        previous[index] = current[index];
        current[index] = 0;
      }
    }
    const sequenceScore = previous[right.length] / Math.max(left.length, right.length);
    return Math.max(containmentScore, diceScore * 0.55 + sequenceScore * 0.45) * lengthBalance;
  }

  private questionBankOptionsCompatible(question: QuestionItem, entry: QuestionBankEntry) {
    const questionOptionCount = (question.options || []).filter(Boolean).length;
    const entryOptionCount = (entry.options || []).filter(Boolean).length;
    if (questionOptionCount === 0 || entryOptionCount === 0) return true;
    return Math.abs(questionOptionCount - entryOptionCount) <= 1;
  }

  private findFuzzyQuestionBankEntry(question: QuestionItem) {
    const questionKey = this.normalizeQuestionKey(question);
    if (questionKey.length < QUESTION_BANK_FUZZY_MIN_KEY_LENGTH) return null;

    let best: { entry: QuestionBankEntry; score: number } | null = null;
    for (const entry of this.state.questionBank) {
      if (!this.questionBankOptionsCompatible(question, entry)) continue;
      const entryKey = this.normalizeQuestionKey(entry.question);
      const score = this.textSimilarity(questionKey, entryKey);
      if (!best || score > best.score) best = { entry, score };
    }

    return best && best.score >= QUESTION_BANK_FUZZY_THRESHOLD ? best : null;
  }

  findQuestionBankAnswer(question: QuestionItem) {
    const contentKey = this.normalizeQuestionContentKey(question);
    const legacyKey = this.normalizeQuestionKey(question);
    const exactEntry = this.state.questionBank.find((item) => item.questionKey === contentKey || item.questionKey === legacyKey);
    const fuzzyMatch = exactEntry ? null : this.findFuzzyQuestionBankEntry(question);
    const entry = exactEntry || fuzzyMatch?.entry;
    if (!entry) return null;
    entry.hits += 1;
    this.saveQuestionBank(this.state.questionBank);
    if (fuzzyMatch) {
      const percent = Math.round(fuzzyMatch.score * 100);
      this.addLog('success', `题库模糊命中，相似度 ${percent}%。`);
      return { ...entry.answer, questionHash: question.hash, provider: `本地题库·模糊 ${percent}%` };
    }
    return { ...entry.answer, questionHash: question.hash, provider: '本地题库' };
  }

  hasQuestionBankAnswer(question: QuestionItem) {
    const contentKey = this.normalizeQuestionContentKey(question);
    const legacyKey = this.normalizeQuestionKey(question);
    return this.state.questionBank.some((item) => item.questionKey === contentKey || item.questionKey === legacyKey) ||
      Boolean(this.findFuzzyQuestionBankEntry(question));
  }

  private hashText(text: string) {
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  private optionLabelFor(index: number) {
    return String.fromCharCode(65 + index);
  }

  private optionLabelFromText(option: string, index: number) {
    return option.match(/^\s*([A-Z])\s*[.\s:：、。)]/i)?.[1]?.toUpperCase() || this.optionLabelFor(index);
  }

  private normalizeManualAnswer(input: ManualQuestionBankInput, questionHash: string): AIAnswerResult {
    const answer = input.answer.trim();
    const labels = new Set<string>();
    Array.from(answer.matchAll(/(?:^|[^A-Za-z])([A-D])(?:[^A-Za-z]|$)/gi))
      .map((match) => match[1].toUpperCase())
      .forEach((label) => labels.add(label));

    const matchedOptions = input.options.filter((option, index) => {
      const label = this.optionLabelFromText(option, index);
      const optionBody = this.normalizeQuestionKey(option.replace(/^\s*[A-D]\s*[.\s:：、。)]*/i, ''));
      const answerBody = this.normalizeQuestionKey(answer);
      return labels.has(label) || (optionBody.length > 0 && answerBody.includes(optionBody));
    });

    return {
      questionHash,
      provider: '本地手动题库',
      model: 'manual',
      answer,
      choiceLabels: Array.from(labels),
      matchedOptions,
      confidence: 1,
      analysis: input.analysis?.trim() || '来自本地手动题库，未调用 AI。',
      warnings: [],
      createdAt: Date.now()
    };
  }

  addManualQuestionBankItems(items: ManualQuestionBankInput[]) {
    let added = 0;
    let skipped = 0;
    for (const item of items) {
      const question = item.question.trim();
      const answer = item.answer.trim();
      if (!question || !answer) {
        skipped += 1;
        continue;
      }
      const options = (item.options || []).map((option) => option.trim()).filter(Boolean);
      const hash = this.hashText(`${question}\n${options.join('\n')}`);
      const questionItem: QuestionItem = {
        id: `manual_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        hash,
        question,
        options,
        type: item.type || (options.length > 0 ? 'single' : 'completion'),
        source: 'manual',
        capturedAt: Date.now()
      };
      this.upsertQuestionBank(questionItem, this.normalizeManualAnswer({ ...item, question, options, answer }, hash));
      added += 1;
    }
    this.addLog(added > 0 ? 'success' : 'warn', `手动题库导入完成：新增/更新 ${added} 条，跳过 ${skipped} 条。`);
    return { added, skipped };
  }

  importQuestionBank(entries: unknown[]) {
    let imported = 0;
    let skipped = 0;
    const nextEntries = [...this.state.questionBank];
    for (const raw of entries) {
      const item = raw as Partial<QuestionBankEntry>;
      if (!item || typeof item !== 'object' || !item.question || !item.answer?.answer) {
        skipped += 1;
        continue;
      }
      const question = String(item.question).trim();
      const options = Array.isArray(item.options) ? item.options.map((option) => String(option).trim()).filter(Boolean) : [];
      const key = item.questionKey || this.normalizeQuestionContentKey({
        id: 'import',
        hash: '',
        question,
        options,
        type: options.length > 0 ? 'single' : 'completion',
        source: 'manual',
        capturedAt: Date.now()
      });
      const entry: QuestionBankEntry = {
        id: item.id || Math.random().toString(36).slice(2),
        questionKey: key,
        question,
        options,
        answer: {
          questionHash: item.answer.questionHash || this.hashText(`${question}\n${options.join('\n')}`),
          provider: item.answer.provider || '本地导入题库',
          model: item.answer.model || 'import',
          answer: String(item.answer.answer),
          choiceLabels: Array.isArray(item.answer.choiceLabels) ? item.answer.choiceLabels.map(String) : [],
          matchedOptions: Array.isArray(item.answer.matchedOptions) ? item.answer.matchedOptions.map(String) : [],
          confidence: typeof item.answer.confidence === 'number' ? item.answer.confidence : 1,
          analysis: item.answer.analysis || '来自本地导入题库，未调用 AI。',
          warnings: Array.isArray(item.answer.warnings) ? item.answer.warnings.map(String) : [],
          createdAt: typeof item.answer.createdAt === 'number' ? item.answer.createdAt : Date.now()
        },
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
        hits: typeof item.hits === 'number' ? item.hits : 0
      };
      const existingIndex = nextEntries.findIndex((entryItem) => entryItem.questionKey === entry.questionKey);
      if (existingIndex >= 0) nextEntries[existingIndex] = entry;
      else nextEntries.unshift(entry);
      imported += 1;
    }
    this.state.questionBank = this.dedupeQuestionBank(nextEntries).slice(0, 1000);
    this.saveQuestionBank(this.state.questionBank);
    this.addLog(imported > 0 ? 'success' : 'warn', `题库文件导入完成：新增/更新 ${imported} 条，跳过 ${skipped} 条。`);
    this.emit();
    return { imported, skipped };
  }

  upsertQuestionBank(question: QuestionItem, answer: AIAnswerResult) {
    const key = this.normalizeQuestionContentKey(question);
    const legacyKey = this.normalizeQuestionKey(question);
    const normalizedAnswer = { ...answer, questionHash: question.hash };
    const existing = this.state.questionBank.find((item) => item.questionKey === key || item.questionKey === legacyKey);
    if (existing) {
      existing.questionKey = key;
      existing.question = question.question;
      existing.options = question.options;
      existing.answer = normalizedAnswer;
      existing.updatedAt = Date.now();
    } else {
      this.state.questionBank = [{
        id: Math.random().toString(36).slice(2),
        questionKey: key,
        question: question.question,
        options: question.options,
        answer: normalizedAnswer,
        updatedAt: Date.now(),
        hits: 0
      }, ...this.state.questionBank].slice(0, 1000);
    }
    const seen = new Set<string>();
    this.state.questionBank = this.state.questionBank.filter((item) => {
      const itemKey = item.questionKey || this.normalizeQuestionKey(item.question);
      if (seen.has(itemKey)) return false;
      seen.add(itemKey);
      return true;
    });
    this.saveQuestionBank(this.state.questionBank);
    this.emit();
  }

  updateSettings(updates: Partial<AppSettings>) {
    this.state.settings = normalizeSettings({ ...this.state.settings, ...updates });
    this.saveSettings(this.state.settings);
    this.addLog('info', '设置已更新。');
    this.emit();
  }

  updateProvider(providerId: string, updates: Partial<AIProviderConfig>) {
    this.state.settings.providers = this.state.settings.providers.map((provider) =>
      provider.id === providerId ? { ...provider, ...updates } : provider
    );
    this.saveSettings(this.state.settings);
    this.addLog('info', `AI 服务配置已更新：${providerId}`);
    this.emit();
  }

  setStatus(status: AutomationStatus, text: string) {
    this.state.status = status;
    this.state.statusText = text;
    this.addLog(status === 'error' ? 'error' : status === 'done' ? 'success' : 'info', text);
    this.emit();
  }

  setSnapshot(snapshot: PageSnapshot | null) {
    this.state.snapshot = snapshot;
    if (snapshot) this.addLog('success', `已从页面捕获 ${snapshot.controls.length} 个可见控件。`);
    this.emit();
  }

  setPlan(plan: AutomationPlan | null) {
    this.state.currentPlan = plan;
    if (plan) this.addLog('info', `已生成包含 ${plan.steps.length} 个步骤的自动化计划。`);
    this.emit();
  }

  approvePlan(approved: boolean) {
    if (!this.state.currentPlan) return;
    this.state.currentPlan = { ...this.state.currentPlan, approved };
    this.addLog(approved ? 'success' : 'warn', approved ? '自动化计划已批准。' : '已取消计划批准。');
    this.emit();
  }

  completePlan(result: string) {
    if (!this.state.currentPlan) return;
    const completed = { ...this.state.currentPlan, executedAt: Date.now(), result };
    this.state.currentPlan = completed;
    this.state.history = [completed, ...this.state.history].slice(0, 50);
    this.saveHistory(this.state.history);
    this.setStatus('done', result);
    this.emit();
  }

  setQuestions(questions: QuestionItem[], selectedIndex = 0) {
    this.state.questions = questions;
    this.state.currentQuestionIndex = Math.max(0, Math.min(selectedIndex, Math.max(questions.length - 1, 0)));
    this.state.currentAnswer = questions[this.state.currentQuestionIndex]
      ? this.state.answerMap[questions[this.state.currentQuestionIndex].hash] || null
      : null;
    if (questions.length > 0) this.addLog('success', `已抓取 ${questions.length} 道题。`);
    this.emit();
  }

  setCurrentQuestionIndex(index: number) {
    this.state.currentQuestionIndex = Math.max(0, Math.min(index, Math.max(this.state.questions.length - 1, 0)));
    const question = this.state.questions[this.state.currentQuestionIndex];
    this.state.currentAnswer = question ? this.state.answerMap[question.hash] || null : null;
    this.emit();
  }

  setCurrentQuestion(question: QuestionItem | null) {
    this.setQuestions(question ? [question] : [], 0);
  }

  setCurrentAnswer(answer: AIAnswerResult | null) {
    this.state.currentAnswer = answer;
    const question = this.state.questions[this.state.currentQuestionIndex];
    if (answer && question) {
      this.state.answerMap = { ...this.state.answerMap, [answer.questionHash]: answer };
      const entry = { question, answer };
      this.state.answerHistory = [entry, ...this.state.answerHistory.filter((item) => item.question.hash !== entry.question.hash)].slice(0, 120);
      this.saveAnswerHistory(this.state.answerHistory);
      this.addLog('success', `AI 已返回第 ${question.index || this.state.currentQuestionIndex + 1} 题参考答案，置信度 ${(answer.confidence * 100).toFixed(0)}%。`);
    }
    this.emit();
  }

  clearHistory() {
    this.state.history = [];
    this.saveHistory([]);
    this.addLog('info', '自动化历史已清空。');
    this.emit();
  }

  clearAnswerHistory() {
    this.state.answerHistory = [];
    this.state.answerMap = {};
    this.saveAnswerHistory([]);
    this.addLog('info', '答案历史已清空。');
    this.emit();
  }

  clearQuestionBank() {
    this.state.questionBank = [];
    this.saveQuestionBank([]);
    this.addLog('info', '题库已清空。');
    this.emit();
  }

  addLog(level: AppLog['level'], message: string) {
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const log: AppLog = {
      id: Math.random().toString(36).slice(2),
      timestamp,
      level,
      message
    };
    this.state.logs = [log, ...this.state.logs].slice(0, 120);
    this.emit();
  }
}

export const appStore = new GlobalStore();

export function useAppStore() {
  const [state, setState] = useState(appStore.getState());

  useEffect(() => {
    return appStore.subscribe(() => {
      setState({ ...appStore.getState() });
    });
  }, []);

  return state;
}
