import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Bug, Clock, ExternalLink, RefreshCw } from 'lucide-react';
import { appStore, useAppStore } from '../store/appStore';

type ErrorReportEntry = {
  timestamp?: string;
  level?: 'info' | 'warn' | 'error' | 'fatal' | string;
  source?: string;
  message?: string;
  url?: string;
  stack?: string;
  details?: unknown;
};

type ErrorReportResult = {
  success?: boolean;
  path?: string;
  entries?: ErrorReportEntry[];
  error?: string;
};

function formatTime(value?: string) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function levelLabel(level?: string) {
  if (level === 'fatal') return '严重';
  if (level === 'error') return '错误';
  if (level === 'warn') return '警告';
  return '信息';
}

function levelColor(level?: string) {
  if (level === 'fatal' || level === 'error') return 'var(--danger-color)';
  if (level === 'warn') return 'var(--warning-color)';
  return 'var(--text-secondary)';
}

export function BugReportPanel() {
  const { isElectron } = useAppStore();
  const [result, setResult] = useState<ErrorReportResult>({ entries: [] });
  const [isLoading, setIsLoading] = useState(false);

  const entries = result.entries || [];
  const stats = useMemo(() => {
    const errors = entries.filter((entry) => entry.level === 'error' || entry.level === 'fatal').length;
    const warnings = entries.filter((entry) => entry.level === 'warn').length;
    return { errors, warnings, total: entries.length };
  }, [entries]);

  const refreshReports = async () => {
    if (!isElectron || !(window as any).electronAPI?.getRecentErrorLogs) {
      setResult({ success: false, error: '仅 Electron 桌面应用支持错误报告台。', entries: [] });
      return;
    }
    setIsLoading(true);
    try {
      const response = await (window as any).electronAPI.getRecentErrorLogs(120);
      setResult(response || { entries: [] });
      if (response?.success) appStore.addLog('info', `错误报告已刷新：${response.entries?.length || 0} 条。`);
    } catch (error: any) {
      setResult({ success: false, error: error?.message || '读取错误报告失败。', entries: [] });
      appStore.addLog('error', `读取错误报告失败：${error?.message || '未知错误'}`);
    } finally {
      setIsLoading(false);
    }
  };

  const showLogFile = async () => {
    if (!result.path) return;
    try {
      await navigator.clipboard?.writeText(result.path);
      appStore.addLog('success', '日志文件路径已复制。');
    } catch {
      appStore.addLog('info', `日志文件位置：${result.path}`);
    }
  };

  useEffect(() => {
    refreshReports();
    const timer = window.setInterval(refreshReports, 10000);
    return () => window.clearInterval(timer);
  }, [isElectron]);

  return (
    <div style={{ padding: 18, height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Bug size={18} style={{ color: 'var(--danger-color)' }} />
            <h4 style={{ color: 'var(--text-primary)', fontSize: '0.95rem' }}>错误报告台</h4>
          </div>
          <button
            onClick={refreshReports}
            disabled={isLoading}
            style={{ background: 'rgba(99,102,241,0.14)', color: 'var(--text-primary)', padding: '8px 10px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 6, fontWeight: 800 }}
          >
            <RefreshCw size={14} style={{ animation: isLoading ? 'spin 1s linear infinite' : undefined }} /> 刷新
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          <div style={{ border: '1px solid var(--border-glass)', borderRadius: 8, padding: 10, background: 'rgba(239,68,68,0.08)' }}>
            <div style={{ color: 'var(--danger-color)', fontSize: '1rem', fontWeight: 900 }}>{stats.errors}</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem' }}>错误</div>
          </div>
          <div style={{ border: '1px solid var(--border-glass)', borderRadius: 8, padding: 10, background: 'rgba(245,158,11,0.08)' }}>
            <div style={{ color: 'var(--warning-color)', fontSize: '1rem', fontWeight: 900 }}>{stats.warnings}</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem' }}>警告</div>
          </div>
          <div style={{ border: '1px solid var(--border-glass)', borderRadius: 8, padding: 10, background: 'rgba(99,102,241,0.08)' }}>
            <div style={{ color: 'var(--primary-color)', fontSize: '1rem', fontWeight: 900 }}>{stats.total}</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem' }}>总数</div>
          </div>
        </div>

        {result.path && (
          <button
            onClick={showLogFile}
            style={{ alignSelf: 'flex-start', background: 'transparent', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.72rem' }}
          >
            <ExternalLink size={13} /> 复制日志路径
          </button>
        )}
      </div>

      {result.error && (
        <div className="glass-panel" style={{ padding: 14, borderRadius: 8, borderLeft: '4px solid var(--danger-color)', color: 'var(--danger-color)', fontSize: '0.78rem' }}>
          {result.error}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {entries.length === 0 ? (
          <div className="glass-panel" style={{ padding: 24, borderRadius: 8, color: 'var(--text-muted)', textAlign: 'center', fontSize: '0.8rem' }}>
            暂无错误报告。你操作应用后，这里会自动刷新显示后台报告。
          </div>
        ) : entries.map((entry, index) => (
          <div key={`${entry.timestamp}-${entry.source}-${index}`} className="glass-panel" style={{ padding: 14, borderRadius: 8, borderLeft: `4px solid ${levelColor(entry.level)}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <AlertTriangle size={14} style={{ color: levelColor(entry.level) }} />
                <span style={{ color: levelColor(entry.level), fontWeight: 900, fontSize: '0.76rem' }}>{levelLabel(entry.level)}</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 800, fontSize: '0.76rem' }}>{entry.source || 'unknown'}</span>
              </div>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Clock size={12} /> {formatTime(entry.timestamp)}
              </span>
            </div>
            <div style={{ color: 'var(--text-primary)', fontSize: '0.78rem', lineHeight: 1.55, wordBreak: 'break-word' }}>{entry.message || '无错误消息'}</div>
            {entry.url && <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem', wordBreak: 'break-all' }}>{entry.url}</div>}
            {entry.stack && (
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 160, overflowY: 'auto', background: 'rgba(0,0,0,0.22)', border: '1px solid var(--border-glass)', borderRadius: 8, padding: 10, color: 'var(--text-secondary)', fontSize: '0.68rem' }}>
                {entry.stack}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
