import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AIPanel } from './components/AIPanel';
import { AnnouncementBanner } from './components/AnnouncementBanner';
import { BugReportPanel } from './components/BugReportPanel';
import { HistoryPanel } from './components/HistoryPanel';
import { KnowledgeBase } from './components/KnowledgeBase';
import { SettingsPanel } from './components/SettingsPanel';
import { TokenUsagePanel } from './components/TokenUsagePanel';
import { TutorialPanel } from './components/TutorialPanel';
import { appStore, useAppStore } from './store/appStore';
import { getPlatformAPI } from './platform';
import { startAndroidBrowser } from './platform/androidBrowser';
import { webAISessions } from './webAI/WebAISessionManager';
import { NativeWebView, type NativeBrowserState } from './platform/nativeWebViewPlugin';
import {
  ArrowLeft, ArrowRight, Bug, ChevronDown, ChevronUp,
  BookOpen, Coins, Globe, History, LibraryBig, Moon, Plus, RefreshCw, SlidersHorizontal, Sparkles, Sun, X,
} from 'lucide-react';

type TabId = 'automation' | 'snapshot' | 'tokens' | 'history' | 'bugs' | 'tutorial' | 'settings';

const tabs: { id: TabId; label: string; icon: typeof Sparkles }[] = [
  { id: 'automation', label: '答题', icon: Sparkles },
  { id: 'snapshot', label: '题库', icon: LibraryBig },
  { id: 'tokens', label: 'Token', icon: Coins },
  { id: 'history', label: '记录', icon: History },
  { id: 'bugs', label: '错误', icon: Bug },
  { id: 'tutorial', label: '教程', icon: BookOpen },
  { id: 'settings', label: '设置', icon: SlidersHorizontal },
];

const HOME_URL = 'https://i.chaoxing.com';

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return HOME_URL;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // bare hostname or search query
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(trimmed)) return `https://${trimmed}`;
  return `https://www.baidu.com/s?wd=${encodeURIComponent(trimmed)}`;
}

