import React, { useEffect, useState } from 'react';
import { AIPanel } from './components/AIPanel';
import { AnnouncementBanner } from './components/AnnouncementBanner';
import { BrowserPanel } from './components/BrowserPanel';
import { BugReportPanel } from './components/BugReportPanel';
import { ChapterLearningPanel } from './components/ChapterLearningPanel';
import { HistoryPanel } from './components/HistoryPanel';
import { KnowledgeBase } from './components/KnowledgeBase';
import { SettingsPanel } from './components/SettingsPanel';
import { TokenUsagePanel } from './components/TokenUsagePanel';
import { appStore, useAppStore } from './store/appStore';
import { Bell, BookOpen, Brain, Bug, ChartNoAxesCombined, Database, History, Minimize2, Settings, Square, Terminal, X } from 'lucide-react';

type TabId = 'automation' | 'chapter' | 'snapshot' | 'tokens' | 'history' | 'bugs' | 'settings';

const tabs: { id: TabId; label: string; icon: typeof Brain }[] = [
  { id: 'automation', label: '自动化', icon: Brain },
  { id: 'chapter', label: '章节学习', icon: BookOpen },
  { id: 'snapshot', label: '页面快照', icon: Database },
  { id: 'tokens', label: 'Token', icon: ChartNoAxesCombined },
  { id: 'history', label: '运行记录', icon: History },
  { id: 'bugs', label: '错误报告', icon: Bug },
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
  learning: '章节学习',
  done: '完成',
  error: '错误'
};

const START_NOTICE_KEY = 'studypilot_start_notice_v2';

export default function App() {
  const { status, statusText, logs, settings, isElectron } = useAppStore();
  const [activeTab, setActiveTab] = useState<TabId>('automation');
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [showNotice, setShowNotice] = useState(false);

  useEffect(() => {
    const seen = localStorage.getItem(START_NOTICE_KEY);
    if (!seen) setShowNotice(true);
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

  const statusColor = status === 'error'
    ? '#ef4444'
    : status === 'done'
      ? '#10b981'
      : status === 'executing'
        ? '#f59e0b'
        : '#6366f1';

  return (
    <div data-theme={settings.theme} style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg-app)', color: 'var(--text-primary)', overflow: 'hidden' }}>
      <header className="app-shell-bar" style={{ height: 40, borderBottom: '1px solid var(--border-glass)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 14px', userSelect: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Brain size={18} style={{ color: 'var(--primary-color)' }} />
          <span style={{ color: 'var(--text-primary)', fontWeight: 800, fontSize: '0.9rem' }}>学习通答题辅助工具</span>
          <span className="badge badge-primary" style={{ fontSize: '0.62rem', padding: '1px 7px' }}>v2</span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={() => windowAction('minimize')} title="最小化" style={{ background: 'transparent', color: 'var(--text-secondary)', padding: '6px 10px', borderRadius: 4 }}>
            <Minimize2 size={12} />
          </button>
          <button onClick={() => windowAction('maximize')} title="最大化" style={{ background: 'transparent', color: 'var(--text-secondary)', padding: '6px 10px', borderRadius: 4 }}>
            <Square size={10} />
          </button>
          <button onClick={() => windowAction('close')} title="关闭" style={{ background: 'transparent', color: 'var(--text-secondary)', padding: '6px 10px', borderRadius: 4 }}>
            <X size={12} />
          </button>
        </div>
      </header>

      <main style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <section style={{ width: '62%', minWidth: 0, borderRight: '1px solid var(--border-glass)', background: 'var(--bg-panel)' }}>
          <BrowserPanel />
        </section>
        <section style={{ width: '38%', minWidth: 360, display: 'flex', flexDirection: 'column', background: 'var(--bg-panel)' }}>
          <div className="app-side-tabs" style={{ display: 'flex', borderBottom: '1px solid var(--border-glass)', overflowX: 'auto' }}>
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  style={{
                    flex: '0 0 auto',
                    minWidth: 78,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    padding: '12px 0',
                    color: active ? 'var(--primary-color)' : 'var(--text-secondary)',
                    background: active ? 'rgba(99,102,241,0.04)' : 'transparent',
                    borderBottom: active ? '2px solid var(--primary-color)' : '2px solid transparent',
                    fontSize: '0.78rem',
                    fontWeight: active ? 800 : 600
                  }}
                >
                  <Icon size={14} />
                  {tab.label}
                </button>
              );
            })}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <AnnouncementBanner />
            <div className="side-panel-content" style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <div key={activeTab} className="side-panel-page">
                {activeTab === 'automation' && <AIPanel />}
                {activeTab === 'chapter' && <ChapterLearningPanel />}
                {activeTab === 'snapshot' && <KnowledgeBase />}
                {activeTab === 'tokens' && <TokenUsagePanel />}
                {activeTab === 'history' && <HistoryPanel />}
                {activeTab === 'bugs' && <BugReportPanel />}
                {activeTab === 'settings' && <SettingsPanel />}
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="app-shell-bar" style={{ borderTop: '1px solid var(--border-glass)' }}>
        <div style={{ height: 34, padding: '0 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--text-secondary)', fontSize: '0.74rem' }}>
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
                <p>2. 不想使用 API：在作业页面按 Ctrl+A 全选题目内容，发给任意 AI，让它按下面格式返回，然后到“页面快照/本地题库”里导入。查询时会优先命中本地题库，未命中才会调用 API。</p>
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
                <p>进入作业或考试页面后，先点击“获取页面题目”，再点击“开始解析”或“自动化填入”。如果已有解析答案，可以直接点击“开始填入”。英语阅读、完形填空、七选五等页面会把文章上下文和小题一起抓取，填空题会尝试同步可见输入框和隐藏答案字段。</p>
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
