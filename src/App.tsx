import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AIPanel } from './components/AIPanel';
import { AnnouncementBanner } from './components/AnnouncementBanner';
import { BrowserPanel } from './components/BrowserPanel';
import { BugReportPanel } from './components/BugReportPanel';
import { HistoryPanel } from './components/HistoryPanel';
import { KnowledgeBase } from './components/KnowledgeBase';
import { SettingsPanel } from './components/SettingsPanel';
import { TokenUsagePanel } from './components/TokenUsagePanel';
import { TutorialPanel } from './components/TutorialPanel';
import { appStore, useAppStore } from './store/appStore';
import { webAISessions } from './webAI/WebAISessionManager';
import { Bell, BookOpen, Brain, Bug, ChartNoAxesCombined, ChevronLeft, ChevronRight, Database, History, Minimize2, Moon, Settings, Square, Sun, Terminal, X } from 'lucide-react';

type TabId = 'automation' | 'snapshot' | 'tokens' | 'history' | 'bugs' | 'tutorial' | 'settings';

const tabs: { id: TabId; label: string; icon: typeof Brain }[] = [
  { id: 'automation', label: '答题', icon: Brain },
  { id: 'snapshot', label: '本地题库', icon: Database },
  { id: 'tokens', label: 'Token', icon: ChartNoAxesCombined },
  { id: 'history', label: '运行记录', icon: History },
  { id: 'bugs', label: '错误报告', icon: Bug },
  { id: 'tutorial', label: '使用教程', icon: BookOpen },
  { id: 'settings', label: '设置', icon: Settings }
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

const START_NOTICE_KEY = 'studypilot_start_notice_v2';

export default function App() {
  const { status, statusText, logs, settings, isElectron } = useAppStore();
  const [activeTab, setActiveTab] = useState<TabId>('automation');
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [showNotice, setShowNotice] = useState(false);
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [resizingWorkbench, setResizingWorkbench] = useState(false);
  const webSessions = useSyncExternalStore(webAISessions.subscribe, webAISessions.getSnapshot);
  const webTask = useSyncExternalStore(webSessions.controller.subscribe, webSessions.controller.getSnapshot);
  const workbenchBounds = () => {
    const viewport = window.innerWidth;
    const browserMin = Math.min(500, Math.max(300, Math.round(viewport * 0.46)));
    const min = Math.min(420, Math.max(340, Math.round(viewport * 0.4)));
    return { min, max: Math.max(min, viewport - browserMin) };
  };
  const [workbenchWidth, setWorkbenchWidth] = useState(() => {
    const bounds = workbenchBounds();
    return Math.min(600, bounds.max);
  });
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const seen = localStorage.getItem(START_NOTICE_KEY);
    if (!seen) setShowNotice(true);
  }, []);

  useEffect(() => {
    // The web workflow now lives inside the 答题 tab. A request from the
    // question bank only needs to switch tabs; the embedded workflow consumes
    // the short-lived localStorage request after it mounts.
    const openAnswerTab = () => {
      setActiveTab('automation');
      setSideCollapsed(false);
    };
    window.addEventListener('studypilot:open-web-ai', openAnswerTab);
    return () => window.removeEventListener('studypilot:open-web-ai', openAnswerTab);
  }, []);

  useEffect(() => {
    const keepWorkbenchInBounds = () => {
      const { min, max } = workbenchBounds();
      setWorkbenchWidth((width) => Math.max(min, Math.min(width, max)));
    };
    window.addEventListener('resize', keepWorkbenchInBounds);
    return () => window.removeEventListener('resize', keepWorkbenchInBounds);
  }, []);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  useEffect(() => {
    if (webTask.flow !== 'automatic') return;
    if (webTask.visible) {
      resizeCleanupRef.current?.();
      setActiveTab('automation');
      setSideCollapsed(false);
    } else if (webTask.busy && !webTask.paused) {
      resizeCleanupRef.current?.();
      setSideCollapsed(true);
    }
  }, [webTask.flow, webTask.runId, webTask.busy, webTask.visible, webTask.paused]);

  useEffect(() => {
    // The browser deck also paints the document background, so keep the theme
    // on the root elements instead of limiting it to the React application.
    document.documentElement.dataset.theme = settings.theme;
    document.body.dataset.theme = settings.theme;
    (window as any).electronAPI?.setTitlebarTheme?.(settings.theme);

    return () => {
      delete document.documentElement.dataset.theme;
      delete document.body.dataset.theme;
    };
  }, [settings.theme]);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    let activeSurface: HTMLElement | null = null;
    let releaseTimer: number | undefined;
    let previousPoint = { x: 0, y: 0 };

    const releaseSurface = () => {
      if (!activeSurface) return;
      const surface = activeSurface;
      activeSurface = null;
      surface.classList.remove('jelly-runtime--active');
      surface.classList.add('jelly-runtime--release');
      surface.style.removeProperty('--jelly-runtime-x');
      surface.style.removeProperty('--jelly-runtime-y');
      surface.style.removeProperty('--jelly-runtime-shift');
      surface.style.removeProperty('--jelly-runtime-scale-x');
      surface.style.removeProperty('--jelly-runtime-scale-y');
      window.clearTimeout(releaseTimer);
      releaseTimer = window.setTimeout(() => surface.classList.remove('jelly-runtime--release'), 440);
    };

    const handlePointerMove = (event: PointerEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>('.glass-panel, .kb-jelly-surface, .browser-solving-dock, .browser-address')
        : null;

      if (!target) {
        releaseSurface();
        return;
      }

      if (target !== activeSurface) {
        releaseSurface();
        activeSurface = target;
        target.classList.remove('jelly-runtime--release');
        target.classList.add('jelly-runtime', 'jelly-runtime--active');
      }

      const rect = target.getBoundingClientRect();
      const velocityX = Math.max(-18, Math.min(18, event.clientX - previousPoint.x));
      const relativeX = (event.clientX - rect.left) / Math.max(rect.width, 1) - 0.5;
      const relativeY = (event.clientY - rect.top) / Math.max(rect.height, 1) - 0.5;
      const stretch = Math.min(0.022, Math.abs(velocityX) * 0.0012);

      target.style.setProperty('--jelly-runtime-x', `${(-relativeY * 1.15).toFixed(2)}deg`);
      target.style.setProperty('--jelly-runtime-y', `${(relativeX * 1.15).toFixed(2)}deg`);
      target.style.setProperty('--jelly-runtime-shift', `${(velocityX * 0.16).toFixed(2)}px`);
      target.style.setProperty('--jelly-runtime-scale-x', `${(1 + stretch).toFixed(4)}`);
      target.style.setProperty('--jelly-runtime-scale-y', `${(1 - stretch * 0.5).toFixed(4)}`);
      previousPoint = { x: event.clientX, y: event.clientY };
    };

    const releaseOnExit = (event: PointerEvent) => {
      const nextTarget = event.relatedTarget;
      if (!(nextTarget instanceof Node) || !document.querySelector('.app-shell')?.contains(nextTarget)) releaseSurface();
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('pointerout', releaseOnExit, { passive: true });

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerout', releaseOnExit);
      window.clearTimeout(releaseTimer);
      releaseSurface();
    };
  }, []);

  const closeNotice = () => {
    localStorage.setItem(START_NOTICE_KEY, '1');
    setShowNotice(false);
  };

  const windowAction = (action: 'minimize' | 'maximize' | 'close') => {
    if (isElectron && (window as any).electronAPI) {
      (window as any).electronAPI[action]();
      return;
    }
    appStore.addLog('info', `窗口操作已触发：${action}`);
  };

  const openSideTab = (tab: TabId) => {
    setActiveTab(tab);
    setSideCollapsed(false);
  };

  const startWorkbenchResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (sideCollapsed || event.button !== 0) return;
    event.preventDefault();
    resizeCleanupRef.current?.();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = handle.parentElement!.getBoundingClientRect().width;
    handle.setPointerCapture(pointerId);
    setResizingWorkbench(true);
    document.body.classList.add('is-resizing-workbench');

    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const { min, max } = workbenchBounds();
      const nextWidth = startWidth + (startX - moveEvent.clientX);
      setWorkbenchWidth(Math.max(min, Math.min(Math.round(nextWidth), max)));
    };
    const handleEnd = () => {
      document.body.classList.remove('is-resizing-workbench');
      setResizingWorkbench(false);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleEnd);
      window.removeEventListener('pointercancel', handleEnd);
      window.removeEventListener('blur', handleEnd);
      handle.removeEventListener('lostpointercapture', handleEnd);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      resizeCleanupRef.current = null;
    };

    resizeCleanupRef.current = handleEnd;
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleEnd, { once: true });
    window.addEventListener('pointercancel', handleEnd, { once: true });
    window.addEventListener('blur', handleEnd, { once: true });
    handle.addEventListener('lostpointercapture', handleEnd, { once: true });
  };

  const statusColor = status === 'error'
    ? '#ef4444'
    : status === 'done'
      ? '#10b981'
      : status === 'executing'
        ? '#f59e0b'
        : '#6366f1';

  return (
    <div data-theme={settings.theme} className="app-shell">
      <header className="app-shell-bar app-window-titlebar app-header">
        <div className="app-brand">
          <div className="app-brand__mark"><Brain size={15} /></div>
          <span className="app-brand__title">学习通答题辅助工作台</span>
          <span className="app-brand__tag">纯本地离线架构</span>
        </div>
        <div className="app-header__meta">
          <div className="app-stream-status" title={statusText}>
            <span className="app-stream-status__dot" style={{ background: statusColor, boxShadow: `0 0 10px ${statusColor}` }} />
            <span>{statusLabels[status] || status}</span>
            <i>•</i>
            <strong>本地题库优先</strong>
          </div>
          <button className="theme-switch-btn" onClick={() => appStore.updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })} title={settings.theme === 'dark' ? '切换浅色模式' : '切换深色模式'}>
            {settings.theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
            <span>{settings.theme === 'dark' ? '浅色模式' : '深色模式'}</span>
          </button>
          <div className="window-controls" style={{ display: 'flex', gap: 4 }}>
            <button className="window-control" onClick={() => windowAction('minimize')} title="最小化" style={{ background: 'transparent', color: 'var(--text-secondary)', padding: '6px 10px', borderRadius: 4 }}>
              <Minimize2 size={12} />
            </button>
            <button className="window-control" onClick={() => windowAction('maximize')} title="最大化" style={{ background: 'transparent', color: 'var(--text-secondary)', padding: '6px 10px', borderRadius: 4 }}>
              <Square size={10} />
            </button>
            <button className="window-control" onClick={() => windowAction('close')} title="关闭" style={{ background: 'transparent', color: 'var(--text-secondary)', padding: '6px 10px', borderRadius: 4 }}>
              <X size={12} />
            </button>
          </div>
        </div>
      </header>

      <main className="app-workspace">
        <section className="browser-deck">
          <BrowserPanel />
        </section>
        <aside className={`app-right-drawer assistant-dock${sideCollapsed ? ' is-collapsed' : ''}`} style={{
          width: sideCollapsed ? 58 : workbenchWidth,
          flex: '0 0 auto',
          minWidth: sideCollapsed ? 58 : workbenchWidth,
          display: 'flex',
          flexDirection: 'row',
          background: 'var(--bg-panel)',
          transition: resizingWorkbench ? 'none' : 'width 180ms ease, min-width 180ms ease'
        }}>
          {!sideCollapsed && <div className="workbench-resizer" onPointerDown={startWorkbenchResize} role="separator" aria-orientation="vertical" aria-label="调整右侧工作台宽度" title="拖动调整工作台宽度" />}
          {!sideCollapsed && <div className="app-right-drawer__content assistant-dock__content" style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <AnnouncementBanner />
            <div className="side-panel-content" style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <div key={activeTab} className="side-panel-page">
                {activeTab === 'automation' && <AIPanel />}
                {activeTab === 'snapshot' && <KnowledgeBase />}
                {activeTab === 'tokens' && <TokenUsagePanel />}
                {activeTab === 'history' && <HistoryPanel />}
                {activeTab === 'bugs' && <BugReportPanel />}
                {activeTab === 'tutorial' && <TutorialPanel />}
                {activeTab === 'settings' && <SettingsPanel />}
              </div>
            </div>
          </div>}
          <nav className="app-side-tabs app-side-tabs--vertical" aria-label="功能面板">
            <button
              onClick={() => setSideCollapsed((value) => !value)}
              title={sideCollapsed ? '展开右侧面板' : '收起右侧面板'}
              aria-label={sideCollapsed ? '展开右侧面板' : '收起右侧面板'}
              style={{
                width: sideCollapsed ? 58 : 72,
                height: 54,
                display: 'grid',
                placeItems: 'center',
                color: 'var(--text-secondary)',
                background: 'transparent',
                borderBottom: '1px solid var(--border-glass)',
                borderRadius: 0
              }}
            >
              {sideCollapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
            </button>
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  className={`app-side-tab${active ? ' is-active' : ''}`}
                  onClick={() => openSideTab(tab.id)}
                  title={tab.label}
                  aria-label={tab.label}
                  aria-current={active ? 'page' : undefined}
                  style={{
                    width: sideCollapsed ? 58 : 72,
                    height: 58,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: active ? 'var(--primary-color)' : 'var(--text-secondary)',
                    background: active ? 'rgba(99,102,241,0.04)' : 'transparent',
                    borderRight: active ? '3px solid var(--primary-color)' : '3px solid transparent',
                    borderRadius: 0
                  }}
                >
                  <Icon size={15} />
                  {!sideCollapsed && <span className="app-side-tabs__label">{tab.label}</span>}
                </button>
              );
            })}
          </nav>
        </aside>
        {resizingWorkbench && <div className="workbench-drag-shield" aria-hidden="true" />}
      </main>

      <footer className="app-shell-bar app-footer">
        <div className="app-footer__inner">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, boxShadow: `0 0 8px ${statusColor}` }} />
            <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{statusLabels[status] || status}：{statusText}</span>
          </div>
          <button onClick={() => setLogsExpanded(!logsExpanded)} style={{ background: 'transparent', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.74rem' }}>
            <Terminal size={13} /> 日志
          </button>
        </div>
        {logsExpanded && (
          <div style={{ height: 140, overflowY: 'auto', background: 'var(--bg-panel-solid)', borderTop: '1px solid var(--border-glass)', padding: '10px 14px', fontFamily: 'monospace', fontSize: '0.72rem' }}>
            {logs.map((log) => (
              <div key={log.id} style={{ display: 'flex', gap: 8, marginBottom: 5 }}>
                <span style={{ color: 'var(--text-muted)' }}>[{log.timestamp}]</span>
                <span style={{ color: log.level === 'error' ? 'var(--danger-color)' : log.level === 'success' ? 'var(--success-color)' : log.level === 'warn' ? 'var(--warning-color)' : 'var(--text-secondary)' }}>
                  [{log.level === 'success' ? '成功' : log.level === 'error' ? '错误' : log.level === 'warn' ? '警告' : '信息'}]
                </span>
                <span style={{ color: 'var(--text-primary)' }}>{log.message}</span>
              </div>
            ))}
          </div>
        )}
      </footer>

      {showNotice && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(3,2,8,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div className="glass-panel animate-fade-in" style={{ width: 'min(820px, 100%)', maxHeight: '88vh', overflowY: 'auto', borderRadius: 8, padding: 22, background: 'var(--bg-panel-solid)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 18 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <Bell size={20} style={{ color: 'var(--primary-color)' }} />
                <h2 style={{ color: 'var(--text-primary)', fontSize: '1.05rem' }}>使用公告</h2>
              </div>
              <button onClick={closeNotice} title="关闭公告" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)', width: 30, height: 30, borderRadius: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                <X size={15} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, color: 'var(--text-secondary)', fontSize: '0.82rem', lineHeight: 1.65 }}>
              <section>
                <h3 style={{ color: 'var(--text-primary)', fontSize: '0.9rem', marginBottom: 6 }}>第一步：进入设置</h3>
                <p>打开“设置”，启用“真实 WebView”。启用后才能在内置浏览器里打开学习通页面、保存网页登录状态、抓取真实网页题目和填入答案。登录 Cookie、localStorage、IndexedDB 只保存在本机持久化分区中。</p>
              </section>

              <section>
                <h3 style={{ color: 'var(--text-primary)', fontSize: '0.9rem', marginBottom: 6 }}>第二步：配置搜题方式</h3>
                <p>1. AI 搜题：在“设置”里选择服务商，填写 Base URL、模型和 API Key。可以通过“没有秘钥，前往”打开各服务商控制台说明。API 并发默认 5 路，接口限流时可降低；如果返回余额/额度不足，应用会在日志里提示你去充值、开通计费或更换 Key。</p>
                <p>2. 不想使用 API：在作业页面按 Ctrl+A 全选题目内容，发给任意 AI，让它按下面格式返回，然后到“本地题库”里导入。查询时会优先命中本地题库，未命中才会调用 API。</p>
                <pre style={{ whiteSpace: 'pre-wrap', background: 'rgba(99,102,241,0.08)', border: '1px solid var(--border-glass)', borderRadius: 8, padding: 12, color: 'var(--text-primary)', fontSize: '0.75rem', lineHeight: 1.55, marginTop: 8 }}>{`题目：示例选择题题干
A. 选项一
B. 选项二
答案：A
解析：这里可以写解析

题目：示例填空题题干
答案：填空答案`}</pre>
              </section>

              <section>
                <h3 style={{ color: 'var(--text-primary)', fontSize: '0.9rem', marginBottom: 6 }}>第三步：开始答题</h3>
                <p>进入作业或考试页面后，打开“答题”页，先选择 API AI 或网页 AI，再按“获取页面题目 → 解析 → 核对 → 填入”的顺序操作。英语阅读、完形填空、七选五等页面会把文章上下文和小题一起抓取，填空题会按多个空的顺序写入并同步可见输入框和隐藏答案字段。</p>
              </section>

              <section>
                <h3 style={{ color: 'var(--text-primary)', fontSize: '0.9rem', marginBottom: 6 }}>第四步：查看统计与排错</h3>
                <p>“Token”页会展示 API 消耗热力图、模型排行和调用明细；“错误报告”页会收集页面跳转、填入、提交、接口失败等日志。发生问题时先看这两个页面，可以更快定位是题目抓取、API、填入还是网站页面本身的问题。</p>
              </section>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={closeNotice} style={{ background: 'linear-gradient(135deg, var(--primary-color), var(--accent-color))', color: '#fff', padding: '10px 18px', borderRadius: 8, fontWeight: 900 }}>
                我知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
