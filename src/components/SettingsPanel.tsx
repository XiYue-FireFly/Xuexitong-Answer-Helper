import React, { useEffect, useState } from 'react';
import { ChevronDown, Coffee, Copy, Download, ExternalLink, Eye, EyeOff, Heart, KeyRound, Loader2, Lock, RefreshCw, Save, Send, Shield, ToggleLeft, ToggleRight, Trash2, X } from 'lucide-react';
import { AIProviderConfig, AI_PROVIDER_PRESETS, appStore, useAppStore } from '../store/appStore';

const REWARD_ALIPAY_IMAGE = new URL('../assets/reward-alipay.jpg', import.meta.url).href;
const REWARD_WECHAT_IMAGE = new URL('../assets/reward-wechat.jpg', import.meta.url).href;

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

type ApiKeyHelpLink = {
  providerId: string;
  name: string;
  url?: string;
  note: string;
  authLabel: string;
};

const API_KEY_HELP_LINKS: ApiKeyHelpLink[] = [
  { providerId: 'dashscope', name: '阿里云百炼 / Qwen', url: 'https://help.aliyun.com/zh/model-studio/get-api-key/', authLabel: 'Authorization: Bearer', note: '进入百炼控制台后，在 API Key 管理页创建并复制 Key。' },
  { providerId: 'deepseek', name: 'DeepSeek', url: 'https://platform.deepseek.com/api_keys', authLabel: 'Authorization: Bearer', note: '登录 DeepSeek Platform 后，在 API Keys 页面创建 Key。' },
  { providerId: 'siliconflow', name: '硅基流动 SiliconFlow', url: 'https://cloud.siliconflow.cn/account/ak', authLabel: 'Authorization: Bearer', note: '进入硅基流动控制台，在账户 API 密钥页面创建 Key。' },
  { providerId: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/keys', authLabel: 'Authorization: Bearer', note: '进入 OpenRouter Keys 页面创建 API Key，并确认账户有可用额度。' },
  { providerId: 'google', name: 'Google Gemini', url: 'https://aistudio.google.com/app/apikey', authLabel: 'Authorization: Bearer', note: '在 Google AI Studio 创建 API Key，复制后填入本应用。' },
  { providerId: 'moonshot', name: '月之暗面 Kimi', url: 'https://platform.moonshot.cn/console/api-keys', authLabel: 'Authorization: Bearer', note: '进入 Moonshot 控制台 API Keys 页面创建 Key。' },
  { providerId: 'zhipu', name: '智谱 AI / GLM', url: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', authLabel: 'Authorization: Bearer', note: '进入智谱开放平台的 API Keys 管理页创建 Key。' },
  { providerId: 'volcengine', name: '火山方舟 / 豆包', url: 'https://console.volcengine.com/ark/', authLabel: 'Authorization: Bearer', note: '进入火山方舟控制台，创建 API Key，并按控制台模型或接入点名称填写模型。' },
  { providerId: 'tencent', name: '腾讯混元', url: 'https://console.cloud.tencent.com/hunyuan/api-key', authLabel: 'Authorization: Bearer', note: '进入腾讯云混元控制台，在 API Key 页面创建并复制 Key。' },
  { providerId: 'baidu', name: '百度千帆 / 文心', url: 'https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application', authLabel: 'Authorization: Bearer', note: '进入千帆控制台创建应用或 API Key，按控制台说明复制密钥。' },
  { providerId: 'minimax', name: 'MiniMax', url: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', authLabel: 'Authorization: Bearer', note: '进入 MiniMax 平台用户中心，在接口密钥页面复制 Key。' },
  { providerId: 'stepfun', name: '阶跃星辰 StepFun', url: 'https://platform.stepfun.com/account-info', authLabel: 'Authorization: Bearer', note: '进入 StepFun 平台账户信息页面查看或创建 API Key。' },
  { providerId: 'groq', name: 'Groq', url: 'https://console.groq.com/keys', authLabel: 'Authorization: Bearer', note: '进入 Groq Console 的 API Keys 页面创建 Key。' },
  { providerId: 'mistral', name: 'Mistral AI', url: 'https://console.mistral.ai/api-keys/', authLabel: 'Authorization: Bearer', note: '进入 Mistral Console 创建 API Key。' },
  { providerId: 'together', name: 'Together AI', url: 'https://api.together.ai/settings/api-keys', authLabel: 'Authorization: Bearer', note: '进入 Together API Keys 设置页创建 Key。' },
  { providerId: 'xai', name: 'xAI / Grok', url: 'https://console.x.ai/', authLabel: 'Authorization: Bearer', note: '进入 xAI Console 创建 API Key。' },
  { providerId: 'xiaomi', name: '小米 MiMo', url: 'https://platform.xiaomimimo.com/', authLabel: 'api-key', note: '进入小米 MiMo 平台创建 sk-key 或 Token Plan 的 tp-key，注意两类 Key 不能混用。' },
  { providerId: 'openai', name: 'OpenAI', url: 'https://platform.openai.com/api-keys', authLabel: 'Authorization: Bearer', note: '进入 OpenAI Platform 的 API Keys 页面创建 Key。' },
  { providerId: 'ollama', name: 'Ollama 本地模型', authLabel: '无需认证', note: '本地服务不需要 API Key，请先启动 Ollama 并拉取模型。' },
  { providerId: 'lmstudio', name: 'LM Studio 本地模型', authLabel: '无需认证', note: '本地服务不需要 API Key，请在 LM Studio 开启 OpenAI Compatible Server。' },
  { providerId: 'vllm', name: 'vLLM / LocalAI 兼容服务', authLabel: '无需认证', note: '本地或自建服务通常不需要 API Key，按服务端要求填写 Base URL 和模型名。' },
  { providerId: 'custom', name: '自定义兼容接口', authLabel: '按接口要求', note: '如果使用第三方代理或自建接口，请查看该服务商文档，确认 Base URL、模型名和认证方式。' }
];

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
  const [showApiKeyHelp, setShowApiKeyHelp] = useState(false);
  const [showRewardCodes, setShowRewardCodes] = useState(false);
  const [copiedKeyHelpUrl, setCopiedKeyHelpUrl] = useState('');
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
  const selectedKeyHelp: ApiKeyHelpLink = API_KEY_HELP_LINKS.find((item) => item.providerId === selectedProviderId) || {
    providerId: selectedProviderId,
    name: formData.name || '当前服务商',
    url: undefined,
    authLabel: authHeaderLabel(formData.authHeader),
    note: '请查看当前服务商文档获取 API Key，确认 Base URL、模型名和认证方式。'
  };
  const visibleKeyHelpLinks = [
    selectedKeyHelp,
    ...API_KEY_HELP_LINKS.filter((item) => item.providerId !== selectedKeyHelp.providerId)
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

  const openApiKeyUrl = async (url?: string) => {
    if (!url) {
      appStore.addLog('info', '当前服务商无需 API Key，按教程启动本地服务即可。');
      return;
    }
    try {
      if ((window as any).electronAPI?.openExternalUrl) {
        await (window as any).electronAPI.openExternalUrl(url);
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      appStore.addLog('info', '已打开 API Key 获取页面。');
    } catch (error: any) {
      window.open(url, '_blank', 'noopener,noreferrer');
      appStore.addLog('warn', `外部打开失败，已尝试在浏览器中打开：${error?.message || '未知错误'}`);
    }
  };

  const copyApiKeyUrl = async (url?: string) => {
    if (!url) {
      appStore.addLog('info', '当前服务商无需复制 API Key 获取链接。');
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopiedKeyHelpUrl(url);
      window.setTimeout(() => setCopiedKeyHelpUrl((current) => (current === url ? '' : current)), 1800);
      appStore.addLog('success', '已复制 API Key 获取链接。');
    } catch (error: any) {
      appStore.addLog('error', `复制链接失败：${error?.message || '未知错误'}`);
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

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <button
          type="button"
          onClick={() => setShowRewardCodes((prev) => !prev)}
          aria-expanded={showRewardCodes}
          style={{
            width: '100%',
            padding: 0,
            background: 'transparent',
            color: 'inherit',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 14,
            textAlign: 'left'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              display: 'grid',
              placeItems: 'center',
              color: 'var(--warning-color)',
              background: 'rgba(245,158,11,0.12)',
              border: '1px solid rgba(245,158,11,0.24)',
              flex: '0 0 auto'
            }}>
              <Coffee size={18} />
            </div>
            <div style={{ minWidth: 0 }}>
              <h5 style={{ color: 'var(--text-primary)', fontSize: '0.9rem', marginBottom: 4 }}>赞赏支持</h5>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.74rem', lineHeight: 1.5 }}>
                如果这个项目对你有帮助，想请作者喝水或者喝杯咖啡，都是可以的~
              </div>
            </div>
          </div>
          <ChevronDown
            size={18}
            style={{
              color: 'var(--text-muted)',
              transform: showRewardCodes ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 160ms ease',
              flex: '0 0 auto'
            }}
          />
        </button>

        <div
          className={`reward-codes-shell${showRewardCodes ? ' open' : ''}`}
          aria-hidden={!showRewardCodes}
        >
          <div className="reward-codes-grid">
            {[
              { label: '支付宝', image: REWARD_ALIPAY_IMAGE, color: '#1677ff' },
              { label: '微信支付', image: REWARD_WECHAT_IMAGE, color: '#07c160' }
            ].map((item) => (
              <div
                key={item.label}
                className="reward-code-card"
                style={{ '--reward-color': item.color } as React.CSSProperties}
              >
                <div className="reward-code-title">
                  <Heart size={14} style={{ color: item.color }} />
                  {item.label}
                </div>
                <img
                  src={item.image}
                  alt={`${item.label}赞赏付款码`}
                />
              </div>
            ))}
          </div>
        </div>
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <label className="field-label">API Key</label>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setShowApiKeyHelp(true)}
              style={{ padding: '5px 8px', fontSize: '0.72rem', color: 'var(--primary-color)' }}
            >
              <KeyRound size={13} /> 没有秘钥，前往
            </button>
          </div>
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

      {showApiKeyHelp && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="获取 API Key"
          onClick={() => setShowApiKeyHelp(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
            background: 'rgba(2,6,23,0.68)',
            backdropFilter: 'blur(10px)'
          }}
        >
          <div
            className="glass-panel"
            onClick={(event) => event.stopPropagation()}
            style={{
              width: 'min(760px, 100%)',
              maxHeight: '88vh',
              overflowY: 'auto',
              borderRadius: 8,
              padding: 18,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              boxShadow: '0 24px 80px rgba(0,0,0,0.42)'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)', fontWeight: 900, fontSize: '1rem' }}>
                  <KeyRound size={18} /> 获取 API Key
                </div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.76rem', lineHeight: 1.55, marginTop: 6 }}>
                  选择服务商后打开对应控制台，复制 Key 后回到设置页粘贴。链接只用于跳转，不会保存任何秘钥。
                </div>
              </div>
              <button
                type="button"
                className="btn btn-icon btn-ghost"
                onClick={() => setShowApiKeyHelp(false)}
                title="关闭"
              >
                <X size={17} />
              </button>
            </div>

            <div style={{ border: '1px solid rgba(99,102,241,0.35)', borderRadius: 8, padding: 14, background: 'rgba(99,102,241,0.10)', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ color: 'var(--text-primary)', fontSize: '0.88rem', fontWeight: 850 }}>{selectedKeyHelp.name}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginTop: 3 }}>当前服务商 · {selectedKeyHelp.authLabel}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-soft"
                    disabled={!selectedKeyHelp.url}
                    onClick={() => copyApiKeyUrl(selectedKeyHelp.url)}
                    style={{ opacity: selectedKeyHelp.url ? 1 : 0.55 }}
                  >
                    <Copy size={14} /> {copiedKeyHelpUrl === selectedKeyHelp.url ? '已复制' : '复制链接'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!selectedKeyHelp.url}
                    onClick={() => openApiKeyUrl(selectedKeyHelp.url)}
                    style={{ opacity: selectedKeyHelp.url ? 1 : 0.55 }}
                  >
                    <ExternalLink size={14} /> 打开
                  </button>
                </div>
              </div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.76rem', lineHeight: 1.55 }}>{selectedKeyHelp.note}</div>
              {selectedKeyHelp.url && (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', wordBreak: 'break-all' }}>{selectedKeyHelp.url}</div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h5 style={{ color: 'var(--text-primary)', fontSize: '0.86rem' }}>其他常用获取地址</h5>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 8 }}>
                {visibleKeyHelpLinks.slice(1).map((item) => (
                  <div
                    key={item.providerId}
                    style={{
                      border: '1px solid var(--border-glass)',
                      borderRadius: 8,
                      padding: 10,
                      background: 'rgba(255,255,255,0.03)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                      minWidth: 0
                    }}
                  >
                    <div>
                      <div style={{ color: 'var(--text-primary)', fontSize: '0.78rem', fontWeight: 800 }}>{item.name}</div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.66rem', marginTop: 2 }}>{item.authLabel}</div>
                    </div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.68rem', lineHeight: 1.45 }}>{item.note}</div>
                    {item.url && <div style={{ color: 'var(--text-muted)', fontSize: '0.64rem', wordBreak: 'break-all' }}>{item.url}</div>}
                    <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
                      <button
                        type="button"
                        className="btn btn-soft"
                        disabled={!item.url}
                        onClick={() => copyApiKeyUrl(item.url)}
                        style={{ flex: 1, padding: '6px 8px', fontSize: '0.68rem', opacity: item.url ? 1 : 0.55 }}
                      >
                        <Copy size={13} /> {copiedKeyHelpUrl === item.url ? '已复制' : '复制'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={!item.url}
                        onClick={() => openApiKeyUrl(item.url)}
                        style={{ flex: 1, padding: '6px 8px', fontSize: '0.68rem', opacity: item.url ? 1 : 0.55 }}
                      >
                        <ExternalLink size={13} /> 打开
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ borderTop: '1px solid var(--border-glass)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h5 style={{ color: 'var(--text-primary)', fontSize: '0.86rem' }}>使用教程</h5>
              <ol style={{ margin: 0, paddingLeft: 18, color: 'var(--text-secondary)', fontSize: '0.75rem', lineHeight: 1.7 }}>
                <li>在设置页先选择 AI 服务商、Base URL 和模型。</li>
                <li>点击“打开”进入服务商控制台，登录后创建或复制 API Key。</li>
                <li>回到本应用，把 API Key 粘贴到输入框并点击“保存 AI 配置”。</li>
                <li>使用“AI 测试聊天”发送一句话，确认接口、模型和秘钥可用。</li>
                <li>Ollama、LM Studio、vLLM 等本地服务通常无需 API Key，只要先启动本地模型服务。</li>
              </ol>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
