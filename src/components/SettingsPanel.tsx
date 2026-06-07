import React, { useEffect, useState } from 'react';
import { ChevronDown, Download, Eye, EyeOff, Loader2, Lock, RefreshCw, Save, Send, Shield, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import { AIProviderConfig, AI_PROVIDER_PRESETS, appStore, useAppStore } from '../store/appStore';

type TestChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type UpdateInfo = {
  success?: boolean;
  currentVersion?: string;
  latestVersion?: string;
  hasUpdate?: boolean;
  releaseUrl?: string;
  downloadUrl?: string;
  assetName?: string;
  publishedAt?: string;
  warning?: string;
  error?: string;
};

type WebviewSessionState = {
  success?: boolean;
  partition?: string;
  persistent?: boolean;
  storagePath?: string;
  error?: string;
};

type SelectOption = {
  label: string;
  value: string;
  note?: string;
};

function CustomSelect({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selectedOption = options.find((option) => option.value === value) || options[0];

  return (
    <div
      className={`custom-select${open ? ' open' : ''}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="custom-select__button"
        aria-label={ariaLabel}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="custom-select__value">{selectedOption?.label || '请选择'}</span>
        <ChevronDown className="custom-select__chevron" size={15} />
      </button>
      {open && (
        <div className="custom-select__menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={`${option.value}-${option.label}`}
                type="button"
                className={`custom-select__option${active ? ' active' : ''}`}
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className="custom-select__option-label">{option.label}</span>
                {option.note && <span className="custom-select__option-note">{option.note}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function extractStreamDelta(payload: any) {
  return String(
    payload?.choices?.[0]?.delta?.content ||
    payload?.choices?.[0]?.message?.content ||
    payload?.output?.text ||
    payload?.text ||
    ''
  );
}

function extractNonStreamAnswer(payload: any) {
  return String(
    payload?.choices?.[0]?.message?.content ||
    payload?.choices?.[0]?.text ||
    payload?.output?.text ||
    payload?.text ||
    ''
  ).trim();
}

function buildAIHeaders(provider: AIProviderConfig) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (provider.authHeader === 'api-key') headers['api-key'] = provider.apiKey;
  else if (provider.authHeader !== 'none') headers.Authorization = `Bearer ${provider.apiKey}`;
  return headers;
}

function authHeaderLabel(authHeader?: AIProviderConfig['authHeader']) {
  if (authHeader === 'api-key') return 'api-key';
  if (authHeader === 'none') return '无需认证';
  return 'Authorization: Bearer';
}

function valueInOptions(value: string, options: { value: string }[]) {
  return options.some((item) => item.value === value);
}

export function SettingsPanel() {
  const { settings, isElectron } = useAppStore();
  const [selectedProviderId, setSelectedProviderId] = useState(settings.activeProviderId);
  const [showKey, setShowKey] = useState(false);
  const [isClearingSession, setIsClearingSession] = useState(false);
  const [isTestingAI, setIsTestingAI] = useState(false);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [webviewSessionState, setWebviewSessionState] = useState<WebviewSessionState | null>(null);
  const [testWaitingText, setTestWaitingText] = useState('');
  const [testInput, setTestInput] = useState('');
  const [testMessages, setTestMessages] = useState<TestChatMessage[]>([]);
  const selectedProvider = settings.providers.find((provider) => provider.id === selectedProviderId) || settings.providers[0];
  const [formData, setFormData] = useState<AIProviderConfig>(selectedProvider);
  const selectedPreset = AI_PROVIDER_PRESETS[selectedProviderId];
  const endpointSelectValue = selectedPreset && valueInOptions(formData.baseUrl, selectedPreset.endpoints) ? formData.baseUrl : '__custom__';
  const modelSelectValue = selectedPreset && valueInOptions(formData.model, selectedPreset.models) ? formData.model : '__custom__';
  const providerOptions = settings.providers.map((provider) => ({ label: provider.name, value: provider.id }));
  const endpointOptions = [
    ...(selectedPreset?.endpoints || [{ label: '自定义 Base URL', value: formData.baseUrl }]),
    ...(selectedPreset?.allowCustomEndpoint ? [{ label: '自定义 Base URL', value: '__custom__' }] : [])
  ];
  const modelOptions = [
    ...(selectedPreset?.models || [{ label: '自定义模型', value: formData.model }]),
    ...(selectedPreset?.allowCustomModel ? [{ label: '自定义模型', value: '__custom__' }] : [])
  ];

  useEffect(() => {
    const provider = settings.providers.find((item) => item.id === selectedProviderId) || settings.providers[0];
    setFormData(provider);
  }, [selectedProviderId, settings.providers]);

  useEffect(() => {
    if (!isTestingAI) {
      setTestWaitingText('');
      return undefined;
    }
    const steps = ['正在连接模型', '模型思考中', '等待流式输出'];
    let tick = 0;
    const timer = window.setInterval(() => {
      const label = steps[Math.floor(tick / 3) % steps.length];
      const dots = '.'.repeat((tick % 3) + 1);
      setTestWaitingText(`${label}${dots}`);
      tick += 1;
    }, 420);
    setTestWaitingText('正在连接模型...');
    return () => window.clearInterval(timer);
  }, [isTestingAI]);

  useEffect(() => {
    if (!isElectron || !(window as any).electronAPI?.getWebviewSessionState) return;
    (window as any).electronAPI.getWebviewSessionState()
      .then((result: WebviewSessionState) => setWebviewSessionState(result))
      .catch((error: Error) => setWebviewSessionState({ success: false, error: error.message }));
  }, [isElectron]);

  const syncSettings = (updates: Partial<typeof settings>) => {
    appStore.updateSettings(updates);
    if (typeof window !== 'undefined' && (window as any).electronAPI) {
      (window as any).electronAPI.setSettings(appStore.getState().settings);
    }
  };

  const saveProvider = () => {
    const normalizedProvider = selectedPreset
      ? { ...formData, name: selectedPreset.name, authHeader: selectedPreset.authHeader, supportsResponseFormat: selectedPreset.supportsResponseFormat }
      : formData;
    appStore.updateProvider(selectedProviderId, normalizedProvider);
    appStore.updateSettings({ activeProviderId: selectedProviderId });
    if (typeof window !== 'undefined' && (window as any).electronAPI) {
      const latestSettings = {
        ...appStore.getState().settings,
        activeProviderId: selectedProviderId,
        providers: appStore.getState().settings.providers.map((provider) =>
          provider.id === selectedProviderId ? normalizedProvider : provider
        )
      };
      (window as any).electronAPI.setSettings(latestSettings);
    }
    appStore.addLog('success', `AI 服务已保存：${normalizedProvider.name}`);
  };

  const testAIChat = async () => {
    const content = testInput.trim();
    if (!content || isTestingAI) return;

    if (!formData.baseUrl.trim() || !formData.model.trim() || (formData.authHeader !== 'none' && !formData.apiKey.trim())) {
      appStore.addLog('error', '请先填写 Base URL、模型和 API Key 后再测试。');
      setTestMessages((prev) => [...prev, { role: 'assistant', content: formData.authHeader === 'none' ? '测试失败：请先填写 Base URL 和模型。' : '测试失败：请先填写 Base URL、模型和 API Key。' }]);
      return;
    }

    const userMessage: TestChatMessage = { role: 'user', content };
    const messagesForRequest = [...testMessages, userMessage].slice(-8);
    const setAssistantContent = (assistantContent: string) => {
      setTestMessages((prev) => {
        const next = [...prev];
        for (let index = next.length - 1; index >= 0; index -= 1) {
          if (next[index].role === 'assistant') {
            next[index] = { ...next[index], content: assistantContent };
            return next;
          }
        }
        return [...next, { role: 'assistant', content: assistantContent }];
      });
    };

    setTestMessages((prev) => [...prev, userMessage, { role: 'assistant', content: '' }]);
    setTestInput('');
    setIsTestingAI(true);

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(`${formData.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: buildAIHeaders(formData),
        body: JSON.stringify({
          model: formData.model,
          messages: [
            { role: 'system', content: '你是 AI 配置连通性测试助手。请用中文简短回答用户，不要输出 Markdown。' },
            ...messagesForRequest.map((message) => ({ role: message.role, content: message.content }))
          ],
          temperature: 0.2,
          stream: true
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`接口返回 ${response.status}：${errorText.slice(0, 500)}`);
      }

      let answer = '';
      const contentType = response.headers.get('content-type') || '';
      if (response.body && !contentType.includes('application/json')) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let rawText = '';
        const consumeLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          if (!trimmed.startsWith('data:')) return;
          const dataText = trimmed.slice(5).trim();
          if (!dataText || dataText === '[DONE]') return;
          try {
            const payload = JSON.parse(dataText);
            const delta = extractStreamDelta(payload);
            if (delta) {
              answer += delta;
              setAssistantContent(answer);
            }
          } catch {
            // Some providers send keepalive text; ignore it during SSE parsing.
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          rawText += text;
          buffer += text;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          lines.forEach(consumeLine);
        }
        buffer.split(/\r?\n/).forEach(consumeLine);

        if (!answer.trim()) {
          const parsed = JSON.parse(rawText);
          answer = extractNonStreamAnswer(parsed);
        }
      } else {
        const data = await response.json();
        answer = extractNonStreamAnswer(data);
      }

      const assistantMessage = answer.trim() || '接口已返回，但没有识别到 message.content。';
      setAssistantContent(assistantMessage);
      appStore.addLog('success', `AI 测试成功：${formData.name}`);
    } catch (error: any) {
      const message = error?.name === 'AbortError' ? '请求超时，请检查网络、Base URL 或模型名称。' : error?.message || '未知错误';
      setAssistantContent(`测试失败：${message}`);
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

  const checkUpdate = async () => {
    if (!isElectron || !(window as any).electronAPI?.checkForUpdates) {
      appStore.addLog('warn', '仅 Electron 桌面应用支持检查更新。');
      return;
    }
    setIsCheckingUpdate(true);
    try {
      const result = await (window as any).electronAPI.checkForUpdates();
      setUpdateInfo(result);
      if (result?.success) {
        if (result.warning) appStore.addLog('warn', result.warning);
        appStore.addLog(result.hasUpdate ? 'success' : 'info', result.hasUpdate ? `发现新版本：v${result.latestVersion}` : `当前已是最新版本：v${result.currentVersion}`);
      } else {
        appStore.addLog('error', result?.error || '检查更新失败。');
      }
    } catch (error: any) {
      const message = error?.message || '检查更新失败。';
      setUpdateInfo({ success: false, error: message });
      appStore.addLog('error', message);
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const openUpdateDownload = async () => {
    const targetUrl = updateInfo?.downloadUrl || updateInfo?.releaseUrl || 'https://github.com/XiYue-FireFly/Xuexitong-Answer-Helper/releases/latest';
    try {
      await (window as any).electronAPI?.openExternalUrl?.(targetUrl);
      appStore.addLog('info', '已打开最新版下载页面。');
    } catch (error: any) {
      appStore.addLog('error', `打开下载页面失败：${error?.message || '未知错误'}`);
    }
  };

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 18, height: '100%', overflowY: 'auto' }}>
      <div className="glass-panel" style={{ padding: 18, borderRadius: 8, borderLeft: '4px solid var(--warning-color)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <Shield size={18} style={{ color: 'var(--warning-color)' }} />
          <h4 style={{ color: 'var(--text-primary)', fontSize: '0.95rem' }}>产品边界</h4>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.6 }}>
          本应用用于你拥有、运营或明确获得授权的页面。题目抓取和 AI 解析仅作学习辅助，结果不会自动提交。
        </p>
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div>
            <h5 style={{ color: 'var(--text-primary)', fontSize: '0.9rem', marginBottom: 4 }}>应用更新</h5>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.72rem', lineHeight: 1.45 }}>
              发布新安装包后，可在这里检查并打开最新版下载。
            </div>
          </div>
          <button
            onClick={checkUpdate}
            disabled={!isElectron || isCheckingUpdate}
            className="btn btn-soft"
            style={{ opacity: !isElectron || isCheckingUpdate ? 0.55 : 1 }}
          >
            {isCheckingUpdate ? <Loader2 size={15} /> : <RefreshCw size={15} />} 检查更新
          </button>
        </div>

        {updateInfo && (
          <div style={{ border: '1px solid var(--border-glass)', borderRadius: 8, padding: 12, background: updateInfo.hasUpdate ? 'rgba(16,185,129,0.08)' : 'rgba(255,255,255,0.03)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {updateInfo.success ? (
              <>
                <div style={{ color: 'var(--text-primary)', fontSize: '0.8rem', fontWeight: 800 }}>
                  当前版本 v{updateInfo.currentVersion || '-'}，最新版本 v{updateInfo.latestVersion || '-'}
                </div>
                <div style={{ color: updateInfo.hasUpdate ? 'var(--success-color)' : 'var(--text-secondary)', fontSize: '0.74rem' }}>
                  {updateInfo.hasUpdate ? `发现新安装包：${updateInfo.assetName || 'Windows 安装包'}` : '当前已经是最新版本。'}
                </div>
                {updateInfo.warning && <div style={{ color: 'var(--warning-color)', fontSize: '0.72rem' }}>{updateInfo.warning}</div>}
                <button
                  onClick={openUpdateDownload}
                  className="btn btn-success"
                  style={{ alignSelf: 'flex-start' }}
                >
                  <Download size={14} /> 打开下载
                </button>
              </>
            ) : (
              <div style={{ color: 'var(--danger-color)', fontSize: '0.76rem' }}>{updateInfo.error || '检查更新失败。'}</div>
            )}
          </div>
        )}
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h5 style={{ color: 'var(--text-primary)', fontSize: '0.9rem' }}>真实页面能力</h5>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
          <div>
            <div style={{ color: 'var(--text-primary)', fontSize: '0.82rem', fontWeight: 700 }}>启用真实 WebView</div>
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
            <div style={{ color: 'var(--text-primary)', fontSize: '0.82rem', fontWeight: 700 }}>执行前必须批准</div>
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
            <div style={{ color: 'var(--text-primary)', fontSize: '0.82rem', fontWeight: 700 }}>网页登录状态</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.72rem', lineHeight: 1.45 }}>
              扫码登录后的 Cookie、localStorage 和 IndexedDB 会保存在本机，关闭应用后再次打开仍可继续使用。
            </div>
            <div style={{ color: webviewSessionState?.persistent ? 'var(--success-color)' : 'var(--warning-color)', fontSize: '0.7rem', lineHeight: 1.45, marginTop: 5 }}>
              {webviewSessionState?.success
                ? `持久化分区：${webviewSessionState.partition || 'persist:studypilot-sites'}`
                : `持久化状态：${webviewSessionState?.error || '读取中'}`}
            </div>
          </div>
          <button
            onClick={clearWebviewSession}
            disabled={!isElectron || isClearingSession}
            className="btn btn-danger"
            style={{ color: 'var(--danger-color)', opacity: !isElectron || isClearingSession ? 0.5 : 1 }}
          >
            <Trash2 size={14} /> {isClearingSession ? '清除中' : '清除登录'}
          </button>
        </div>
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h5 style={{ color: 'var(--text-primary)', fontSize: '0.9rem' }}>AI 搜索答案配置</h5>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="field-label">服务商</label>
          <CustomSelect
            value={selectedProviderId}
            options={providerOptions}
            ariaLabel="选择 AI 服务商"
            onChange={(nextId) => {
              const preset = AI_PROVIDER_PRESETS[nextId];
              setSelectedProviderId(nextId);
              syncSettings({ activeProviderId: nextId });
              if (preset) {
                const savedProvider = settings.providers.find((provider) => provider.id === nextId);
                const nextProvider = {
                  ...(savedProvider || formData),
                  id: nextId,
                  name: preset.name,
                  baseUrl: preset.defaultBaseUrl,
                  model: preset.defaultModel,
                  authHeader: preset.authHeader,
                  supportsResponseFormat: preset.supportsResponseFormat
                };
                setFormData(nextProvider);
                appStore.updateProvider(nextId, nextProvider);
              }
            }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="field-label">名称</label>
          <input value={formData.name} onChange={(event) => setFormData((prev) => ({ ...prev, name: event.target.value }))} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="field-label">Base URL</label>
          <CustomSelect
            value={endpointSelectValue}
            options={endpointOptions}
            ariaLabel="选择 Base URL"
            onChange={(value) => {
              if (value === '__custom__') {
                setFormData((prev) => ({ ...prev, baseUrl: prev.baseUrl || selectedPreset?.defaultBaseUrl || '' }));
                return;
              }
              setFormData((prev) => ({ ...prev, baseUrl: value, authHeader: selectedPreset?.authHeader || prev.authHeader }));
            }}
          />
          {endpointSelectValue === '__custom__' && (
            <input
              value={formData.baseUrl}
              onChange={(event) => setFormData((prev) => ({ ...prev, baseUrl: event.target.value }))}
              placeholder="https://example.com/v1"
            />
          )}
          {selectedPreset?.endpoints.find((item) => item.value === formData.baseUrl)?.note && (
            <div style={{ color: 'var(--warning-color)', fontSize: '0.7rem', lineHeight: 1.45 }}>
              {selectedPreset.endpoints.find((item) => item.value === formData.baseUrl)?.note}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="field-label">模型</label>
          <CustomSelect
            value={modelSelectValue}
            options={modelOptions}
            ariaLabel="选择模型"
            onChange={(value) => {
              if (value === '__custom__') {
                setFormData((prev) => ({ ...prev, model: prev.model || selectedPreset?.defaultModel || '' }));
                return;
              }
              setFormData((prev) => ({ ...prev, model: value }));
            }}
          />
          {modelSelectValue === '__custom__' && (
            <input
              value={formData.model}
              onChange={(event) => setFormData((prev) => ({ ...prev, model: event.target.value }))}
              placeholder="model-name"
            />
          )}
          {selectedPreset?.models.find((item) => item.value === formData.model)?.note && (
            <div style={{ color: 'var(--warning-color)', fontSize: '0.7rem', lineHeight: 1.45 }}>
              {selectedPreset.models.find((item) => item.value === formData.model)?.note}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="field-label">认证方式</label>
          {selectedPreset ? (
            <div style={{ color: 'var(--text-primary)', fontSize: '0.78rem', padding: '9px 10px', border: '1px solid var(--border-glass)', borderRadius: 8, background: 'rgba(255,255,255,0.02)' }}>
              {authHeaderLabel(selectedPreset.authHeader)}
            </div>
          ) : (
            <CustomSelect
              value={formData.authHeader || 'authorization'}
              options={[
                { label: 'Authorization: Bearer', value: 'authorization' },
                { label: 'api-key', value: 'api-key' },
                { label: '无需认证', value: 'none' }
              ]}
              ariaLabel="选择认证方式"
              onChange={(value) => setFormData((prev) => ({ ...prev, authHeader: value as AIProviderConfig['authHeader'] }))}
            />
          )}
          {selectedPreset?.note && (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', lineHeight: 1.45 }}>
              {selectedPreset.note}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="field-label">API Key</label>
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
          className="btn btn-primary"
        >
          <Save size={15} /> 保存 AI 配置
        </button>

        <div style={{ borderTop: '1px solid var(--border-glass)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <h5 style={{ color: 'var(--text-primary)', fontSize: '0.86rem' }}>AI 测试聊天</h5>
            <span className={`badge ${isTestingAI ? 'badge-warning' : testMessages.length > 0 ? 'badge-success' : 'badge-primary'}`}>
              {isTestingAI ? '流式输出中' : testMessages.length > 0 ? '已测试' : '待测试'}
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
                  {message.content || (isTestingAI && index === testMessages.length - 1 ? testWaitingText : '')}
                  {isTestingAI && message.role === 'assistant' && index === testMessages.length - 1 && message.content && (
                    <span style={{ display: 'inline-block', width: 8, marginLeft: 2, animation: 'pulse-glow 1.2s infinite' }}>|</span>
                  )}
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
              className="btn btn-success btn-icon"
              style={{ opacity: isTestingAI || !testInput.trim() ? 0.55 : 1 }}
              title="发送测试消息"
            >
              {isTestingAI ? <Loader2 size={17} /> : <Send size={17} />}
            </button>
          </div>
        </div>
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h5 style={{ color: 'var(--text-primary)', fontSize: '0.9rem' }}>演示地址</h5>
        <input value={settings.mockModeUrl} onChange={(event) => syncSettings({ mockModeUrl: event.target.value })} />
        <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Lock size={12} /> 演示模式不会操作外部页面。
        </div>
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h5 style={{ color: 'var(--text-primary)', fontSize: '0.9rem' }}>主题</h5>
        <CustomSelect
          value={settings.theme}
          options={[
            { label: '深色', value: 'dark' },
            { label: '浅色', value: 'light' }
          ]}
          ariaLabel="选择主题"
          onChange={(value) => syncSettings({ theme: value as 'dark' | 'light' })}
        />
      </div>
    </div>
  );
}
