import React, { useState } from 'react';
import { AlertCircle, X } from 'lucide-react';

export function AnnouncementBanner() {
  const [dismissed, setDismissed] = useState(() => {
    return localStorage.getItem('studypilot_announcement_dismissed_v1') === 'true';
  });

  const handleDismiss = () => {
    setDismissed(true);
    localStorage.setItem('studypilot_announcement_dismissed_v1', 'true');
  };

  if (dismissed) return null;

  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(99,102,241,0.15), rgba(168,85,247,0.15))',
      border: '1px solid rgba(99,102,241,0.3)',
      borderRadius: 8,
      padding: 16,
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
          <h4 style={{ color: '#fff', fontSize: '0.9rem', marginBottom: 8, fontWeight: 600 }}>
            使用说明
          </h4>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.7 }}>
            <p style={{ margin: '0 0 8px 0' }}>
              <strong>1. API配置：</strong>在"设置"中配置AI提供商（阿里云DashScope、DeepSeek、百度文心等），填入API密钥和模型名称。
            </p>
            <p style={{ margin: '0 0 8px 0' }}>
              <strong>2. 题库管理：</strong>在"知识库"中可查看和管理题目答案，支持手动添加、批量导入。
            </p>
            <p style={{ margin: '0 0 8px 0' }}>
              <strong>3. 答题助手：</strong>打开学习通题目页面，点击"AI面板"扫描题目，系统会自动调用AI获取答案并填入。
            </p>
            <p style={{ margin: '0 0 0 0' }}>
              <strong>4. 章节学习：</strong>在"章节学习"中启用自动播放视频/音频、阅读文档等功能，完成后自动切换下一章节。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
