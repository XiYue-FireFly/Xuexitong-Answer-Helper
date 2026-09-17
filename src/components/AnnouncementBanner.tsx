import React, { useState } from 'react';
import { AlertCircle, ChevronDown, X } from 'lucide-react';

const ANNOUNCEMENT_DISMISSED_KEY = 'studypilot_announcement_dismissed_v3';

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
            操作公告（最新）
          </h4>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', lineHeight: 1.65 }}>
            <p style={{ margin: '0 0 6px 0' }}>
              <strong>推荐流程：</strong>设置中启用真实 WebView，配置 AI 或导入本地题库，进入作业/考试页后先抓题，再解析，最后填入。
            </p>
            <p style={{ margin: '0 0 6px 0' }}>
              <strong>网页 AI 使用步骤：</strong>①&nbsp;抓题 → ②&nbsp;打开网页 AI（选择 DeepSeek / 豆包 / 千问）→ ③&nbsp;登录后填入提示词 → ④&nbsp;等待 AI 生成完成后提取答案 → ⑤&nbsp;确认入库 → ⑥&nbsp;开始填入原页面。
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
                <p style={{ margin: 0, borderTop: '1px solid var(--border-glass)', paddingTop: 6 }}>
                  <strong>网页 AI 详细说明：</strong>
                </p>
                <p style={{ margin: 0 }}>① <strong>开始抓题</strong>：前往题目页面，点击抓题按钮抓取当前页题目，回到网页 AI 选择题目后点击"生成提示词"。</p>
                <p style={{ margin: 0 }}>② <strong>打开网页 AI</strong>：选择 AI 网站（DeepSeek / 豆包 / 千问），点击"打开"在应用内或系统浏览器中打开 AI 聊天页。</p>
                <p style={{ margin: 0 }}>③ <strong>填入提示词</strong>：若 AI 网站尚未登录，请先完成登录。登录后回到此处，点击"发送提示词到 AI"自动填入并提交。</p>
                <p style={{ margin: 0 }}>④ <strong>提取答案</strong>：等待 AI 生成完毕，点击"从 AI 页面提取答案"自动读取回答内容；也可手动复制粘贴到文本框。</p>
                <p style={{ margin: 0 }}>⑤ <strong>录入题库</strong>：预览解析结果无误后，点击"确认入库"将答案保存到本地题库，支持多批次连续处理。</p>
                <p style={{ margin: 0 }}>⑥ <strong>开始填入</strong>：入库完成后，点击"确认填入到原页面"自动将答案写回原题目页面（需应用内浏览器模式）。</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

