import React, { useState } from 'react';
import { AIPanel } from './components/AIPanel';
import { BrowserPanel } from './components/BrowserPanel';
import { HistoryPanel } from './components/HistoryPanel';
import { KnowledgeBase } from './components/KnowledgeBase';
import { SettingsPanel } from './components/SettingsPanel';
import { appStore, useAppStore } from './store/appStore';
import { Brain, Database, History, Minimize2, Settings, Square, Terminal, X } from 'lucide-react';

type TabId = 'automation' | 'snapshot' | 'history' | 'settings';

const tabs: { id: TabId; label: string; icon: typeof Brain }[] = [
  { id: 'automation', label: '自动化', icon: Brain },
  { id: 'snapshot', label: '页面快照', icon: Database },
  { id: 'history', label: '运行记录', icon: History },
  { id: 'settings', label: '设置', icon: Settings }
];

const statusLabels: Record<string, string> = {
  idle: '空闲',
  scanning: '扫描中',
  planning: '计划中',
  awaiting_approval: '待批准',
  executing: '执行中',
  done: '完成',
  error: '错误'
};

export default function App() {
  const { status, statusText, logs, settings, isElectron } = useAppStore();
  const [activeTab, setActiveTab] = useState<TabId>('automation');
  const [logsExpanded, setLogsExpanded] = useState(false);

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
      <header style={{ height: 40, background: '#07060f', borderBottom: '1px solid var(--border-glass)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 14px', userSelect: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Brain size={18} style={{ color: 'var(--primary-color)' }} />
          <span style={{ color: '#fff', fontWeight: 800, fontSize: '0.9rem' }}>StudyPilot 网页自动化</span>
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
        <section style={{ width: '62%', minWidth: 0, borderRight: '1px solid var(--border-glass)', background: 'rgba(5,4,9,0.4)' }}>
          <BrowserPanel />
        </section>
        <section style={{ width: '38%', minWidth: 360, display: 'flex', flexDirection: 'column', background: 'var(--bg-panel)' }}>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border-glass)', background: 'rgba(7,6,15,0.5)' }}>
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  style={{
                    flex: 1,
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
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            {activeTab === 'automation' && <AIPanel />}
            {activeTab === 'snapshot' && <KnowledgeBase />}
            {activeTab === 'history' && <HistoryPanel />}
            {activeTab === 'settings' && <SettingsPanel />}
          </div>
        </section>
      </main>

      <footer style={{ background: '#07060f', borderTop: '1px solid var(--border-glass)' }}>
        <div style={{ height: 34, padding: '0 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--text-secondary)', fontSize: '0.74rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, boxShadow: `0 0 8px ${statusColor}` }} />
            <span style={{ color: '#e2e8f0', fontWeight: 700 }}>{statusLabels[status] || status}：{statusText}</span>
          </div>
          <button onClick={() => setLogsExpanded(!logsExpanded)} style={{ background: 'transparent', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.74rem' }}>
            <Terminal size={13} /> 日志
          </button>
        </div>
        {logsExpanded && (
          <div style={{ height: 140, overflowY: 'auto', background: '#030206', borderTop: '1px solid var(--border-glass)', padding: '10px 14px', fontFamily: 'monospace', fontSize: '0.72rem' }}>
            {logs.map((log) => (
              <div key={log.id} style={{ display: 'flex', gap: 8, marginBottom: 5 }}>
                <span style={{ color: 'var(--text-muted)' }}>[{log.timestamp}]</span>
                <span style={{ color: log.level === 'error' ? 'var(--danger-color)' : log.level === 'success' ? 'var(--success-color)' : log.level === 'warn' ? 'var(--warning-color)' : 'var(--text-secondary)' }}>
                  [{log.level === 'success' ? '成功' : log.level === 'error' ? '错误' : log.level === 'warn' ? '警告' : '信息'}]
                </span>
                <span style={{ color: '#cbd5e1' }}>{log.message}</span>
              </div>
            ))}
          </div>
        )}
      </footer>
    </div>
  );
}
