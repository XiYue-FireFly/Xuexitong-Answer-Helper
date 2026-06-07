import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, Loader2, Lock, Save, Send, Shield, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import { AIProviderConfig, appStore, useAppStore } from '../store/appStore';

type TestChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export function SettingsPanel() {
  const { settings, isElectron } = useAppStore();
  const [selectedProviderId, setSelectedProviderId] = useState(settings.activeProviderId);
  const [showKey, setShowKey] = useState(false);
  const [isClearingSession, setIsClearingSession] = useState(false);
  const [isTestingAI, setIsTestingAI] = useState(false);
  const [testInput, setTestInput] = useState('');
  const [testMessages, setTestMessages] = useState<TestChatMessage[]>([]);
  const selectedProvider = settings.providers.find((provider) => provider.id === selectedProviderId) || settings.providers[0];
  const [formData, setFormData] = useState<AIProviderConfig>(selectedProvider);

  useEffect(() => {
    const provider = settings.providers.find((item) => item.id === selectedProviderId) || settings.providers[0];
    setFormData(provider);
  }, [selectedProviderId, settings.providers]);

  const syncSettings = (updates: Partial<typeof settings>) => {
    appStore.updateSettings(updates);
    if (typeof window !== 'undefined' && (window as any).electronAPI) {
      (window as any).electronAPI.setSettings({ ...settings, ...updates });
    }
  };

  const saveProvider = () => {
    appStore.updateProvider(selectedProviderId, formData);
    syncSettings({ activeProviderId: selectedProviderId });
    appStore.addLog('success', `AI 服务已保存：${formData.name}`);
  };

  const testAIChat = async () => {
    const content = testInput.trim();
    if (!content || isTestingAI) return;

    if (!formData.baseUrl.trim() || !formData.model.trim() || !formData.apiKey.trim()) {
      appStore.addLog('error', '请先填写 Base URL、模型和 API Key 后再测试。');
      setTestMessages((prev) => [...prev, { role: 'assistant', content: '测试失败：请先填写 Base URL、模型和 API Key。' }]);
      return;
    }

    const userMessage: TestChatMessage = { role: 'user', content };
    const messagesForRequest = [...testMessages, userMessage].slice(-8);
    setTestMessages((prev) => [...prev, userMessage]);
    setTestInput('');
    setIsTestingAI(true);

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`${formData.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${formData.apiKey}`
        },
        body: JSON.stringify({
          model: formData.model,
          messages: [
            { role: 'system', content: '你是 AI 配置连通性测试助手。请用中文简短回答用户，不要输出 Markdown。' },
            ...messagesForRequest.map((message) => ({ role: message.role, content: message.content }))
          ],
          temperature: 0.2
        }),
        signal: controller.signal
      });
      window.clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`接口返回 ${response.status}：${errorText.slice(0, 500)}`);
      }

      const data = await response.json();
      const answer = String(data.choices?.[0]?.message?.content || '').trim();
      const assistantMessage = answer || '接口已返回，但没有识别到 message.content。';
      setTestMessages((prev) => [...prev, { role: 'assistant', content: assistantMessage }]);
      appStore.addLog('success', `AI 测试成功：${formData.name}`);
    } catch (error: any) {
      const message = error?.name === 'AbortError' ? '请求超时，请检查网络、Base URL 或模型名称。' : error?.message || '未知错误';
      setTestMessages((prev) => [...prev, { role: 'assistant', content: `测试失败：${message}` }]);
      appStore.addLog('error', `AI 测试失败：${message}`);
    } finally {
      window.clearTimeout(timeoutId);
      setIsTestingAI(false);
    }
  };

  const clearWebviewSession = async () => {
    if (!isElectron || !(window as any).electronAPI?.clearWebviewSession) return;
    setIsClearingSession(true);
    try {
      const result = await (window as any).electronAPI.clearWebviewSession();
      if (result?.success) {
        appStore.addLog('success', '网页登录状态已清除，下次进入网站需要重新扫码登录。');
      } else {
        appStore.addLog('error', result?.error || '清除网页登录状态失败。');
      }
    } catch (error: any) {
      appStore.addLog('error', `清除网页登录状态失败：${error.message}`);
    } finally {
      setIsClearingSession(false);
    }
  };

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 18, height: '100%', overflowY: 'auto' }}>
      <div className="glass-panel" style={{ padding: 18, borderRadius: 8, borderLeft: '4px solid var(--warning-color)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <Shield size={18} style={{ color: 'var(--warning-color)' }} />
          <h4 style={{ color: '#fff', fontSize: '0.95rem' }}>产品边界</h4>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.6 }}>
          本应用用于你拥有、运营或明确获得授权的页面。题目抓取和 AI 解析仅作学习辅助，结果不会自动提交。
        </p>
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h5 style={{ color: '#fff', fontSize: '0.9rem' }}>真实页面能力</h5>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
          <div>
            <div style={{ color: '#fff', fontSize: '0.82rem', fontWeight: 700 }}>启用真实 WebView</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.72rem', lineHeight: 1.45 }}>
              {isElectron ? '允许在内嵌浏览器中抓题、扫描和执行已批准计划；网站登录状态会自动保存。' : '仅 Electron 桌面应用可用。'}
            </div>
          </div>
          <button
            onClick={() => syncSettings({ allowRealPageAutomation: !settings.allowRealPageAutomation })}
            disabled={!isElectron}
            style={{ background: 'transparent', color: settings.allowRealPageAutomation ? 'var(--success-color)' : 'var(--text-muted)' }}
          >
            {settings.allowRealPageAutomation ? <ToggleRight size={44} /> : <ToggleLeft size={44} />}
          </button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
          <div>
            <div style={{ color: '#fff', fontSize: '0.82rem', fontWeight: 700 }}>执行前必须批准</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.72rem', lineHeight: 1.45 }}>
              只影响自动化点击/填写，不影响题目抓取和 AI 搜索。
            </div>
          </div>
          <button
            onClick={() => syncSettings({ requireApprovalBeforeExecute: !settings.requireApprovalBeforeExecute })}
            style={{ background: 'transparent', color: settings.requireApprovalBeforeExecute ? 'var(--success-color)' : 'var(--text-muted)' }}
          >
            {settings.requireApprovalBeforeExecute ? <ToggleRight size={44} /> : <ToggleLeft size={44} />}
          </button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
          <div>
            <div style={{ color: '#fff', fontSize: '0.82rem', fontWeight: 700 }}>网页登录状态</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.72rem', lineHeight: 1.45 }}>
              扫码登录后的 Cookie、localStorage 和 IndexedDB 会保存在本机，关闭应用后再次打开仍可继续使用。
            </div>
          </div>
          <button
            onClick={clearWebviewSession}
            disabled={!isElectron || isClearingSession}
            style={{ background: 'rgba(239,68,68,0.12)', color: 'var(--danger-color)', padding: '9px 10px', borderRadius: 8, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6, fontWeight: 700, opacity: !isElectron || isClearingSession ? 0.5 : 1 }}
          >
            <Trash2 size={14} /> {isClearingSession ? '清除中' : '清除登录'}
          </button>
        </div>
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h5 style={{ color: '#fff', fontSize: '0.9rem' }}>AI 搜索答案配置</h5>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ color: 'var(--text-secondary)', fontSize: '0.72rem' }}>服务商</label>
          <select
            value={selectedProviderId}
            onChange={(event) => {
              setSelectedProviderId(event.target.value);
              syncSettings({ activeProviderId: event.target.value });
            }}
          >
            {settings.providers.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.name}</option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ color: 'var(--text-secondary)', fontSize: '0.72rem' }}>名称</label>
          <input value={formData.name} onChange={(event) => setFormData((prev) => ({ ...prev, name: event.target.value }))} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ color: 'var(--text-secondary)', fontSize: '0.72rem' }}>Base URL</label>
          <input value={formData.baseUrl} onChange={(event) => setFormData((prev) => ({ ...prev, baseUrl: event.target.value }))} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ color: 'var(--text-secondary)', fontSize: '0.72rem' }}>模型</label>
          <input value={formData.model} onChange={(event) => setFormData((prev) => ({ ...prev, model: event.target.value }))} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ color: 'var(--text-secondary)', fontSize: '0.72rem' }}>API Key</label>
          <div style={{ position: 'relative' }}>
            <input
              type={showKey ? 'text' : 'password'}
              value={formData.apiKey}
              onChange={(event) => setFormData((prev) => ({ ...prev, apiKey: event.target.value }))}
              placeholder="请输入 API Key"
              style={{ width: '100%', paddingRight: 40 }}
            />
            <button
              onClick={() => setShowKey(!showKey)}
              style={{ position: 'absolute', right: 8, top: 7, background: 'transparent', color: 'var(--text-muted)' }}
              type="button"
            >
              {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>

        <button
          onClick={saveProvider}
          style={{ background: 'linear-gradient(135deg, var(--primary-color), var(--accent-color))', color: '#fff', padding: 10, borderRadius: 8, fontWeight: 800, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6 }}
        >
          <Save size={15} /> 保存 AI 配置
        </button>

        <div style={{ borderTop: '1px solid var(--border-glass)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <h5 style={{ color: '#fff', fontSize: '0.86rem' }}>AI 测试聊天</h5>
            <span className={`badge ${isTestingAI ? 'badge-warning' : testMessages.length > 0 ? 'badge-success' : 'badge-primary'}`}>
              {isTestingAI ? '测试中' : testMessages.length > 0 ? '已测试' : '待测试'}
            </span>
          </div>

          <div style={{ minHeight: 120, maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border-glass)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, background: 'rgba(255,255,255,0.02)' }}>
            {testMessages.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem', textAlign: 'center', padding: '32px 0' }}>暂无测试消息</div>
            ) : (
              testMessages.map((message, index) => (
                <div
                  key={`${message.role}-${index}`}
                  style={{
                    alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '88%',
                    padding: '8px 10px',
                    borderRadius: 8,
                    color: message.role === 'user' ? '#fff' : 'var(--text-primary)',
                    background: message.role === 'user' ? 'rgba(99,102,241,0.32)' : 'rgba(255,255,255,0.06)',
                    border: '1px solid var(--border-glass)',
                    fontSize: '0.78rem',
                    lineHeight: 1.55,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word'
                  }}
                >
                  {message.content}
                </div>
              ))
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'end' }}>
            <textarea
              value={testInput}
              onChange={(event) => setTestInput(event.target.value)}
              rows={3}
              placeholder="输入任意测试消息，例如：请回复一句中文，确认配置可用。"
              style={{ resize: 'vertical', minHeight: 78, fontSize: '0.78rem' }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  testAIChat();
                }
              }}
            />
            <button
              onClick={testAIChat}
              disabled={isTestingAI || !testInput.trim()}
              style={{ background: 'rgba(16,185,129,0.16)', color: '#fff', width: 44, height: 44, borderRadius: 8, display: 'flex', justifyContent: 'center', alignItems: 'center', opacity: isTestingAI || !testInput.trim() ? 0.55 : 1 }}
              title="发送测试消息"
            >
              {isTestingAI ? <Loader2 size={17} /> : <Send size={17} />}
            </button>
          </div>
        </div>
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h5 style={{ color: '#fff', fontSize: '0.9rem' }}>演示地址</h5>
        <input value={settings.mockModeUrl} onChange={(event) => syncSettings({ mockModeUrl: event.target.value })} />
        <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Lock size={12} /> 演示模式不会操作外部页面。
        </div>
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h5 style={{ color: '#fff', fontSize: '0.9rem' }}>主题</h5>
        <select value={settings.theme} onChange={(event) => syncSettings({ theme: event.target.value as 'dark' | 'light' })}>
          <option value="dark">深色</option>
          <option value="light">浅色</option>
        </select>
      </div>
    </div>
  );
}
