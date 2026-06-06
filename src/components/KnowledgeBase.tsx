import React from 'react';
import { Database, FileSearch, Trash2 } from 'lucide-react';
import { appStore, useAppStore } from '../store/appStore';

export function KnowledgeBase() {
  const { snapshot, questionBank } = useAppStore();

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflowY: 'auto' }}>
      <div className="glass-panel" style={{ padding: 18, borderRadius: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Database size={18} style={{ color: 'var(--primary-color)' }} />
            <h4 style={{ color: '#fff', fontSize: '0.95rem' }}>本地题库</h4>
          </div>
          {questionBank.length > 0 && (
            <button
              onClick={() => appStore.clearQuestionBank()}
              style={{ background: 'rgba(239,68,68,0.12)', color: 'var(--danger-color)', padding: '7px 9px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', fontWeight: 700 }}
            >
              <Trash2 size={13} /> 清空题库
            </button>
          )}
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.55 }}>
          AI 解析成功后会自动保存到题库。再次遇到相同题目时，会优先从题库返回答案，不再请求 AI。
        </p>
      </div>

      <div className="glass-panel" style={{ padding: 14, borderRadius: 8, color: 'var(--text-secondary)', fontSize: '0.78rem', lineHeight: 1.6 }}>
        <div><strong style={{ color: '#fff' }}>题库数量：</strong>{questionBank.length} 题</div>
        {snapshot && (
          <>
            <div><strong style={{ color: '#fff' }}>当前页面：</strong>{snapshot.title}</div>
            <div><strong style={{ color: '#fff' }}>捕获时间：</strong>{new Date(snapshot.capturedAt).toLocaleString()}</div>
          </>
        )}
      </div>

      {questionBank.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '40px 20px', display: 'flex', alignItems: 'center', flexDirection: 'column', gap: 10 }}>
          <FileSearch size={28} />
          <p style={{ fontSize: '0.8rem' }}>题库还是空的。请先抓题并解析答案。</p>
        </div>
      ) : (
        questionBank.slice(0, 80).map((entry) => (
          <div key={entry.id} className="glass-panel" style={{ padding: 14, borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
              <h5 style={{ color: '#fff', fontSize: '0.84rem', lineHeight: 1.45 }}>{entry.question}</h5>
              <span className="badge badge-success">命中 {entry.hits}</span>
            </div>
            <div style={{ color: '#34d399', fontSize: '0.82rem', fontWeight: 800, marginBottom: 8 }}>{entry.answer.answer}</div>
            {entry.options.length > 0 && (
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.72rem', lineHeight: 1.5 }}>
                {entry.options.slice(0, 4).join(' / ')}
              </div>
            )}
            <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem', marginTop: 8 }}>
              更新：{new Date(entry.updatedAt).toLocaleString()} · 来源：{entry.answer.provider}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