export default function MobileApp() {
  const { settings, status, logs } = useAppStore();
  const [activeTab, setActiveTab] = useState<TabId>('automation');
  const [panelOpen, setPanelOpen] = useState(false);

  const togglePanel = (open: boolean) => setPanelOpen(open);
  const [backdrop, setBackdrop] = useState('');
  const [browserUrl, setBrowserUrl] = useState(HOME_URL);
  const [browserTitle, setBrowserTitle] = useState('学习通');
  const [urlInput, setUrlInput] = useState(HOME_URL);
  const [urlEditing, setUrlEditing] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [browserTabs, setBrowserTabs] = useState<NativeBrowserState[]>([]);
  const [activeBrowserTab, setActiveBrowserTab] = useState('study');
  const sessions = useSyncExternalStore(webAISessions.subscribe, webAISessions.getSnapshot);
  const workflow = useSyncExternalStore(sessions.controller.subscribe, sessions.controller.getSnapshot);
  const headerRef = useRef<HTMLElement>(null);
  const tabsRef = useRef<HTMLElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Auto-collapse panel when AI answering / automation starts
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const wasIdle = !['calling_ai', 'executing'].includes(prevStatusRef.current);
    const isActive = ['calling_ai', 'executing'].includes(status);
    if (wasIdle && isActive && panelOpen) {
      togglePanel(false);
    }
    prevStatusRef.current = status;
  }, [status]);

  // Theme
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.body.dataset.theme = settings.theme;
    return () => {
      delete document.documentElement.dataset.theme;
      delete document.body.dataset.theme;
    };
  }, [settings.theme]);

  useEffect(() => startAndroidBrowser(), []);

  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const update = async () => {
      const request = ++revision;
      try {
        const result = await NativeWebView.listTabs();
        if (disposed || request !== revision) return;
        setBrowserTabs(result.tabs);
        setActiveBrowserTab(result.activeTabId);
        const state = result.tabs.find(tab => tab.tabId === result.activeTabId);
        if (!state) return;
        setBrowserUrl(state.url);
        setBrowserTitle(state.title || state.url);
        setCanGoBack(state.canGoBack);
        setCanGoForward(state.canGoForward);
        if (!state.loading && /^https?:/.test(state.url)) webAISessions.selectForTab({ tabId: state.tabId, url: state.url }, state.title);
      } catch (error) { console.error(error); }
    };
    const listener = NativeWebView.onNavigationChanged(update);
    void update();
    return () => { disposed = true; void listener.then(handle => handle.remove()); };
  }, []);

  useEffect(() => {
    if (['sending', 'applying'].includes(workflow.phase)) setPanelOpen(false);
  }, [workflow.phase]);

  useEffect(() => {
    const show = () => { setPanelOpen(false); setUrlEditing(false); };
    window.addEventListener('studypilot:show-source', show);
    return () => window.removeEventListener('studypilot:show-source', show);
  }, []);

  useEffect(() => {
    headerRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeBrowserTab]);

  useEffect(() => {
    if (!urlEditing) setUrlInput(browserUrl);
  }, [browserUrl, urlEditing]);

  useEffect(() => {
    if (!panelOpen) return;
    let cancelled = false;
    void NativeWebView.captureBackdrop().then(result => {
      if (!cancelled) setBackdrop(result.dataUrl);
    }).catch(() => setBackdrop(''));
    return () => { cancelled = true; };
  }, [panelOpen, browserUrl, activeBrowserTab]);

  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const header = headerRef.current?.getBoundingClientRect();
        const tabs = tabsRef.current?.getBoundingClientRect();
        const sheet = sheetRef.current?.getBoundingClientRect();
        if (!header || !tabs || !sheet) return;
        const tabInset = Math.max(0, window.innerHeight - tabs.top);
        document.documentElement.style.setProperty('--mobile-header-height', `${header.height}px`);
        document.documentElement.style.setProperty('--mobile-tab-height', `${tabInset}px`);
        document.documentElement.style.setProperty('--mobile-viewport-height', `${window.innerHeight}px`);
        void NativeWebView.setLayout({
          headerHeight: Math.ceil(header.height), tabHeight: Math.ceil(tabInset),
          panelTop: panelOpen ? sheetRef.current!.offsetTop : tabs.top,
          modalOpen: Boolean(document.querySelector('dialog[open]')),
        }).catch(() => undefined);
      });
    };
    const observer = new ResizeObserver(measure);
    [headerRef.current, tabsRef.current, sheetRef.current].forEach(el => el && observer.observe(el));
    const mutations = new MutationObserver(measure);
    mutations.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['open'] });
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    measure();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); mutations.disconnect();
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [panelOpen]);

  const navigate = (url: string) => {
    const normalized = normalizeUrl(url);
    setUrlInput(normalized);
    setUrlEditing(false);
    void NativeWebView.loadUrl(normalized).catch(error => appStore.setStatus('error', error.message));
  };
  const browserAction = (operation: Promise<unknown>) => void operation.catch(error => appStore.setStatus('error', error.message));
  const closeBrowserTab = async (id: string) => {
    if (webAISessions.runningForTab(id)) return;
    await NativeWebView.closeTab(id);
    for (const session of webAISessions.getSnapshot().sessions) {
      if (session.source.tabId === id) webAISessions.disposeSession(session.id);
    }
  };

  const statusColor = status === 'error' ? '#ef4444' : status === 'done' ? '#10b981' : status === 'executing' ? '#f59e0b' : '#6366f1';

  return (
    <div data-theme={settings.theme} className="mobile-shell">

      {/* ── Top browser nav bar ── */}
      <header ref={headerRef} className={`mobile-header${urlEditing ? ' is-editing' : ''}`}>
        <div className="mobile-header__nav">
          <button aria-label="后退" className="mobile-nav-btn" onClick={() => NativeWebView.goBack()} disabled={!canGoBack}>
            <ArrowLeft size={16} />
          </button>
          <button aria-label="前进" className="mobile-nav-btn" onClick={() => NativeWebView.goForward()} disabled={!canGoForward}>
            <ArrowRight size={16} />
          </button>

          {urlEditing ? (
            <input
              ref={urlInputRef}
              className="mobile-url-input"
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') navigate(urlInput); if (e.key === 'Escape') { setUrlEditing(false); setUrlInput(browserUrl); } }}
              onBlur={() => { setUrlEditing(false); setUrlInput(browserUrl); }}
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
            />
          ) : (
            <div
              className="mobile-url-bar"
              onClick={() => { setUrlEditing(true); setUrlInput(browserUrl); setTimeout(() => urlInputRef.current?.select(), 50); }}
            >
              <Globe size={11} />
              <span>{browserTitle || browserUrl}</span>
            </div>
          )}

          <button aria-label="刷新" className="mobile-nav-btn" onClick={() => NativeWebView.reload()}>
            <RefreshCw size={15} />
          </button>
          <button className="mobile-nav-btn" aria-label="切换明暗主题" onClick={() => appStore.updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })}>
            {settings.theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <span className="mobile-status-dot" style={{ background: statusColor }} />
        </div>
        <nav className="mobile-browser-tabs" aria-label="浏览器标签页">
          <div className="mobile-browser-tabs__list" role="tablist">
            {browserTabs.map(tab => {
              const running = sessions.sessions.some(session => session.controller.getSnapshot().busy &&
                (session.source.tabId === tab.tabId || session.controller.getSnapshot().aiTab?.id === tab.tabId));
              return <div key={tab.tabId} className={`mobile-browser-tab${tab.tabId === activeBrowserTab ? ' is-active' : ''}`}>
                <button role="tab" aria-selected={tab.tabId === activeBrowserTab}
                  onClick={() => browserAction(NativeWebView.focusTab(tab.tabId))}>
                  <Globe size={12} /><span>{tab.title || tab.url || '新标签页'}</span>
                </button>
                <button className="mobile-browser-tab__close" aria-label={`关闭标签页 ${tab.title || tab.url}`}
                  title={running ? '答题任务正在使用此标签页' : '关闭标签页'} disabled={browserTabs.length < 2 || running}
                  onClick={() => browserAction(closeBrowserTab(tab.tabId))}><X size={13} /></button>
              </div>;
            })}
          </div>
          <button className="mobile-nav-btn" aria-label="新建浏览器标签页" onClick={() => browserAction(NativeWebView.createTab(HOME_URL))}><Plus size={18} /></button>
        </nav>
      </header>

      {/* ── Tab bar (always visible) ── */}
      <nav ref={tabsRef} className="mobile-tabs" aria-label="工具导航">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              aria-label={tab.label}
              aria-controls="mobile-tool-panel"
              aria-expanded={panelOpen && active}
              className={`mobile-tab${active ? ' is-active' : ''}`}
              onClick={() => { setActiveTab(tab.id); togglePanel(true); }}
            >
              <Icon size={21} strokeWidth={1.8} aria-hidden="true" />
              <span>{tab.label}</span>
            </button>
          );
        })}
        <button className="mobile-tab mobile-tab--toggle" aria-expanded={panelOpen} aria-controls="mobile-tool-panel" onClick={() => togglePanel(!panelOpen)}>
          {panelOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          <span>{panelOpen ? '收起' : '展开'}</span>
        </button>
      </nav>

      <aside id="mobile-tool-panel" ref={sheetRef} className={`mobile-sheet${panelOpen ? ' is-open' : ''}`} aria-hidden={!panelOpen}>
        {backdrop && <img className="mobile-sheet__backdrop" src={backdrop} alt="" aria-hidden="true" />}
        <div className="mobile-sheet__tint" />
        <div className="mobile-sheet__handle" aria-hidden="true" />
        <main className="mobile-main">
          <AnnouncementBanner />
          <div hidden={activeTab !== 'automation'}><AIPanel /></div>
          <div hidden={activeTab !== 'snapshot'}><KnowledgeBase /></div>
          <div hidden={activeTab !== 'tokens'}><TokenUsagePanel /></div>
          <div hidden={activeTab !== 'history'}><HistoryPanel /></div>
          <div hidden={activeTab !== 'bugs'}><BugReportPanel /></div>
          <div hidden={activeTab !== 'tutorial'}><TutorialPanel /></div>
          <div hidden={activeTab !== 'settings'}><SettingsPanel /></div>

          <div className="mobile-logs-toggle" onClick={() => setLogsExpanded(v => !v)}>
            <span>{logsExpanded ? '收起日志' : '展开日志'}</span>
            {logsExpanded ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          </div>
          {logsExpanded && (
            <div className="mobile-logs">
              {logs.slice(-40).map(log => (
                <div key={log.id} className="mobile-logs__row">
                  <span className="mobile-logs__ts">[{log.timestamp}]</span>
                  <span className={`mobile-logs__lvl mobile-logs__lvl--${log.level}`}>{log.level}</span>
                  <span className="mobile-logs__msg">{log.message}</span>
                </div>
              ))}
            </div>
          )}
        </main>
      </aside>
    </div>
  );
}
