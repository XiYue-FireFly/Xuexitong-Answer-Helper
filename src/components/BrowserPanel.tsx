import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Compass,
  Copy,
  Maximize2,
  Minimize2,
  Plus,
  RefreshCw,
  Shield,
  X
} from 'lucide-react';
import { appStore, AutomationPlan, AutomationStep, PageSnapshot, QuestionItem, useAppStore } from '../store/appStore';

const WEBVIEW_PARTITION = 'persist:studypilot-sites';
const DEFAULT_BROWSER_URL = 'https://www.baidu.com';
const BLOCKED_INTERNAL_BROWSER_TAB_URL = /(addStudentWorkNewWeb|\/mooc-ans\/work\/(?:addStudentWorkNewWeb|save|submit)|\/work\/(?:addStudentWorkNewWeb|save|submit)|(?:submit|save)StudentWork|submitWork|saveWork)/i;

type WebviewElement = HTMLElement & {
  loadURL?: (url: string) => Promise<void>;
  getURL?: () => string;
  getTitle?: () => string;
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  isLoading?: () => boolean;
  stop?: () => void;
  reload?: () => void;
  goBack?: () => void;
  goForward?: () => void;
  send?: (channel: string, payload?: any) => void;
};

interface BrowserTab {
  id: string;
  initialUrl: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

type TabContextMenuAction = 'refresh' | 'copy' | 'close' | 'closeOthers' | 'closeRight';

type TabContextMenuState = {
  tabId: string;
  x: number;
  y: number;
};

const mockQuestions: QuestionItem[] = [
  {
    id: 'mock_q_1',
    hash: 'mock_hash_1',
    index: 1,
    question: '以下哪一项最能说明网页自动化执行前需要人工批准的原因？',
    options: ['A. 可以减少误操作和未授权操作的风险', 'B. 可以让页面加载速度变慢', 'C. 可以隐藏所有执行日志', 'D. 可以跳过用户设置'],
    type: 'single',
    source: 'mock',
    pageUrl: 'https://study-demo.studypilot.local/automation',
    pageTitle: '授权学习页面演示',
    capturedAt: Date.now()
  },
  {
    id: 'mock_q_2',
    hash: 'mock_hash_2',
    index: 2,
    question: '在多题页面中，题目抓取器最应该优先识别什么？',
    options: ['A. 题号边界和题型标记', 'B. 页面背景颜色', 'C. 浏览器窗口大小', 'D. 字体名称'],
    type: 'single',
    source: 'mock',
    pageUrl: 'https://study-demo.studypilot.local/automation',
    pageTitle: '授权学习页面演示',
    capturedAt: Date.now()
  },
  {
    id: 'mock_q_3',
    hash: 'mock_hash_3',
    index: 3,
    question: '答案显示按题目拆分的主要好处是什么？',
    options: ['A. 避免多题答案混在一起', 'B. 删除题目选项', 'C. 阻止用户查看解析', 'D. 关闭历史记录'],
    type: 'single',
    source: 'mock',
    pageUrl: 'https://study-demo.studypilot.local/automation',
    pageTitle: '授权学习页面演示',
    capturedAt: Date.now()
  }
];

const mockControls = [
  { selector: '[data-sp-control="fullName"]', tag: 'input', type: 'text', text: '姓名', placeholder: '请输入姓名' },
  { selector: '[data-sp-control="email"]', tag: 'input', type: 'email', text: '邮箱', placeholder: '请输入邮箱' },
  { selector: '[data-sp-control="topic"]', tag: 'select', text: '主题' },
  { selector: '[data-sp-control="updates"]', tag: 'input', type: 'checkbox', text: '接收流程更新' },
  { selector: '[data-sp-control="notes"]', tag: 'textarea', text: '备注', placeholder: '希望助手记住什么？' },
  { selector: '[data-sp-control="submit"]', tag: 'button', text: '提交请求' }
];

const statusLabels: Record<string, string> = {
  idle: '空闲',
  scanning: '扫描中',
  planning: '计划中',
  awaiting_approval: '待批准',
  executing: '执行中',
  extracting_question: '抓题中',
  calling_ai: 'AI 解析中',
  done: '完成',
  error: '错误'
};

function makeStep(action: AutomationStep['action'], label: string, selector?: string, value?: string): AutomationStep {
  return { id: Math.random().toString(36).slice(2), action, selector, value, label, required: true };
}

function createPlan(goal: string, snapshot: PageSnapshot, source: AutomationPlan['source']): AutomationPlan {
  const normalizedGoal = goal.trim() || '使用安全的演示信息填写当前表单并提交。';
  const controls = snapshot.controls;
  const find = (...needles: string[]) => controls.find((control) => {
    const haystack = `${control.selector} ${control.text} ${control.placeholder || ''} ${control.type || ''}`.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  });

  const steps: AutomationStep[] = [];
  const name = find('name', '姓名');
  const email = find('email', '邮箱');
  const topic = find('topic', 'select', '主题');
  const notes = find('note', 'message', 'textarea', '备注');
  const updates = find('update', 'checkbox', '更新');
  const submit = find('submit', 'save', 'continue', 'button', '提交');

  if (name) steps.push(makeStep('fill', `填写${name.text || '姓名字段'}`, name.selector, '张三'));
  if (email) steps.push(makeStep('fill', `填写${email.text || '邮箱字段'}`, email.selector, 'zhangsan@example.com'));
  if (topic) steps.push(makeStep('select', `选择${topic.text || '主题'}`, topic.selector, 'automation'));
  if (updates) steps.push(makeStep('click', `切换${updates.text || '复选框'}`, updates.selector));
  if (notes) steps.push(makeStep('fill', `填写${notes.text || '备注'}`, notes.selector, normalizedGoal));
  if (submit) steps.push(makeStep('click', `点击${submit.text || '提交按钮'}`, submit.selector));
  if (steps.length === 0) steps.push(makeStep('wait', '未找到明显控件，等待人工复核。'));

  return {
    id: Math.random().toString(36).slice(2),
    goal: normalizedGoal,
    source,
    steps,
    risk: source === 'webview' ? 'medium' : 'low',
    approved: false,
    createdAt: Date.now()
  };
}

function friendlyTitle(targetUrl: string) {
  try {
    const parsed = new URL(targetUrl);
    return parsed.hostname || targetUrl;
  } catch {
    return targetUrl || '新标签页';
  }
}

function createBrowserTab(targetUrl: string, title?: string): BrowserTab {
  return {
    id: `tab_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    initialUrl: targetUrl,
    url: targetUrl,
    title: title || friendlyTitle(targetUrl),
    loading: false,
    canGoBack: false,
    canGoForward: false
  };
}

function normalizePageUrl(raw: string, baseUrl: string) {
  const value = String(raw || '').trim();
  if (!value || value === 'about:blank' || /^javascript:/i.test(value)) return '';
  if (/^(mailto|tel):/i.test(value)) return value;
  try {
    return new URL(value, baseUrl || DEFAULT_BROWSER_URL).toString();
  } catch {
    return '';
  }
}

function normalizeAddressInput(raw: string) {
  const value = raw.trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(value) || /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(value)) {
    return `http://${value}`;
  }
  if (/^[\w.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(value)) return `https://${value}`;
  return `https://www.baidu.com/s?wd=${encodeURIComponent(value)}`;
}

function shouldBlockInternalBrowserTab(targetUrl: string) {
  return BLOCKED_INTERNAL_BROWSER_TAB_URL.test(String(targetUrl || ''));
}

function isExamStartUrl(targetUrl: string) {
  try {
    const parsed = new URL(targetUrl);
    return /\/exam-ans\/exam\/test\/reVersionTestStartNew/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function shouldCloseOpenerAfterOpen(targetUrl: string, openerUrl?: string) {
  if (!openerUrl || !isExamStartUrl(targetUrl)) return false;
  try {
    const opener = new URL(openerUrl);
    return /\/exam-ans\/exam\/test\/examcode\/examnotes/i.test(opener.pathname) ||
      /\/exam-ans\/exam\/test\/reVersionTestStartNew/i.test(opener.pathname);
  } catch {
    return false;
  }
}

function safeWebviewRead<T>(reader: () => T | undefined, fallback: T) {
  try {
    return reader() ?? fallback;
  } catch {
    return fallback;
  }
}

function safeWebviewRun(action: () => void, message: string) {
  try {
    action();
    return true;
  } catch (error: any) {
    appStore.addLog('warn', `${message}：${error?.message || 'WebView 尚未就绪'}`);
    return false;
  }
}

interface BrowserTabViewProps {
  tab: BrowserTab;
  active: boolean;
  preloadPath: string;
  registerWebview: (tabId: string, webview: WebviewElement | null) => void;
  onStateChange: (tabId: string, patch: Partial<BrowserTab>) => void;
  onIpcMessage: (event: any, tabId: string) => void;
}

function BrowserTabView({ tab, active, preloadPath, registerWebview, onStateChange, onIpcMessage }: BrowserTabViewProps) {
  const ref = useRef<WebviewElement | null>(null);

  useEffect(() => {
    const webview = ref.current;
    if (!webview) return undefined;
    webview.setAttribute('allowpopups', 'true');
    registerWebview(tab.id, webview);
    let ready = false;

    const syncState = (patch: Partial<BrowserTab> = {}) => {
      if (!ready) {
        onStateChange(tab.id, patch);
        return;
      }
      const activeUrl = safeWebviewRead(() => webview.getURL?.(), patch.url || tab.url);
      const activeTitle = safeWebviewRead(() => webview.getTitle?.(), patch.title || friendlyTitle(activeUrl));
      onStateChange(tab.id, {
        url: activeUrl,
        title: activeTitle,
        loading: safeWebviewRead(() => webview.isLoading?.(), false),
        canGoBack: safeWebviewRead(() => webview.canGoBack?.(), false),
        canGoForward: safeWebviewRead(() => webview.canGoForward?.(), false),
        ...patch
      });
    };

    const handleLoadStart = () => syncState({ loading: true });
    const handleLoadStop = () => syncState({ loading: false });
    const handleFailLoad = (event: any) => {
      syncState({ loading: false });
      if (event?.errorCode === -3) return;
      appStore.addLog('warn', `页面加载失败：${event?.errorDescription || event?.errorCode || '未知错误'}`);
    };
    const handleNavigate = () => syncState();
    const handleTitle = (event: any) => {
      const fallbackUrl = safeWebviewRead(() => webview.getURL?.(), tab.url);
      syncState({ title: event.title || safeWebviewRead(() => webview.getTitle?.(), friendlyTitle(fallbackUrl)) });
    };
    const handleIpc = (event: any) => onIpcMessage(event, tab.id);
    const handleDomReady = () => {
      ready = true;
      syncState();
    };

    webview.addEventListener('did-start-loading', handleLoadStart);
    webview.addEventListener('did-stop-loading', handleLoadStop);
    webview.addEventListener('did-fail-load', handleFailLoad);
    webview.addEventListener('did-navigate', handleNavigate);
    webview.addEventListener('did-navigate-in-page', handleNavigate);
    webview.addEventListener('page-title-updated', handleTitle);
    webview.addEventListener('dom-ready', handleDomReady);
    webview.addEventListener('ipc-message', handleIpc);

    return () => {
      webview.removeEventListener('did-start-loading', handleLoadStart);
      webview.removeEventListener('did-stop-loading', handleLoadStop);
      webview.removeEventListener('did-fail-load', handleFailLoad);
      webview.removeEventListener('did-navigate', handleNavigate);
      webview.removeEventListener('did-navigate-in-page', handleNavigate);
      webview.removeEventListener('page-title-updated', handleTitle);
      webview.removeEventListener('dom-ready', handleDomReady);
      webview.removeEventListener('ipc-message', handleIpc);
      registerWebview(tab.id, null);
    };
  }, [onIpcMessage, onStateChange, preloadPath, registerWebview, tab.id]);

  return (
    <webview
      ref={ref as any}
      src={tab.initialUrl}
      preload={preloadPath}
      partition={WEBVIEW_PARTITION}
      webpreferences="contextIsolation=yes, nodeIntegration=no, sandbox=no, javascript=yes, webSecurity=yes"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        border: 'none',
        opacity: active ? 1 : 0,
        pointerEvents: active ? 'auto' : 'none',
        visibility: active ? 'visible' : 'hidden',
        zIndex: active ? 2 : 1
      }}
    />
  );
}

export function BrowserPanel() {
  const { settings, status, snapshot, currentPlan, isElectron } = useAppStore();
  const initialBrowserUrl = settings.mockModeUrl.includes('study-demo.studypilot.local') ? DEFAULT_BROWSER_URL : settings.mockModeUrl;
  const initialTabRef = useRef<BrowserTab | null>(null);
  if (!initialTabRef.current) initialTabRef.current = createBrowserTab(initialBrowserUrl, '首页');

  const [url, setUrl] = useState(initialBrowserUrl);
  const [addressText, setAddressText] = useState(initialBrowserUrl);
  const [history, setHistory] = useState([initialBrowserUrl]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [tabs, setTabs] = useState<BrowserTab[]>(() => [initialTabRef.current as BrowserTab]);
  const [activeTabId, setActiveTabId] = useState(() => (initialTabRef.current as BrowserTab).id);
  const [preloadPath, setPreloadPath] = useState('');
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  const [goal, setGoal] = useState('填写请求表单，勾选接收更新，然后提交。');
  const [mockValues, setMockValues] = useState<Record<string, string | boolean>>({});
  const [mockSubmitted, setMockSubmitted] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState | null>(null);

  const webviewRefs = useRef<Record<string, WebviewElement>>({});
  const applyAnswerResolverRef = useRef<((result: any) => void) | null>(null);
  const extractQuestionResolverRef = useRef<((result: any) => void) | null>(null);
  const examNextResolverRef = useRef<((result: any) => void) | null>(null);
  const recentOpenRef = useRef<Record<string, number>>({});
  const tabsRef = useRef(tabs);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0];
  const activeSource: AutomationPlan['source'] = isElectron && settings.allowRealPageAutomation ? 'webview' : 'mock';
  const canUseRealWebview = activeSource === 'webview';
  const isLoadingPage = canUseRealWebview ? Boolean(activeTab?.loading) : false;
  const backDisabled = canUseRealWebview ? !activeTab?.canGoBack : historyIndex === 0;
  const forwardDisabled = canUseRealWebview ? !activeTab?.canGoForward : historyIndex === history.length - 1;
  const currentBrowserUrl = canUseRealWebview ? activeTab?.url || initialBrowserUrl : url;

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    if (!tabContextMenu) return undefined;
    const closeMenu = () => setTabContextMenu(null);
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    window.addEventListener('click', closeMenu);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('keydown', handleKey);
    };
  }, [tabContextMenu]);

  const activeTabRef = useRef<BrowserTab | undefined>(activeTab);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  const statusBadge = useMemo(() => {
    if (status === 'executing' || status === 'calling_ai') return 'badge-warning';
    if (status === 'done') return 'badge-success';
    if (status === 'error') return 'badge-danger';
    return 'badge-primary';
  }, [status]);

  const registerWebview = useCallback((tabId: string, webview: WebviewElement | null) => {
    if (webview) webviewRefs.current[tabId] = webview;
    else delete webviewRefs.current[tabId];
  }, []);

  const handleTabStateChange = useCallback((tabId: string, patch: Partial<BrowserTab>) => {
    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== tabId) return tab;
      const next = { ...tab, ...patch };
      const changed = Object.keys(patch).some((key) => (tab as any)[key] !== (next as any)[key]);
      return changed ? next : tab;
    }));
  }, []);

  const getActiveWebview = useCallback(() => webviewRefs.current[activeTabId], [activeTabId]);

  const openBrowserTab = useCallback((rawUrl: string, options: { title?: string; openerTabId?: string } = {}) => {
    const openerUrl = options.openerTabId
      ? webviewRefs.current[options.openerTabId]?.getURL?.() || tabsRef.current.find((tab) => tab.id === options.openerTabId)?.url
      : activeTabRef.current?.url;
    const targetUrl = normalizePageUrl(rawUrl, openerUrl || initialBrowserUrl);
    if (!targetUrl) return;
    if (shouldBlockInternalBrowserTab(targetUrl)) return;
    if (/^(mailto|tel):/i.test(targetUrl)) {
      appStore.addLog('info', `外部链接由系统处理：${targetUrl}`);
      return;
    }

    const now = Date.now();
    if (recentOpenRef.current[targetUrl] && now - recentOpenRef.current[targetUrl] < 800) {
      const existing = tabsRef.current.find((tab) => tab.url === targetUrl || tab.initialUrl === targetUrl);
      if (existing) setActiveTabId(existing.id);
      return;
    }
    recentOpenRef.current[targetUrl] = now;

    const tab = createBrowserTab(targetUrl, options.title || friendlyTitle(targetUrl));
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    setAddressText(targetUrl);
    if (options.openerTabId && shouldCloseOpenerAfterOpen(targetUrl, openerUrl)) {
      window.setTimeout(() => {
        const latestTabs = tabsRef.current;
        if (latestTabs.length <= 1) return;
        const opener = latestTabs.find((item) => item.id === options.openerTabId);
        const opened = latestTabs.find((item) => item.id === tab.id);
        if (!opener || !opened) return;
        delete webviewRefs.current[opener.id];
        setTabs((prev) => prev.filter((item) => item.id !== opener.id));
        if (activeTabRef.current?.id === opener.id) {
          setActiveTabId(opened.id);
          setAddressText(opened.url);
        }
      }, 1200);
    }
    appStore.addLog('info', `已在新标签页打开：${targetUrl}`);
  }, [initialBrowserUrl]);

  const handleWebviewIpc = useCallback((event: any, tabId: string) => {
    if (event.channel === 'studypilot:open-tab') {
      const payload = event.args?.[0] || {};
      const targetUrl = typeof payload === 'string' ? payload : payload.url;
      openBrowserTab(targetUrl, { title: payload.title, openerTabId: tabId });
      return;
    }

    if (event.channel === 'studypilot:error-log') {
      const payload = event.args?.[0] || {};
      (window as any).electronAPI?.recordError?.({
        ...payload,
        source: payload.source || 'webview:error',
        details: {
          ...(payload.details || {}),
          tabId,
          tabUrl: tabsRef.current.find((tab) => tab.id === tabId)?.url
        }
      });
      return;
    }

    if (event.channel === 'studypilot:click-debug') {
      const payload = event.args?.[0] || {};
      (window as any).electronAPI?.recordError?.({
        ...payload,
        source: payload.source || 'webview:click-debug',
        level: payload.level || 'info',
        message: payload.message || 'WebView click debug',
        details: {
          ...(payload.details || {}),
          target: payload.target,
          clickable: payload.clickable,
          ancestors: payload.ancestors,
          candidates: payload.candidates,
          courseParams: payload.courseParams,
          selectedUrl: payload.selectedUrl,
          client: payload.client,
          tabId,
          tabUrl: tabsRef.current.find((tab) => tab.id === tabId)?.url
        }
      });
      return;
    }

    if (event.channel === 'studypilot:snapshot-result') {
      const result = event.args[0];
      if (result?.success) {
        appStore.setSnapshot(result.data);
        appStore.setStatus('planning', '页面扫描完成。下一步可以生成自动化计划。');
      } else {
        appStore.setStatus('error', result?.error || '页面扫描失败。');
      }
    }

    if (event.channel === 'studypilot:question-result') {
      const result = event.args[0];
      extractQuestionResolverRef.current?.(result);
      extractQuestionResolverRef.current = null;
      if (result?.success) {
        const questions = Array.isArray(result.questions) && result.questions.length > 0 ? result.questions : [result.data];
        appStore.setQuestions(questions);
        appStore.setStatus('done', `题目抓取完成，共 ${questions.length} 题。`);
      } else {
        appStore.setStatus('error', result?.error || '题目抓取失败。');
      }
    }

    if (event.channel === 'studypilot:exam-next-question-result') {
      const result = event.args[0];
      examNextResolverRef.current?.(result);
      examNextResolverRef.current = null;
    }

    if (event.channel === 'studypilot:apply-answer-result') {
      const result = event.args[0];
      applyAnswerResolverRef.current?.(result);
      applyAnswerResolverRef.current = null;
      if (result?.success) appStore.setStatus('done', result.message || '答案已填入当前页面。');
      else appStore.setStatus('error', result?.error || '答案填入失败。');
    }

    if (event.channel === 'studypilot:chapter-learning-result') {
      const result = event.args[0];
      if (result?.success) {
        appStore.setChapterLearning(result.data);
        if (result.data?.running) appStore.setStatus('learning', result.data.lastMessage || '章节学习辅助运行中。');
      } else {
        appStore.setStatus('error', result?.error || '章节学习辅助执行失败。');
      }
    }

    if (event.channel === 'studypilot:chapter-open-next') {
      const payload = event.args?.[0] || {};
      const targetUrl = payload.url;
      if (targetUrl) {
        openBrowserTab(targetUrl, { title: payload.title || '下一章节', openerTabId: tabId });
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('studypilot:chapter-learning-action', {
            detail: { action: 'start', options: payload.options || {} }
          }));
        }, 2200);
      }
    }

    if (event.channel === 'studypilot:execute-result') {
      const result = event.args[0];
      if (result?.success) appStore.completePlan(result.message || '已在当前页面完成自动化操作。');
      else appStore.setStatus('error', result?.error || '自动化执行失败。');
    }
  }, [openBrowserTab]);

  const loadWebviewUrl = useCallback((targetUrl: string, stopCurrent = false, tabId = activeTabId) => {
    const webview = webviewRefs.current[tabId];
    if (!webview) return;
    if (safeWebviewRead(() => webview.getURL?.(), '') === targetUrl) return;
    if (stopCurrent && safeWebviewRead(() => webview.isLoading?.(), false)) {
      safeWebviewRun(() => webview.stop?.(), '停止当前页面失败');
    }
    handleTabStateChange(tabId, { url: targetUrl, title: friendlyTitle(targetUrl), loading: true });
    const result = safeWebviewRead(() => webview.loadURL?.(targetUrl), undefined as Promise<void> | undefined);
    if (result?.catch) {
      result.catch((error: any) => {
        if (error?.code === 'ERR_ABORTED' || error?.errno === -3) return;
        appStore.addLog('warn', `页面跳转失败：${error?.message || targetUrl}`);
      });
    }
  }, [activeTabId, handleTabStateChange]);

  useEffect(() => {
    if (isElectron && (window as any).electronAPI) {
      (window as any).electronAPI.getWebviewPreloadPath()
        .then((path: string) => setPreloadPath(path))
        .catch((error: Error) => appStore.addLog('error', `加载 WebView 预加载脚本失败：${error.message}`));
    }
  }, [isElectron]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setBrowserFullscreen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (canUseRealWebview && activeTab?.url) setAddressText(activeTab.url);
  }, [activeTab?.url, activeTabId, canUseRealWebview]);

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!canUseRealWebview || !api?.onOpenBrowserTab) return undefined;
    return api.onOpenBrowserTab((payload: any) => {
      const targetUrl = typeof payload === 'string' ? payload : payload?.url;
      openBrowserTab(targetUrl, { title: payload?.title });
    });
  }, [canUseRealWebview, openBrowserTab]);

  useEffect(() => {
    const handleExtractQuestionRequest = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      const onComplete = typeof detail.onComplete === 'function' ? detail.onComplete : null;
      const webview = getActiveWebview();
      if (!canUseRealWebview || !webview) {
        onComplete?.({ success: false, error: '请先在设置中启用真实 WebView。' });
        return;
      }
      const timeoutId = window.setTimeout(() => {
        if (extractQuestionResolverRef.current) {
          extractQuestionResolverRef.current = null;
          onComplete?.({ success: false, error: '等待题目抓取结果超时。' });
        }
      }, 8000);
      extractQuestionResolverRef.current = (result: any) => {
        window.clearTimeout(timeoutId);
        onComplete?.(result);
      };
      safeWebviewRun(() => webview.send?.('studypilot:extract-question'), '发送题目抓取请求失败');
    };

    const handleExamNextQuestion = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      const onComplete = typeof detail.onComplete === 'function' ? detail.onComplete : null;
      const webview = getActiveWebview();
      if (!canUseRealWebview || !webview) {
        onComplete?.({ success: false, error: '请先在设置中启用真实 WebView。' });
        return;
      }
      const timeoutId = window.setTimeout(() => {
        if (examNextResolverRef.current) {
          examNextResolverRef.current = null;
          onComplete?.({ success: false, error: '等待下一题切换结果超时。' });
        }
      }, 10000);
      examNextResolverRef.current = (result: any) => {
        window.clearTimeout(timeoutId);
        onComplete?.(result);
      };
      safeWebviewRun(() => webview.send?.('studypilot:exam-next-question'), '发送下一题请求失败');
    };

    window.addEventListener('studypilot:extract-question-request', handleExtractQuestionRequest);
    window.addEventListener('studypilot:exam-next-question', handleExamNextQuestion);
    return () => {
      window.removeEventListener('studypilot:extract-question-request', handleExtractQuestionRequest);
      window.removeEventListener('studypilot:exam-next-question', handleExamNextQuestion);
    };
  }, [canUseRealWebview, getActiveWebview]);

  useEffect(() => {
    const handleApplyAnswers = async (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const items = detail?.items || [];
      const onComplete = typeof detail?.onComplete === 'function' ? detail.onComplete : null;
      const webview = getActiveWebview();
      const waitForApplyResult = () => new Promise<any>((resolve, reject) => {
        let resolver: ((result: any) => void) | null = null;
        const timeoutId = window.setTimeout(() => {
          if (applyAnswerResolverRef.current === resolver) applyAnswerResolverRef.current = null;
          reject(new Error('等待页面选中答案超时'));
        }, 8000);
        resolver = (result: any) => {
          window.clearTimeout(timeoutId);
          resolve(result);
        };
        applyAnswerResolverRef.current = resolver;
      });

      if (!canUseRealWebview || !webview) {
        appStore.setStatus('error', '请先在设置中启用真实 WebView，再填入网页答案。');
        onComplete?.({ success: false, error: '请先在设置中启用真实 WebView，再填入网页答案。' });
        return;
      }
      if (!Array.isArray(items) || items.length === 0) {
        appStore.setStatus('error', '没有可填入网页的答案。');
        onComplete?.({ success: false, error: '没有可填入网页的答案。' });
        return;
      }

      appStore.setStatus('executing', `正在向当前页面填入 ${items.length} 道题的答案。`);
      let finalResult: any = { success: true, message: `已填入 ${items.length} 道题。` };
      for (const item of items) {
        const resultPromise = waitForApplyResult();
        const sent = safeWebviewRun(() => webview.send?.('studypilot:apply-answer', {
          questionHash: item.question.hash,
          answer: item.answer.answer,
          choiceLabels: item.answer.choiceLabels,
          matchedOptions: item.answer.matchedOptions,
          question: item.question
        }), '发送答案填入请求失败');
        if (!sent) {
          applyAnswerResolverRef.current?.({ success: false, error: '发送答案填入请求失败' });
        }
        const result = await resultPromise.catch((error: Error) => ({ success: false, error: error.message }));
        if (!result?.success) {
          finalResult = result;
          appStore.setStatus('error', result?.error || '答案选择失败');
          break;
        }
        finalResult = result;
        await new Promise((resolve) => window.setTimeout(resolve, 900));
      }
      onComplete?.(finalResult);
    };

    window.addEventListener('studypilot:apply-answers', handleApplyAnswers);
    return () => window.removeEventListener('studypilot:apply-answers', handleApplyAnswers);
  }, [canUseRealWebview, getActiveWebview]);

  useEffect(() => {
    const handleChapterLearningAction = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      const webview = getActiveWebview();
      if (!canUseRealWebview || !webview) {
        appStore.setStatus('error', '请先在设置中启用真实 WebView，再使用章节学习。');
        return;
      }
      const action = detail.action || 'scan';
      const options = detail.options || {};
      appStore.setStatus('learning', action === 'stop' ? '正在停止章节学习辅助。' : '正在处理当前章节。');
      safeWebviewRun(() => webview.send?.('studypilot:chapter-learning', { action, options }), '发送章节学习指令失败');
    };

    window.addEventListener('studypilot:chapter-learning-action', handleChapterLearningAction);
    return () => window.removeEventListener('studypilot:chapter-learning-action', handleChapterLearningAction);
  }, [canUseRealWebview, getActiveWebview]);

  const navigate = (event: React.FormEvent) => {
    event.preventDefault();
    const targetUrl = normalizeAddressInput(addressText);
    if (!targetUrl) return;
    setAddressText(targetUrl);
    if (canUseRealWebview) {
      loadWebviewUrl(targetUrl, true);
      return;
    }

    setUrl(targetUrl);
    const nextHistory = history.slice(0, historyIndex + 1).concat(targetUrl);
    setHistory(nextHistory);
    setHistoryIndex(nextHistory.length - 1);
  };

  const moveHistory = (direction: -1 | 1) => {
    if (canUseRealWebview) {
      const webview = getActiveWebview();
      if (direction < 0 && webview && safeWebviewRead(() => webview.canGoBack?.(), false)) {
        safeWebviewRun(() => webview.goBack?.(), '后退失败');
      }
      if (direction > 0 && webview && safeWebviewRead(() => webview.canGoForward?.(), false)) {
        safeWebviewRun(() => webview.goForward?.(), '前进失败');
      }
      return;
    }
    const nextIndex = historyIndex + direction;
    if (nextIndex < 0 || nextIndex >= history.length) return;
    setHistoryIndex(nextIndex);
    setUrl(history[nextIndex]);
    setAddressText(history[nextIndex]);
  };

  const refresh = () => {
    if (canUseRealWebview) {
      const webview = getActiveWebview();
      if (isLoadingPage && webview) safeWebviewRun(() => webview.stop?.(), '停止加载失败');
      else if (webview) safeWebviewRun(() => webview.reload?.(), '刷新失败');
    }
    appStore.addLog('info', canUseRealWebview ? '已请求刷新当前标签页。' : '演示页面无需刷新。');
  };

  const closeBrowserTab = (tabId: string, event?: React.MouseEvent) => {
    event?.stopPropagation();
    setTabContextMenu(null);
    delete webviewRefs.current[tabId];
    if (tabs.length <= 1) {
      const replacement = createBrowserTab(DEFAULT_BROWSER_URL, '首页');
      setTabs([replacement]);
      setActiveTabId(replacement.id);
      setAddressText(replacement.url);
      return;
    }

    const index = tabs.findIndex((tab) => tab.id === tabId);
    const nextTabs = tabs.filter((tab) => tab.id !== tabId);
    setTabs(nextTabs);
    if (activeTabId === tabId) {
      const nextActive = nextTabs[Math.max(0, index - 1)] || nextTabs[0];
      setActiveTabId(nextActive.id);
      setAddressText(nextActive.url);
    }
  };

  const refreshBrowserTab = (tabId: string) => {
    setTabContextMenu(null);
    const webview = webviewRefs.current[tabId];
    if (webview) safeWebviewRun(() => webview.reload?.(), '刷新标签页失败');
  };

  const closeOtherTabs = (tabId: string) => {
    setTabContextMenu(null);
    const target = tabs.find((tab) => tab.id === tabId);
    if (!target) return;
    Object.keys(webviewRefs.current).forEach((id) => {
      if (id !== tabId) delete webviewRefs.current[id];
    });
    setTabs([target]);
    setActiveTabId(tabId);
    setAddressText(target.url);
  };

  const closeTabsToRight = (tabId: string) => {
    setTabContextMenu(null);
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0 || index >= tabs.length - 1) return;
    const nextTabs = tabs.slice(0, index + 1);
    const removedIds = new Set(tabs.slice(index + 1).map((tab) => tab.id));
    removedIds.forEach((id) => delete webviewRefs.current[id]);
    setTabs(nextTabs);
    if (removedIds.has(activeTabId)) {
      setActiveTabId(tabId);
      setAddressText(tabs[index].url);
    }
  };

  const copyTabUrl = async (tabId: string) => {
    setTabContextMenu(null);
    const target = tabs.find((tab) => tab.id === tabId);
    if (!target?.url) return;
    try {
      await navigator.clipboard.writeText(target.url);
      appStore.addLog('success', '标签页地址已复制。');
    } catch (error: any) {
      appStore.addLog('warn', `复制标签页地址失败：${error?.message || '浏览器权限不足'}`);
    }
  };

  const runTabContextAction = (action: TabContextMenuAction, tabId: string) => {
    if (action === 'refresh') refreshBrowserTab(tabId);
    if (action === 'copy') copyTabUrl(tabId);
    if (action === 'close') closeBrowserTab(tabId);
    if (action === 'closeOthers') closeOtherTabs(tabId);
    if (action === 'closeRight') closeTabsToRight(tabId);
  };

  const openTabContextMenu = (event: React.MouseEvent, tabId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setActiveTabId(tabId);
    const viewportPadding = 8;
    const menuWidth = 270;
    const menuHeight = 262;
    setTabContextMenu({
      tabId,
      x: Math.max(viewportPadding, Math.min(event.clientX, window.innerWidth - menuWidth - viewportPadding)),
      y: Math.max(viewportPadding, Math.min(event.clientY, window.innerHeight - menuHeight - viewportPadding))
    });
  };

  const toggleFullscreen = () => {
    setBrowserFullscreen((value) => !value);
  };

  const scanPage = () => {
    appStore.setStatus('scanning', activeSource === 'webview' ? '正在扫描当前 WebView 页面。' : '正在扫描本地演示页面。');
    appStore.setPlan(null);
    setMockSubmitted(false);
    if (activeSource === 'webview') {
      const webview = getActiveWebview();
      if (webview) safeWebviewRun(() => webview.send?.('studypilot:snapshot'), '发送页面扫描请求失败');
      return;
    }
    appStore.setSnapshot({ url: currentBrowserUrl, title: '授权学习页面演示', controls: mockControls, capturedAt: Date.now() });
    appStore.setStatus('planning', '演示页面扫描完成。下一步可以生成自动化计划。');
  };

  const extractQuestion = () => {
    appStore.setStatus('extracting_question', activeSource === 'webview' ? '正在从当前页面抓取题目。' : '正在从演示页面抓取题目。');
    if (activeSource === 'webview') {
      const webview = getActiveWebview();
      if (webview) safeWebviewRun(() => webview.send?.('studypilot:extract-question'), '发送题目抓取请求失败');
      return;
    }
    appStore.setQuestions(mockQuestions.map((question) => ({ ...question, capturedAt: Date.now() })));
    appStore.setStatus('done', `题目抓取完成，共 ${mockQuestions.length} 题。`);
  };

  const buildPlan = (nextGoal?: string) => {
    if (!snapshot) {
      appStore.setStatus('error', '请先扫描页面，再生成计划。');
      return;
    }
    const planGoal = typeof nextGoal === 'string' ? nextGoal : goal;
    appStore.setStatus('planning', '正在生成逐步自动化计划。');
    appStore.setPlan(createPlan(planGoal, snapshot, activeSource));
    appStore.setStatus('awaiting_approval', '请先复核并批准计划，再执行。');
  };

  const executeMockStep = (step: AutomationStep) => {
    if (!step.selector) return;
    const key = step.selector.match(/"([^"]+)"/)?.[1] || step.selector;
    if (step.action === 'fill' || step.action === 'select') setMockValues((prev) => ({ ...prev, [key]: step.value || '' }));
    if (step.action === 'click') {
      if (key === 'submit') setMockSubmitted(true);
      else setMockValues((prev) => ({ ...prev, [key]: !prev[key] }));
    }
  };

  const executePlan = () => {
    if (!currentPlan) return;
    if (settings.requireApprovalBeforeExecute && !currentPlan.approved) {
      appStore.setStatus('error', '执行前需要先批准计划。');
      return;
    }
    appStore.setStatus('executing', '正在执行已批准的自动化步骤。');
    if (currentPlan.source === 'webview') {
      const webview = getActiveWebview();
      if (webview) safeWebviewRun(() => webview.send?.('studypilot:execute-plan', currentPlan), '发送自动化计划失败');
      return;
    }
    currentPlan.steps.forEach(executeMockStep);
    window.setTimeout(() => appStore.completePlan('已在本地演示页面完成自动化操作。'), 350);
  };

  useEffect(() => {
    const handleAutomationAction = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      const action = detail.action as string;
      const nextGoal = typeof detail.goal === 'string' ? detail.goal : goal;
      if (typeof detail.goal === 'string') setGoal(detail.goal);

      if (action === 'extract-question') extractQuestion();
      if (action === 'scan-page') scanPage();
      if (action === 'build-plan') buildPlan(nextGoal);
      if (action === 'execute-plan') executePlan();
    };

    window.addEventListener('studypilot:automation-action', handleAutomationAction);
    return () => window.removeEventListener('studypilot:automation-action', handleAutomationAction);
  });

  return (
    <div className="mock-page-container" style={browserFullscreen ? { position: 'fixed', inset: 0, zIndex: 9999, background: '#05040a', borderRadius: 0 } : undefined}>
      {canUseRealWebview && preloadPath && (
        <div className="browser-tabs-bar" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px 0', borderBottom: '1px solid var(--border-glass)', overflowX: 'auto' }}>
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                onAuxClick={(event) => {
                  if (event.button === 1) closeBrowserTab(tab.id, event);
                }}
                onContextMenu={(event) => openTabContextMenu(event, tab.id)}
                title={tab.url}
                style={{
                  minWidth: 138,
                  maxWidth: 220,
                  height: 34,
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) 22px',
                  alignItems: 'center',
                  gap: 4,
                  padding: '0 5px 0 10px',
                  borderRadius: '8px 8px 0 0',
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                  border: active ? '1px solid var(--border-glass)' : '1px solid transparent',
                  borderBottomColor: active ? 'var(--bg-panel-solid)' : 'transparent',
                  fontSize: '0.76rem'
                }}
                className={`browser-tab${active ? ' active' : ''}`}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
                  {tab.loading ? '加载中...' : tab.title || friendlyTitle(tab.url)}
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  title="关闭标签页"
                  onClick={(event) => closeBrowserTab(tab.id, event)}
                  onContextMenu={(event) => openTabContextMenu(event, tab.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') closeBrowserTab(tab.id);
                  }}
                   style={{ width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, color: active ? 'var(--text-secondary)' : 'var(--text-muted)' }}
                >
                  <X size={13} />
                </span>
              </button>
            );
          })}
          <button
            onClick={() => openBrowserTab(DEFAULT_BROWSER_URL, { title: '新标签页' })}
            title="新建标签页"
            style={{ width: 32, height: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, background: 'rgba(255,255,255,0.04)', color: 'var(--text-primary)' }}
          >
            <Plus size={15} />
          </button>
          {tabContextMenu && (
            <div
              className="browser-tab-context-menu"
              role="menu"
              aria-label="标签页菜单"
              onClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              style={{
                position: 'fixed',
                left: tabContextMenu.x,
                top: tabContextMenu.y,
                zIndex: 10020
              }}
            >
              {[
                [
                  { label: '刷新', shortcut: 'Ctrl+R', action: 'refresh' as const, icon: RefreshCw, disabled: false },
                  { label: '复制标签页地址', shortcut: 'Ctrl+Shift+C', action: 'copy' as const, icon: Copy, disabled: false }
                ],
                [
                  { label: '关闭标签页', shortcut: 'Ctrl+W', action: 'close' as const, icon: X, disabled: false },
                  { label: '关闭其他标签页', shortcut: '', action: 'closeOthers' as const, icon: X, disabled: tabs.length <= 1 },
                  { label: '关闭右侧标签页', shortcut: '', action: 'closeRight' as const, icon: X, disabled: tabs.findIndex((tab) => tab.id === tabContextMenu.tabId) >= tabs.length - 1 }
                ]
              ].map((group, groupIndex) => (
                <div key={groupIndex} className="browser-tab-context-group">
                  {group.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.label}
                        type="button"
                        role="menuitem"
                        disabled={item.disabled}
                        onClick={() => runTabContextAction(item.action, tabContextMenu.tabId)}
                        className="browser-tab-context-item"
                      >
                        <Icon size={16} />
                        <span>{item.label}</span>
                        {item.shortcut && <kbd>{item.shortcut}</kbd>}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="browser-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border-glass)' }}>
        <button onClick={() => moveHistory(-1)} disabled={backDisabled} title="后退" style={{ background: 'rgba(255,255,255,0.03)', color: backDisabled ? 'var(--text-muted)' : 'var(--text-primary)', padding: 8, borderRadius: 6 }}>
          <ArrowLeft size={15} />
        </button>
        <button onClick={() => moveHistory(1)} disabled={forwardDisabled} title="前进" style={{ background: 'rgba(255,255,255,0.03)', color: forwardDisabled ? 'var(--text-muted)' : 'var(--text-primary)', padding: 8, borderRadius: 6 }}>
          <ArrowRight size={15} />
        </button>
        <button onClick={refresh} title={isLoadingPage ? '停止加载' : '刷新'} style={{ background: 'rgba(255,255,255,0.03)', color: 'var(--text-primary)', padding: 8, borderRadius: 6 }}>
          <RefreshCw size={15} style={isLoadingPage ? { animation: 'spin 0.9s linear infinite' } : undefined} />
        </button>
        <form onSubmit={navigate} style={{ flex: 1, display: 'flex', gap: 8 }}>
          <div className="browser-address" style={{ flex: 1, display: 'flex', alignItems: 'center', border: '1px solid var(--border-glass)', borderRadius: 8, padding: '0 10px', gap: 8 }}>
            <Compass size={14} style={{ color: 'var(--text-muted)' }} />
            <input value={addressText} onChange={(event) => setAddressText(event.target.value)} placeholder="输入网址或搜索内容，按 Enter 跳转" style={{ flex: 1, background: 'transparent', border: 'none', color: 'var(--text-primary)', fontSize: '0.85rem' }} />
          </div>
          <button type="submit" style={{ background: 'rgba(99,102,241,0.16)', color: 'var(--text-primary)', padding: '0 12px', borderRadius: 8, fontWeight: 800 }}>前往</button>
        </form>
        <button onClick={toggleFullscreen} title={browserFullscreen ? '退出全屏浏览' : '全屏浏览'} style={{ background: 'rgba(255,255,255,0.03)', color: 'var(--text-primary)', padding: 8, borderRadius: 6 }}>
          {browserFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <span className={`badge ${statusBadge}`} style={{ minWidth: 92, justifyContent: 'center' }}>{statusLabels[status] || status}</span>
      </div>

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minHeight: 0 }}>
        <div style={{ minHeight: 0, position: 'relative', overflow: 'hidden' }}>
          {canUseRealWebview && preloadPath ? (
            tabs.map((tab) => (
              <BrowserTabView
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                preloadPath={preloadPath}
                registerWebview={registerWebview}
                onStateChange={handleTabStateChange}
                onIpcMessage={handleWebviewIpc}
              />
            ))
          ) : (
            <div className="mock-page-body">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 20, alignItems: 'flex-start' }}>
                <div>
                  <h3 style={{ color: 'var(--text-primary)', fontSize: '1.15rem', marginBottom: 6 }}>授权学习页面演示</h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', maxWidth: 680, lineHeight: 1.55 }}>
                    这里演示连续多题抓取、按题显示答案，以及授权网页自动化操作。真实页面抓取需要在设置中启用 WebView。
                  </p>
                </div>
                <span className="badge badge-warning"><Shield size={12} /> 演示模式</span>
              </div>

              <section className="glass-panel" style={{ padding: 18, maxWidth: 780, marginBottom: 18, borderRadius: 8 }}>
                {mockQuestions.map((question) => (
                  <div key={question.hash} data-sp-question style={{ marginBottom: 18 }}>
                    <div className="question-title" style={{ color: 'var(--text-primary)', fontWeight: 800, fontSize: '0.95rem', marginBottom: 10 }}>
                      {question.index}.（单选题）{question.question}
                    </div>
                    {question.options.map((option) => (
                      <label key={option} data-option style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-secondary)', fontSize: '0.82rem', marginBottom: 8 }}>
                        <input type="radio" name={`demo-question-${question.index}`} />
                        {option}
                      </label>
                    ))}
                  </div>
                ))}
              </section>

              <div className="glass-panel" style={{ padding: 18, maxWidth: 780, display: 'flex', flexDirection: 'column', gap: 14, borderRadius: 8 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  姓名
                  <input data-sp-control="fullName" value={String(mockValues.fullName || '')} onChange={(event) => setMockValues((prev) => ({ ...prev, fullName: event.target.value }))} placeholder="请输入姓名" />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  邮箱
                  <input data-sp-control="email" type="email" value={String(mockValues.email || '')} onChange={(event) => setMockValues((prev) => ({ ...prev, email: event.target.value }))} placeholder="请输入邮箱" />
                </label>
                <button data-sp-control="submit" onClick={() => setMockSubmitted(true)} style={{ alignSelf: 'flex-start', background: 'linear-gradient(135deg, var(--primary-color), var(--accent-color))', color: '#fff', padding: '10px 16px', borderRadius: 8, fontWeight: 700 }}>
                  提交请求
                </button>
                {mockSubmitted && (
                  <div style={{ color: 'var(--success-color)', display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.82rem', fontWeight: 700 }}>
                    <Check size={16} /> 演示页面中的请求已提交。
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
