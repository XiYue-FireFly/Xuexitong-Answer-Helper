import React, { useState } from 'react';
import { AlertCircle, ChevronDown, X } from 'lucide-react';

const ANNOUNCEMENT_DISMISSED_KEY = 'studypilot_announcement_dismissed_v2';

export function AnnouncementBanner() {
  const [dismissed, setDismissed] = useState(() => {
    return localStorage.getItem(ANNOUNCEMENT_DISMISSED_KEY) === 'true';
  });
  const [expanded, setExpanded] = useState(false);

  const handleDismiss = () => {
    setDismissed(true);
    localStorage.setItem(ANNOUNCEMENT_DISMISSED_KEY, 'true');
  };

  if (dismissed) return null;

  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(99,102,241,0.15), rgba(168,85,247,0.15))',
      border: '1px solid rgba(99,102,241,0.3)',
      borderRadius: 8,
      padding: 14,
      margin: '0 20px 16px 20px',
      position: 'relative'
    }}>
      <button
        onClick={handleDismiss}
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          background: 'transparent',
          border: 'none',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          padding: 4,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 4
        }}
        onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
      >
        <X size={16} />
      </button>

      <div style={{ display: 'flex', gap: 12, paddingRight: 24 }}>
        <AlertCircle size={20} style={{ color: 'var(--primary-color)', flexShrink: 0, marginTop: 2 }} />
        <div style={{ flex: 1 }}>
          <h4 style={{ color: 'var(--text-primary)', fontSize: '0.9rem', marginBottom: 8, fontWeight: 600 }}>
            操作公告
          </h4>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', lineHeight: 1.65 }}>
            <p style={{ margin: '0 0 6px 0' }}>
              <strong>推荐流程：</strong>设置中启用真实 WebView，配置 AI 或导入本地题库，进入作业/考试页后先抓题，再解析，最后填入。
            </p>
            <p style={{ margin: 0 }}>
              <strong>提醒：</strong>API 并发默认 5 路，余额不足或额度不足会在日志中提示；Token 统计页可查看每次调用消耗。
            </p>
            <button
              onClick={() => setExpanded((prev) => !prev)}
              style={{ marginTop: 8, background: 'transparent', color: 'var(--primary-color)', display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 24, fontSize: '0.72rem', fontWeight: 800 }}
            >
              {expanded ? '收起详细说明' : '展开详细说明'}
              <ChevronDown size={13} style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.18s ease' }} />
            </button>
            {expanded && (
              <div className="animate-fade-in" style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                <p style={{ margin: 0 }}>1. AI 搜题会优先查询本地题库；题库未命中才会调用 API，调用成功后会自动入库。</p>
                <p style={{ margin: 0 }}>2. 英语阅读、完形填空、七选五等题型会把文章作为上下文一起交给 AI，避免只抓到小题缺少文章。</p>
                <p style={{ margin: 0 }}>3. 填空题会写入可见输入框，并同步隐藏答案字段；提交前仍建议核对一次。</p>
                <p style={{ margin: 0 }}>4. 如果接口返回 429，请降低并发；如果返回余额/额度不足，请到服务商控制台充值或更换 Key。</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
