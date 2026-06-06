import React, { useState } from 'react';
import { Clock, Search, Trash2 } from 'lucide-react';
import { appStore, useAppStore } from '../store/appStore';

export function HistoryPanel() {
  const { history, answerHistory } = useAppStore();
  const [query, setQuery] = useState('');

  const filtered = history.filter((plan) => {
    const haystack = `${plan.goal} ${plan.result || ''} ${plan.steps.map((step) => step.label).join(' ')}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  });

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h5 style={{ color: '#fff', fontSize: '0.9rem' }}>历史记录</h5>
        <div style={{ display: 'flex', gap: 8 }}>
          {answerHistory.length > 0 && (
            <button onClick={() => appStore.clearAnswerHistory()} style={{ background: 'transparent', color: 'var(--warning-color)', display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.75rem' }}>
              <Trash2 size={13} /> 清空答案
            </button>
          )}
          {history.length > 0 && (
            <button onClick={() => appStore.clearHistory()} style={{ background: 'transparent', color: 'var(--danger-color)', display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.75rem' }}>
              <Trash2 size={13} /> 清空运行
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border-glass)', borderRadius: 8, padding: '0 10px', background: 'rgba(255,255,255,0.02)' }}>
        <Search size={14} style={{ color: 'var(--text-muted)' }} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索运行记录..." style={{ flex: 1, border: 'none', background: 'transparent', fontSize: '0.8rem' }} />
      </div>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h6 style={{ color: '#fff', fontSize: '0.82rem' }}>答案搜索记录</h6>
        {answerHistory.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>还没有答案搜索记录。</div>
        ) : (
          answerHistory.map((entry) => (
            <div key={`${entry.question.hash}_${entry.answer.createdAt}`} className="glass-panel" style={{ padding: 14, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span className="badge badge-success">{(entry.answer.confidence * 100).toFixed(0)}%</span>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>{new Date(entry.answer.createdAt).toLocaleString()}</span>
              </div>
              <p style={{ color: '#fff', fontSize: '0.8rem', lineHeight: 1.45 }}>{entry.question.question}</p>
              <div style={{ color: 'var(--success-color)', fontSize: '0.82rem', fontWeight: 800 }}>{entry.answer.answer}</div>
            </div>
          ))
        )}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h6 style={{ color: '#fff', fontSize: '0.82rem' }}>自动化运行记录</h6>
        {filtered.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '24px 0', fontSize: '0.8rem' }}>
            没有找到自动化运行记录。
          </div>
        ) : (
          filtered.map((plan) => (
            <div key={plan.id} className="glass-panel" style={{ padding: 14, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className={`badge ${plan.risk === 'medium' ? 'badge-warning' : 'badge-success'}`}>{plan.source}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                  <Clock size={11} /> {new Date(plan.executedAt || plan.createdAt).toLocaleString()}
                </span>
              </div>
              <p style={{ color: '#fff', fontSize: '0.82rem', lineHeight: 1.45 }}>{plan.goal}</p>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', lineHeight: 1.5 }}>
                {plan.result || `已准备 ${plan.steps.length} 个步骤`}
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
