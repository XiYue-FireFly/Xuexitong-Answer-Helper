import React, { useMemo, useState } from 'react';
import { BarChart3, CalendarDays, Clock3, DatabaseZap, ListFilter, Trash2 } from 'lucide-react';
import { appStore, useAppStore } from '../store/appStore';
import type { TokenUsageRecord } from '../store/appStore';

type RangeKey = '7d' | '30d' | 'all';
type UsageMode = 'overview' | 'models';
type SortKey = 'time' | 'total' | 'input' | 'output' | 'model';

function formatToken(value: number) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(value >= 10000000 ? 1 : 2)}M`;
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

function dayKey(timestamp: number) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function inRange(record: TokenUsageRecord, range: RangeKey) {
  if (range === 'all') return true;
  const days = range === '7d' ? 7 : 30;
  return record.createdAt >= Date.now() - days * 24 * 60 * 60 * 1000;
}

function modelRows(records: TokenUsageRecord[]) {
  const byModel = new Map<string, {
    provider: string;
    model: string;
    total: number;
    input: number;
    output: number;
    calls: number;
  }>();
  for (const record of records) {
    const key = `${record.provider}::${record.model}`;
    const row = byModel.get(key) || {
      provider: record.provider,
      model: record.model,
      total: 0,
      input: 0,
      output: 0,
      calls: 0
    };
    row.total += record.totalTokens;
    row.input += record.promptTokens;
    row.output += record.completionTokens;
    row.calls += 1;
    byModel.set(key, row);
  }
  return Array.from(byModel.values()).sort((left, right) => right.total - left.total);
}

function buildHeatmap(records: TokenUsageRecord[], range: RangeKey) {
  const days = range === '7d' ? 49 : range === '30d' ? 84 : 168;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const map = new Map<string, number>();
  records.forEach((record) => {
    const key = dayKey(record.createdAt);
    map.set(key, (map.get(key) || 0) + record.totalTokens);
  });
  const cells = Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (days - index - 1));
    const key = dayKey(date.getTime());
    return {
      key,
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      value: map.get(key) || 0
    };
  });
  const max = Math.max(1, ...cells.map((cell) => cell.value));
  return cells.map((cell) => ({
    ...cell,
    level: cell.value <= 0 ? 0 : Math.max(1, Math.ceil((cell.value / max) * 4))
  }));
}

export function TokenUsagePanel() {
  const { tokenUsage } = useAppStore();
  const [range, setRange] = useState<RangeKey>('30d');
  const [mode, setMode] = useState<UsageMode>('overview');
  const [sortKey, setSortKey] = useState<SortKey>('time');
  const filtered = useMemo(() => tokenUsage.filter((record) => inRange(record, range)), [tokenUsage, range]);
  const totalTokens = filtered.reduce((sum, record) => sum + record.totalTokens, 0);
  const inputTokens = filtered.reduce((sum, record) => sum + record.promptTokens, 0);
  const outputTokens = filtered.reduce((sum, record) => sum + record.completionTokens, 0);
  const activeDays = new Set(filtered.map((record) => dayKey(record.createdAt))).size;
  const peakRecord = filtered.reduce((best, record) => record.totalTokens > (best?.totalTokens || 0) ? record : best, null as TokenUsageRecord | null);
  const rows = modelRows(filtered);
  const heatmap = buildHeatmap(filtered, range);
  const sortedRecords = [...filtered].sort((left, right) => {
    if (sortKey === 'total') return right.totalTokens - left.totalTokens;
    if (sortKey === 'input') return right.promptTokens - left.promptTokens;
    if (sortKey === 'output') return right.completionTokens - left.completionTokens;
    if (sortKey === 'model') return `${left.provider}${left.model}`.localeCompare(`${right.provider}${right.model}`);
    return right.createdAt - left.createdAt;
  });

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
        <div>
          <h5 style={{ color: 'var(--text-primary)', fontSize: '0.92rem', marginBottom: 4 }}>Token 消耗统计</h5>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.72rem', lineHeight: 1.45 }}>
            仅统计本应用收到的 API usage 字段；本地题库命中和无 usage 的接口不会计入。
          </p>
        </div>
        {tokenUsage.length > 0 && (
          <button className="btn btn-danger" onClick={() => appStore.clearTokenUsage()} style={{ color: 'var(--danger-color)' }}>
            <Trash2 size={14} /> 清空
          </button>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div className="glass-panel" style={{ padding: 4, display: 'flex', gap: 4, borderRadius: 8 }}>
          {[
            { key: 'overview', label: '总览' },
            { key: 'models', label: '模型' }
          ].map((item) => (
            <button
              key={item.key}
              onClick={() => setMode(item.key as UsageMode)}
              className="btn"
              style={{
                minHeight: 32,
                padding: '6px 12px',
                background: mode === item.key ? 'rgba(99,102,241,0.22)' : 'transparent',
                color: mode === item.key ? 'var(--text-primary)' : 'var(--text-secondary)'
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="glass-panel" style={{ padding: 4, display: 'flex', gap: 4, borderRadius: 8 }}>
          {[
            { key: 'all', label: '全部' },
            { key: '30d', label: '30天' },
            { key: '7d', label: '7天' }
          ].map((item) => (
            <button
              key={item.key}
              onClick={() => setRange(item.key as RangeKey)}
              className="btn"
              style={{
                minHeight: 32,
                padding: '6px 12px',
                background: range === item.key ? 'rgba(99,102,241,0.22)' : 'transparent',
                color: range === item.key ? 'var(--text-primary)' : 'var(--text-secondary)'
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
        {[
          { label: '累计 Token', value: formatToken(totalTokens), icon: DatabaseZap },
          { label: '输入 / 输出', value: `${formatToken(inputTokens)} / ${formatToken(outputTokens)}`, icon: BarChart3 },
          { label: '活跃天数', value: `${activeDays} 天`, icon: CalendarDays },
          { label: '峰值单次', value: peakRecord ? formatToken(peakRecord.totalTokens) : '0', icon: Clock3 }
        ].map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="glass-panel" style={{ padding: 14, borderRadius: 8, minHeight: 82 }}>
              <Icon size={16} style={{ color: 'var(--primary-color)', marginBottom: 8 }} />
              <div style={{ color: 'var(--text-primary)', fontSize: '1.05rem', fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>{item.value}</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.72rem', marginTop: 3 }}>{item.label}</div>
            </div>
          );
        })}
      </div>

      {mode === 'overview' && (
        <div className="glass-panel" style={{ padding: 16, borderRadius: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h6 style={{ color: 'var(--text-primary)', fontSize: '0.82rem' }}>Token 活动</h6>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.68rem' }}>颜色越深表示当天消耗越多</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(14, minmax(10px, 1fr))', gap: 5 }}>
            {heatmap.map((cell) => (
              <div
                key={cell.key}
                title={`${cell.key}：${formatToken(cell.value)} Token`}
                style={{
                  aspectRatio: '1 / 1',
                  borderRadius: 5,
                  background: cell.level === 0
                    ? 'rgba(255,255,255,0.055)'
                    : `rgba(59,130,246,${0.18 + cell.level * 0.16})`,
                  border: '1px solid rgba(255,255,255,0.035)'
                }}
              />
            ))}
          </div>
        </div>
      )}

      {mode === 'models' && (
        <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h6 style={{ color: 'var(--text-primary)', fontSize: '0.82rem' }}>模型消耗排行</h6>
          {rows.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem', textAlign: 'center', padding: '24px 0' }}>还没有可统计的 Token 数据。</div>
          ) : rows.map((row) => (
            <div key={`${row.provider}-${row.model}`} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 12, alignItems: 'center' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: 'var(--text-primary)', fontSize: '0.78rem', fontWeight: 850, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.model}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem', marginTop: 2 }}>{row.provider} · {row.calls} 次</div>
                <div style={{ marginTop: 6, height: 7, borderRadius: 99, background: 'rgba(255,255,255,0.055)', overflow: 'hidden' }}>
                  <div style={{ width: `${Math.max(4, (row.total / Math.max(1, rows[0].total)) * 100)}%`, height: '100%', background: 'linear-gradient(90deg, #60a5fa, #2563eb)' }} />
                </div>
              </div>
              <div style={{ textAlign: 'right', color: 'var(--text-primary)', fontSize: '0.78rem', fontWeight: 900 }}>
                {formatToken(row.total)}
                <div style={{ color: 'var(--text-muted)', fontSize: '0.66rem', fontWeight: 600 }}>{formatToken(row.input)} in · {formatToken(row.output)} out</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
          <h6 style={{ color: 'var(--text-primary)', fontSize: '0.82rem' }}>调用明细</h6>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: '0.7rem' }}>
            <ListFilter size={13} /> 点击表头排序
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="usage-table">
            <thead>
              <tr>
                <th><button onClick={() => setSortKey('time')}>时间</button></th>
                <th><button onClick={() => setSortKey('model')}>模型</button></th>
                <th><button onClick={() => setSortKey('input')}>输入</button></th>
                <th><button onClick={() => setSortKey('output')}>输出</button></th>
                <th><button onClick={() => setSortKey('total')}>合计</button></th>
              </tr>
            </thead>
            <tbody>
              {sortedRecords.slice(0, 160).map((record) => (
                <tr key={record.id}>
                  <td>{new Date(record.createdAt).toLocaleString()}</td>
                  <td>
                    <div style={{ color: 'var(--text-primary)', fontWeight: 800 }}>{record.model}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.66rem' }}>{record.provider} · {record.source === 'test' ? '测试' : `第 ${record.questionIndex || '?'} 题`}</div>
                  </td>
                  <td>{formatToken(record.promptTokens)}</td>
                  <td>{formatToken(record.completionTokens)}</td>
                  <td>{formatToken(record.totalTokens)}</td>
                </tr>
              ))}
              {sortedRecords.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '26px 0' }}>暂无 Token 使用记录。</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
