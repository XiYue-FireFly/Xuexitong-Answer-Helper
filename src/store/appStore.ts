import { useSyncExternalStore } from 'react';

export type AutomationAction = 'click' | 'fill' | 'select' | 'wait';
export type AutomationStatus = 'idle' | 'scanning' | 'planning' | 'awaiting_approval' | 'executing' | 'extracting_question' | 'calling_ai' | 'learning' | 'done' | 'error';
export type QuestionType = 'single' | 'multiple' | 'judgement' | 'completion' | 'essay' | 'unknown';

export interface PageControl {
  selector: string;
  tag: string;
  type?: string;
  text: string;
  value?: string;
  placeholder?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  controls: PageControl[];
  capturedAt: number;
}

export interface AutomationStep {
  id: string;
  action: AutomationAction;
  selector?: string;
  value?: string;
  label: string;
  required: boolean;
}

export interface AutomationPlan {
  id: string;
  goal: string;
  source: 'mock' | 'webview' | 'manual';
  steps: AutomationStep[];
  risk: 'low' | 'medium' | 'high';
  approved: boolean;
  createdAt: number;
  executedAt?: number;
  result?: string;
}

export interface QuestionItem {
  id: string;
  hash: string;
  question: string;
  options: string[];
  optionTargets?: QuestionOptionTarget[];
  type: QuestionType;
  source: 'mock' | 'webview' | 'manual';
  pageUrl?: string;
  pageTitle?: string;
  context?: string;
  capturedAt: number;
  index?: number;
  selector?: string;
}

export interface QuestionOptionTarget {
  label: string;
  text: string;
  selector?: string;
  inputSelector?: string;
  clickSelector?: string;
  value?: string;
}

export interface AIAnswerResult {
  questionHash: string;
  provider: string;
  model: string;
  answer: string;
  choiceLabels: string[];
  matchedOptions: string[];
  confidence: number;
  analysis: string;
  warnings: string[];
  createdAt: number;
}

export interface TokenUsageRecord {
  id: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  source: 'answer' | 'test';
  questionIndex?: number;
  questionTitle?: string;
  createdAt: number;
  durationMs?: number;
}

export interface QuestionBankEntry {
  id: string;
  questionKey: string;
  question: string;
  options: string[];
  context?: string;
  answer: AIAnswerResult;
  updatedAt: number;
  hits: number;
}

export interface ManualQuestionBankInput {
  question: string;
  options: string[];
  answer: string;
  analysis?: string;
  type?: QuestionType;
}

export interface AIProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  authHeader?: 'authorization' | 'api-key' | 'none';
  supportsResponseFormat?: boolean;
}

export interface AIProviderOption {
  label: string;
  value: string;
  note?: string;
}

export interface AIProviderPreset {
  name: string;
  defaultBaseUrl: string;
  defaultModel: string;
  authHeader: 'authorization' | 'api-key' | 'none';
  endpoints: AIProviderOption[];
  models: AIProviderOption[];
  allowCustomEndpoint?: boolean;
  allowCustomModel?: boolean;
  supportsResponseFormat?: boolean;
  note?: string;
}

export interface AppLog {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

export interface AppSettings {
  allowRealPageAutomation: boolean;
  requireApprovalBeforeExecute: boolean;
  chapterAutoNext: boolean;
  chapterAutoPlay: boolean;
  chapterVideoMuted: boolean;
  chapterVideoSpeed: number;
  chapterAutoReadDocument: boolean;
  chapterAutoAnswerQuestions: boolean;
  chapterRestudy: boolean;
  chapterUnlockMode: boolean;
  chapterFaceRecognition: boolean;
  chapterRateHack: boolean;
  mockModeUrl: string;
  theme: 'dark' | 'light';
  providers: AIProviderConfig[];
  activeProviderId: string;
  apiConcurrency: number;
}

export interface ChapterVideoInfo {
  index: number;
  duration: number;
  currentTime: number;
  paused: boolean;
  muted: boolean;
  playbackRate: number;
  ended: boolean;
  src?: string;
  frame?: string;
}

export interface ChapterAudioInfo {
  index: number;
  duration: number;
  currentTime: number;
  paused: boolean;
  muted: boolean;
  playbackRate: number;
  ended: boolean;
  src?: string;
  frame?: string;
}

export interface TaskPointInfo {
  type: 'video' | 'document' | 'audio' | 'work' | 'exam' | 'unknown';
  title: string;
  completed: boolean;
}

export interface ChapterLinkInfo {
  title: string;
  url: string;
  active: boolean;
}

export interface ChapterLearningState {
  url: string;
  title: string;
  videos: ChapterVideoInfo[];
  audios: ChapterAudioInfo[];
  chapters: ChapterLinkInfo[];
  activeChapterIndex: number;
  nextChapter?: ChapterLinkInfo;
  taskPoints: TaskPointInfo[];
  documentReaders: number;
  allTasksCompleted: boolean;
  lastMessage: string;
  updatedAt: number;
  running: boolean;
}

export const AI_PROVIDER_PRESETS: Record<string, AIProviderPreset> = {
  dashscope: {
    name: '阿里云百炼 / Qwen',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    authHeader: 'authorization',
    endpoints: [
      { label: '中国内地（北京）', value: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { label: '美国（弗吉尼亚）', value: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1' },
      { label: '新加坡（替换 WorkspaceId）', value: 'https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', note: '需要将 {WorkspaceId} 改成百炼控制台工作空间 ID。' }
    ],
    models: [
      { label: 'qwen-plus（推荐）', value: 'qwen-plus' },
      { label: 'qwen-plus-latest', value: 'qwen-plus-latest' },
      { label: 'qwen-turbo', value: 'qwen-turbo' },
      { label: 'qwen-flash', value: 'qwen-flash' },
      { label: 'qwen-max', value: 'qwen-max' },
      { label: 'qwen3.6-plus', value: 'qwen3.6-plus' },
      { label: 'qwen3.6-flash', value: 'qwen3.6-flash' },
      { label: 'qwen3.7-max', value: 'qwen3.7-max' },
      { label: 'qwq-plus', value: 'qwq-plus' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true,
    note: 'OpenAI 兼容接口，使用 Authorization: Bearer。'
  },
  deepseek: {
    name: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    authHeader: 'authorization',
    endpoints: [
      { label: 'DeepSeek OpenAI 兼容', value: 'https://api.deepseek.com' }
    ],
    models: [
      { label: 'deepseek-v4-flash（推荐）', value: 'deepseek-v4-flash' },
      { label: 'deepseek-v4-pro', value: 'deepseek-v4-pro' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true,
    note: 'deepseek-chat / deepseek-reasoner 将于 2026-07-24 弃用，不再作为默认选项。'
  },
  siliconflow: {
    name: '硅基流动 SiliconFlow',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen3-8B',
    authHeader: 'authorization',
    endpoints: [
      { label: '中国区 API', value: 'https://api.siliconflow.cn/v1' }
    ],
    models: [
      { label: 'Qwen/Qwen3-8B（推荐）', value: 'Qwen/Qwen3-8B' },
      { label: 'Qwen/Qwen3-14B', value: 'Qwen/Qwen3-14B' },
      { label: 'Qwen/Qwen2.5-7B-Instruct', value: 'Qwen/Qwen2.5-7B-Instruct' },
      { label: 'deepseek-ai/DeepSeek-V3', value: 'deepseek-ai/DeepSeek-V3' },
      { label: 'deepseek-ai/DeepSeek-R1', value: 'deepseek-ai/DeepSeek-R1' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true,
    supportsResponseFormat: false,
    note: 'OpenAI 兼容接口，模型较多；如接口不支持 JSON response_format，应用会使用文本 JSON 解析。'
  },
  openrouter: {
    name: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    authHeader: 'authorization',
    endpoints: [
      { label: 'OpenRouter API', value: 'https://openrouter.ai/api/v1' }
    ],
    models: [
      { label: 'openai/gpt-4o-mini（推荐）', value: 'openai/gpt-4o-mini' },
      { label: 'google/gemini-2.0-flash-001', value: 'google/gemini-2.0-flash-001' },
      { label: 'anthropic/claude-3.5-sonnet', value: 'anthropic/claude-3.5-sonnet' },
      { label: 'deepseek/deepseek-chat', value: 'deepseek/deepseek-chat' },
      { label: 'qwen/qwen-plus', value: 'qwen/qwen-plus' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true,
    supportsResponseFormat: false,
    note: '聚合平台，模型名需要按 OpenRouter 后台实际可用模型填写。'
  },
  google: {
    name: 'Google Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.0-flash',
    authHeader: 'authorization',
    endpoints: [
      { label: 'Gemini OpenAI 兼容接口', value: 'https://generativelanguage.googleapis.com/v1beta/openai' }
    ],
    models: [
      { label: 'gemini-2.0-flash（推荐）', value: 'gemini-2.0-flash' },
      { label: 'gemini-2.0-flash-lite', value: 'gemini-2.0-flash-lite' },
      { label: 'gemini-1.5-flash', value: 'gemini-1.5-flash' },
      { label: 'gemini-1.5-pro', value: 'gemini-1.5-pro' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true,
    supportsResponseFormat: false,
    note: '使用 Google AI Studio Key，OpenAI 兼容入口路径以 /openai 结尾。'
  },
  moonshot: {
    name: '月之暗面 Kimi',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    authHeader: 'authorization',
    endpoints: [
      { label: 'Moonshot API', value: 'https://api.moonshot.cn/v1' }
    ],
    models: [
      { label: 'moonshot-v1-8k（推荐）', value: 'moonshot-v1-8k' },
      { label: 'moonshot-v1-32k', value: 'moonshot-v1-32k' },
      { label: 'moonshot-v1-128k', value: 'moonshot-v1-128k' },
      { label: 'kimi-k2-0711-preview', value: 'kimi-k2-0711-preview' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true,
    note: 'OpenAI 兼容接口，使用 Authorization: Bearer。'
  },
  zhipu: {
    name: '智谱 AI / GLM',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    authHeader: 'authorization',
    endpoints: [
      { label: '智谱 OpenAI 兼容', value: 'https://open.bigmodel.cn/api/paas/v4' }
    ],
    models: [
      { label: 'glm-4-flash（推荐）', value: 'glm-4-flash' },
      { label: 'glm-4-plus', value: 'glm-4-plus' },
      { label: 'glm-4-air', value: 'glm-4-air' },
      { label: 'glm-4-long', value: 'glm-4-long' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true,
    supportsResponseFormat: false,
    note: '智谱开放平台兼容 OpenAI SDK，部分模型不支持 response_format。'
  },
  volcengine: {
    name: '火山方舟 / 豆包',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-1-6-flash-250615',
    authHeader: 'authorization',
    endpoints: [
      { label: '中国区（北京）', value: 'https://ark.cn-beijing.volces.com/api/v3' },
      { label: '国际区（新加坡）', value: 'https://ark.ap-southeast-1.volces.com/api/v3' }
    ],
    models: [
      { label: 'doubao-seed-1-6-flash-250615（推荐）', value: 'doubao-seed-1-6-flash-250615' },
      { label: 'doubao-seed-1-6-250615', value: 'doubao-seed-1-6-250615' },
      { label: 'doubao-1-5-pro-32k-250115', value: 'doubao-1-5-pro-32k-250115' },
      { label: 'doubao-1-5-lite-32k-250115', value: 'doubao-1-5-lite-32k-250115' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true,
    supportsResponseFormat: false,
    note: '方舟通常需要在控制台使用模型或推理接入点名称；若调用失败，请把模型改成控制台展示的 endpoint/model。'
  },
  tencent: {
    name: '腾讯混元',
    defaultBaseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    defaultModel: 'hunyuan-lite',
    authHeader: 'authorization',
    endpoints: [
      { label: '混元 OpenAI 兼容', value: 'https://api.hunyuan.cloud.tencent.com/v1' }
    ],
    models: [
      { label: 'hunyuan-lite（推荐）', value: 'hunyuan-lite' },
      { label: 'hunyuan-standard', value: 'hunyuan-standard' },
      { label: 'hunyuan-standard-256K', value: 'hunyuan-standard-256K' },
      { label: 'hunyuan-turbo', value: 'hunyuan-turbo' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true,
    supportsResponseFormat: false,
    note: '使用混元 OpenAI 兼容接口；不同账号可用模型以腾讯云控制台为准。'
  },
  baidu: {
    name: '百度千帆 / 文心',
    defaultBaseUrl: 'https://qianfan.baidubce.com/v2',
    defaultModel: 'ernie-4.0-turbo-8k',
    authHeader: 'authorization',
    endpoints: [
      { label: '千帆 OpenAI 兼容', value: 'https://qianfan.baidubce.com/v2' }
    ],
    models: [
      { label: 'ernie-4.0-turbo-8k（推荐）', value: 'ernie-4.0-turbo-8k' },
      { label: 'ernie-3.5-8k', value: 'ernie-3.5-8k' },
      { label: 'ernie-speed-8k', value: 'ernie-speed-8k' },
      { label: 'ernie-lite-8k', value: 'ernie-lite-8k' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true,
    supportsResponseFormat: false,
    note: '千帆 v2 OpenAI 兼容接口，API Key 使用 Bearer。'
  },
  minimax: {
    name: 'MiniMax',
    defaultBaseUrl: 'https://api.minimax.chat/v1',
    defaultModel: 'MiniMax-Text-01',
    authHeader: 'authorization',
    endpoints: [
      { label: 'MiniMax API', value: 'https://api.minimax.chat/v1' }
    ],
    models: [
      { label: 'MiniMax-Text-01（推荐）', value: 'MiniMax-Text-01' },
      { label: 'abab6.5s-chat', value: 'abab6.5s-chat' },
      { label: 'abab6.5g-chat', value: 'abab6.5g-chat' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true,
    supportsResponseFormat: false,
    note: '如你的 MiniMax 账号使用 GroupId 路径，请改用自定义 Base URL。'
  },
  stepfun: {
    name: '阶跃星辰 StepFun',
    defaultBaseUrl: 'https://api.stepfun.com/v1',
    defaultModel: 'step-2-mini',
    authHeader: 'authorization',
    endpoints: [
      { label: 'StepFun API', value: 'https://api.stepfun.com/v1' }
    ],
    models: [
      { label: 'step-2-mini（推荐）', value: 'step-2-mini' },
      { label: 'step-1-8k', value: 'step-1-8k' },
      { label: 'step-1-32k', value: 'step-1-32k' },
      { label: 'step-2-16k', value: 'step-2-16k' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true,
    supportsResponseFormat: false,
    note: 'OpenAI 兼容接口，使用 Authorization: Bearer。'
  },
  groq: {
    name: 'Groq',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.1-8b-instant',
    authHeader: 'authorization',
    endpoints: [
      { label: 'Groq OpenAI 兼容', value: 'https://api.groq.com/openai/v1' }
    ],
    models: [
      { label: 'llama-3.1-8b-instant（推荐）', value: 'llama-3.1-8b-instant' },
      { label: 'llama-3.3-70b-versatile', value: 'llama-3.3-70b-versatile' },
      { label: 'gemma2-9b-it', value: 'gemma2-9b-it' },
      { label: 'mixtral-8x7b-32768', value: 'mixtral-8x7b-32768' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true,
    supportsResponseFormat: false,
    note: '海外服务，国内网络可能需要自行处理连通性。'
  },
  mistral: {
    name: 'Mistral AI',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
    authHeader: 'authorization',
    endpoints: [
      { label: 'Mistral API', value: 'https://api.mistral.ai/v1' }
    ],
    models: [
      { label: 'mistral-small-latest（推荐）', value: 'mistral-small-latest' },
      { label: 'mistral-large-latest', value: 'mistral-large-latest' },
      { label: 'open-mistral-nemo', value: 'open-mistral-nemo' },
      { label: 'codestral-latest', value: 'codestral-latest' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true,
    supportsResponseFormat: false
  },
  together: {
    name: 'Together AI',
    defaultBaseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
    authHeader: 'authorization',
    endpoints: [
      { label: 'Together API', value: 'https://api.together.xyz/v1' }
    ],
    models: [
      { label: 'Meta-Llama-3.1-8B-Instruct-Turbo（推荐）', value: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo' },
      { label: 'Meta-Llama-3.1-70B-Instruct-Turbo', value: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo' },
      { label: 'Qwen2.5-7B-Instruct-Turbo', value: 'Qwen/Qwen2.5-7B-Instruct-Turbo' },
      { label: 'DeepSeek-R1-Distill-Llama-70B', value: 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true,
    supportsResponseFormat: false
  },
  xai: {
    name: 'xAI / Grok',
    defaultBaseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-3-mini',
    authHeader: 'authorization',
    endpoints: [
      { label: 'xAI API', value: 'https://api.x.ai/v1' }
    ],
    models: [
      { label: 'grok-3-mini（推荐）', value: 'grok-3-mini' },
      { label: 'grok-3', value: 'grok-3' },
      { label: 'grok-2-1212', value: 'grok-2-1212' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true,
    supportsResponseFormat: false,
    note: '海外服务，国内网络可能需要自行处理连通性。'
  },
  xiaomi: {
    name: '小米 MiMo',
    defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro',
    authHeader: 'api-key',
    endpoints: [
      { label: '按量付费 API（sk-xxxxx）', value: 'https://api.xiaomimimo.com/v1' },
      { label: 'Token Plan 中国集群（tp-xxxxx）', value: 'https://token-plan-cn.xiaomimimo.com/v1' },
      { label: 'Token Plan 新加坡集群（tp-xxxxx）', value: 'https://token-plan-sgp.xiaomimimo.com/v1' },
      { label: 'Token Plan 欧洲集群（tp-xxxxx）', value: 'https://token-plan-ams.xiaomimimo.com/v1' }
    ],
    models: [
      { label: 'mimo-v2.5-pro（推荐）', value: 'mimo-v2.5-pro' },
      { label: 'mimo-v2.5', value: 'mimo-v2.5' },
      { label: 'mimo-v2-flash', value: 'mimo-v2-flash' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: false,
    note: '小米 MiMo 使用 api-key 请求头；Token Plan 的 tp-key 与按量付费 sk-key 不可混用。'
  },
  openai: {
    name: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1-mini',
    authHeader: 'authorization',
    endpoints: [
      { label: 'OpenAI 官方', value: 'https://api.openai.com/v1' }
    ],
    models: [
      { label: 'gpt-4.1-mini（推荐）', value: 'gpt-4.1-mini' },
      { label: 'gpt-4o-mini', value: 'gpt-4o-mini' },
      { label: 'gpt-4o', value: 'gpt-4o' },
      { label: 'gpt-4.1', value: 'gpt-4.1' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true
  },
  ollama: {
    name: 'Ollama 本地模型',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5:7b',
    authHeader: 'none',
    endpoints: [
      { label: 'Ollama 本机', value: 'http://127.0.0.1:11434/v1' }
    ],
    models: [
      { label: 'qwen2.5:7b（推荐）', value: 'qwen2.5:7b' },
      { label: 'qwen2.5:14b', value: 'qwen2.5:14b' },
      { label: 'llama3.1:8b', value: 'llama3.1:8b' },
      { label: 'deepseek-r1:7b', value: 'deepseek-r1:7b' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true,
    supportsResponseFormat: false,
    note: '本地服务，无需 API Key；需要先在电脑上启动 Ollama 并拉取对应模型。'
  },
  lmstudio: {
    name: 'LM Studio 本地模型',
    defaultBaseUrl: 'http://127.0.0.1:1234/v1',
    defaultModel: 'local-model',
    authHeader: 'none',
    endpoints: [
      { label: 'LM Studio 本机', value: 'http://127.0.0.1:1234/v1' }
    ],
    models: [
      { label: 'local-model（按 LM Studio 当前加载模型）', value: 'local-model' },
      { label: 'qwen2.5-7b-instruct', value: 'qwen2.5-7b-instruct' },
      { label: 'llama-3.1-8b-instruct', value: 'llama-3.1-8b-instruct' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true,
    supportsResponseFormat: false,
    note: '本地服务，无需 API Key；需要在 LM Studio 开启 OpenAI Compatible Server。'
  },
  vllm: {
    name: 'vLLM / LocalAI 兼容服务',
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    defaultModel: 'local-model',
    authHeader: 'none',
    endpoints: [
      { label: 'vLLM 默认', value: 'http://127.0.0.1:8000/v1' },
      { label: 'LocalAI 默认', value: 'http://127.0.0.1:8080/v1' }
    ],
    models: [
      { label: 'local-model（按服务端模型名）', value: 'local-model' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true,
    supportsResponseFormat: false,
    note: '适合自建 OpenAI 兼容服务；Base URL 和模型名按你的服务端配置填写。'
  },
  custom: {
    name: '自定义兼容接口',
    defaultBaseUrl: 'https://example.com/v1',
    defaultModel: 'custom-model',
    authHeader: 'authorization',
    endpoints: [
      { label: '自定义 Base URL', value: 'https://example.com/v1' }
    ],
    models: [
      { label: '自定义模型', value: 'custom-model' }
    ],
    allowCustomEndpoint: true,
    allowCustomModel: true,
    supportsResponseFormat: false
  }
};

const defaultProviders: AIProviderConfig[] = Object.entries(AI_PROVIDER_PRESETS).map(([id, preset]) => ({
  id,
  name: preset.name,
  baseUrl: preset.defaultBaseUrl,
  apiKey: '',
  model: preset.defaultModel,
  authHeader: preset.authHeader,
  supportsResponseFormat: preset.supportsResponseFormat
}));

const defaultSettings: AppSettings = {
  allowRealPageAutomation: false,
  requireApprovalBeforeExecute: true,
  chapterAutoNext: true,
  chapterAutoPlay: true,
  chapterVideoMuted: false,
  chapterVideoSpeed: 1,
    chapterAutoReadDocument: true,
    chapterAutoAnswerQuestions: false,
    chapterRestudy: false,
    chapterUnlockMode: true,
    chapterFaceRecognition: true,
    chapterRateHack: true,
  mockModeUrl: 'https://study-demo.studypilot.local/automation',
  theme: 'dark',
  providers: defaultProviders,
  activeProviderId: 'dashscope',
  apiConcurrency: 5
};

function normalizeApiConcurrency(value: unknown) {
  const numberValue = Math.floor(Number(value));
  if (!Number.isFinite(numberValue)) return 5;
  return Math.max(1, Math.min(5, numberValue));
}

function normalizeProviders(inputProviders?: AIProviderConfig[]) {
  const savedProviders = inputProviders?.length ? inputProviders : [];
  const byId = new Map(savedProviders.map((provider) => [provider.id, provider]));
  const merged = defaultProviders.map((defaults) => {
    const saved = byId.get(defaults.id);
    if (!saved) return defaults;
    const preset = AI_PROVIDER_PRESETS[defaults.id];
    const isCustomProvider = defaults.id === 'custom';
    const next: AIProviderConfig = {
      ...defaults,
      ...saved,
      authHeader: saved.authHeader || defaults.authHeader || 'authorization',
      supportsResponseFormat: saved.supportsResponseFormat ?? defaults.supportsResponseFormat
    };
    if (!isCustomProvider && preset && !next.baseUrl) {
      next.baseUrl = preset.defaultBaseUrl;
    }
    if (!isCustomProvider && preset && !next.model) {
      next.model = preset.defaultModel;
    }
    if (next.id === 'xiaomi' && next.baseUrl === 'https://api.mixin.chat/v1') {
      next.name = defaults.name;
      next.baseUrl = defaults.baseUrl;
      next.model = next.model === 'xiaomi-llm' ? defaults.model : next.model;
      next.authHeader = defaults.authHeader;
    }
    if (next.id === 'deepseek' && next.baseUrl === 'https://api.deepseek.com/v1') {
      next.baseUrl = defaults.baseUrl;
      next.model = ['deepseek-chat', 'deepseek-reasoner'].includes(next.model) ? defaults.model : next.model;
    }
    next.authHeader = isCustomProvider ? (next.authHeader || 'authorization') : (preset?.authHeader || next.authHeader);
    next.supportsResponseFormat = isCustomProvider ? (next.supportsResponseFormat ?? false) : (preset?.supportsResponseFormat ?? next.supportsResponseFormat);
    next.name = isCustomProvider ? (next.name || defaults.name) : (preset?.name || next.name);
    return next;
  });
  const extraProviders = savedProviders
    .filter((provider) => !defaultProviders.some((defaults) => defaults.id === provider.id))
    .map((provider): AIProviderConfig => ({ ...provider, authHeader: provider.authHeader || 'authorization' }));
  return [...merged, ...extraProviders];
}

function normalizeSettings(input: Partial<AppSettings> | null): AppSettings {
  if (!input) return defaultSettings;
  return {
    ...defaultSettings,
    ...input,
    providers: normalizeProviders(input.providers),
    activeProviderId: input.activeProviderId || defaultSettings.activeProviderId,
    apiConcurrency: normalizeApiConcurrency(input.apiConcurrency ?? defaultSettings.apiConcurrency)
  };
}

const QUESTION_BANK_FUZZY_THRESHOLD = 0.8;
const QUESTION_BANK_FUZZY_MIN_KEY_LENGTH = 12;
const QUESTION_BANK_FUZZY_MIN_LENGTH_BALANCE = 0.85;

class GlobalStore {
  private listeners = new Set<() => void>();

  private state = {
    settings: this.loadSettings(),
    status: 'idle' as AutomationStatus,
    statusText: '就绪',
    logs: [] as AppLog[],
    snapshot: null as PageSnapshot | null,
    currentPlan: null as AutomationPlan | null,
    questions: [] as QuestionItem[],
    currentQuestionIndex: 0,
    currentAnswer: null as AIAnswerResult | null,
    answerMap: {} as Record<string, AIAnswerResult>,
    chapterLearning: null as ChapterLearningState | null,
    questionBank: this.loadQuestionBank(),
    history: this.loadHistory(),
    answerHistory: this.loadAnswerHistory(),
    tokenUsage: this.loadTokenUsage(),
    // 自动化运行状态提升到 store：AIPanel 随 tab 切换卸载重挂载，
    // 组件内 useState 会丢失但后台 async 循环仍在运行，导致用户可重复启动并行自动化
    batchRunning: false,
    liveRunning: false,
    livePaused: false,
    isElectron: typeof window !== 'undefined' && navigator.userAgent.toLowerCase().includes('electron')
  };

  setAutomationRunning(patch: { batchRunning?: boolean; liveRunning?: boolean; livePaused?: boolean }) {
    if (typeof patch.batchRunning === 'boolean') this.state.batchRunning = patch.batchRunning;
    if (typeof patch.liveRunning === 'boolean') this.state.liveRunning = patch.liveRunning;
    if (typeof patch.livePaused === 'boolean') this.state.livePaused = patch.livePaused;
    this.emit();
  }

  constructor() {
    this.addLog('info', 'StudyPilot 已初始化。');
  }

  // useSyncExternalStore 要求 getSnapshot 结果引用稳定：
  // 每次返回新对象会让 React 判定“store 已变化”→ 失去渲染 bailout、每次渲染重订阅，形成渲染风暴。
  // 因此快照仅在 emit（状态实际变更）时重建。
  private cachedSnapshot: (ReturnType<GlobalStore['buildSnapshot']>) | null = null;

  private buildSnapshot() {
    return {
      ...this.state,
      currentQuestion: this.state.questions[this.state.currentQuestionIndex] || null
    };
  }

  getState() {
    if (!this.cachedSnapshot) this.cachedSnapshot = this.buildSnapshot();
    return this.cachedSnapshot;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    this.cachedSnapshot = this.buildSnapshot();
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        // 单个监听器异常不得中断其余监听器
        console.error('[StudyPilot] store listener error', error);
      }
    });
  }

  private loadSettings(): AppSettings {
    try {
      const saved = localStorage.getItem('studypilot_settings_v3');
      if (saved) return normalizeSettings(JSON.parse(saved));
      const legacy = localStorage.getItem('studypilot_settings_v2');
      if (legacy) return normalizeSettings(JSON.parse(legacy));
    } catch {
      // 使用默认设置。
    }
    return defaultSettings;
  }

  private saveSettings(settings: AppSettings) {
    this.safeSetItem('studypilot_settings_v3', JSON.stringify(settings), '设置');
  }

  // localStorage 写入可能抛 QuotaExceededError（题库/历史超配额、隐私模式、磁盘满）。
  // 裸写会让异常级联：emit 中断 → UI 不刷新 → 异常冒泡到 AI 重试逻辑被当成 API 失败重复烧 token。
  private safeSetItem(key: string, value: string, label: string) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error: any) {
      const quota = error?.name === 'QuotaExceededError' || error?.code === 22;
      this.addLog('warn', quota
        ? `${label}写入失败：本机存储空间不足，数据仅保留在当前会话。可导出备份后清理历史/题库。`
        : `${label}写入失败：${error?.message || '未知错误'}，数据仅保留在当前会话。`);
      return false;
    }
  }

  private loadHistory(): AutomationPlan[] {
    try {
      const saved = localStorage.getItem('studypilot_automation_history');
      if (saved) {
        const parsed = JSON.parse(saved);
        return Array.isArray(parsed) ? parsed : [];
      }
    } catch {
      // 空历史即可。
    }
    return [];
  }

  private saveHistory(history: AutomationPlan[]) {
    this.safeSetItem('studypilot_automation_history', JSON.stringify(history), '运行记录');
  }

  private loadAnswerHistory(): { question: QuestionItem; answer: AIAnswerResult }[] {
    try {
      const saved = localStorage.getItem('studypilot_answer_history');
      if (saved) {
        const parsed = JSON.parse(saved);
        return Array.isArray(parsed) ? parsed : [];
      }
    } catch {
      // 空历史即可。
    }
    return [];
  }

  private saveAnswerHistory(history: { question: QuestionItem; answer: AIAnswerResult }[]) {
    this.safeSetItem('studypilot_answer_history', JSON.stringify(history), '答案历史');
  }

  private loadTokenUsage(): TokenUsageRecord[] {
    try {
      const saved = localStorage.getItem('studypilot_token_usage_v1');
      if (saved) {
        const records = JSON.parse(saved);
        if (Array.isArray(records)) {
          return records
            .map((record): TokenUsageRecord | null => {
              if (!record || typeof record !== 'object') return null;
              const totalTokens = Number(record.totalTokens || 0);
              const promptTokens = Number(record.promptTokens || 0);
              const completionTokens = Number(record.completionTokens || 0);
              if (!Number.isFinite(totalTokens + promptTokens + completionTokens)) return null;
              return {
                id: String(record.id || Math.random().toString(36).slice(2)),
                provider: String(record.provider || '未知服务商'),
                model: String(record.model || 'unknown'),
                promptTokens: Math.max(0, promptTokens),
                completionTokens: Math.max(0, completionTokens),
                totalTokens: Math.max(0, totalTokens || promptTokens + completionTokens),
                source: record.source === 'test' ? 'test' : 'answer',
                questionIndex: typeof record.questionIndex === 'number' ? record.questionIndex : undefined,
                questionTitle: record.questionTitle ? String(record.questionTitle) : undefined,
                createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
                durationMs: typeof record.durationMs === 'number' ? record.durationMs : undefined
              };
            })
            .filter((record): record is TokenUsageRecord => Boolean(record))
            .slice(0, 2000);
        }
      }
    } catch {
      // 空统计即可。
    }
    return [];
  }

  private saveTokenUsage(records: TokenUsageRecord[]) {
    this.safeSetItem('studypilot_token_usage_v1', JSON.stringify(records), 'Token 统计');
  }

  private loadQuestionBank(): QuestionBankEntry[] {
    try {
      const saved = localStorage.getItem('studypilot_question_bank_v1');
      if (saved) return this.dedupeQuestionBank(JSON.parse(saved));
    } catch {
      // 空题库即可。
    }
    return [];
  }

  private saveQuestionBank(bank: QuestionBankEntry[]) {
    this.safeSetItem('studypilot_question_bank_v1', JSON.stringify(bank), '本地题库');
  }

  exportQuestionBank() {
    return this.state.questionBank.map((entry) => ({
      ...entry,
      answer: { ...entry.answer },
      options: [...entry.options]
    }));
  }

  private questionBankSourcePriority(entry: QuestionBankEntry) {
    const provider = entry.answer?.provider || '';
    if (/本地手动题库/.test(provider)) return 4;
    if (/本地导入题库/.test(provider)) return 3;
    if (/本地题库/.test(provider)) return 2;
    // 演示答案（无 API Key 时生成的占位答案）优先级最低：
    // 不得覆盖任何真实来源的答案，也不得随导出/上传外泄污染共享题库
    if (/本地演示/.test(provider)) return 0;
    return 1;
  }

  private preferQuestionBankEntry(current: QuestionBankEntry, incoming: QuestionBankEntry) {
    const currentPriority = this.questionBankSourcePriority(current);
    const incomingPriority = this.questionBankSourcePriority(incoming);
    if (incomingPriority !== currentPriority) return incomingPriority > currentPriority ? incoming : current;
    if ((incoming.updatedAt || 0) !== (current.updatedAt || 0)) return (incoming.updatedAt || 0) > (current.updatedAt || 0) ? incoming : current;
    return incoming;
  }

  private dedupeQuestionBank(bank: QuestionBankEntry[]) {
    const byKey = new Map<string, QuestionBankEntry>();
    for (const item of Array.isArray(bank) ? bank : []) {
      // 跳过缺答案的损坏条目，防止渲染层 entry.answer.answer 访问抛错白屏
      if (!item?.question || !item.answer?.answer) continue;
      const key = this.normalizeQuestionContentKey({
        id: item.id || 'bank',
        hash: item.answer?.questionHash || '',
        question: item.question,
        options: Array.isArray(item.options) ? item.options : [],
        context: item.context,
        type: 'unknown',
        source: 'manual',
        capturedAt: item.updatedAt || Date.now()
      });
      if (!key) continue;
      const normalizedItem = {
        ...item,
        options: Array.isArray(item.options) ? item.options : [],
        questionKey: item.questionKey || key
      };
      const existing = byKey.get(key);
      byKey.set(key, existing ? this.preferQuestionBankEntry(existing, normalizedItem) : normalizedItem);
    }
    return Array.from(byKey.values());
  }

  private stripQuestionNoise(text: string) {
    return text
      .replace(/^\s*(?:第\s*)?\d+\s*[、.．)]\s*/g, '')
      .replace(/^\s*[（(【[]?\s*(?:单选题|单选|多选题|多选|判断题|判断|填空题|填空|问答题|简答题|论述题|未知)\s*[】\])）)]?\s*/i, '')
      .replace(/^\s*(?:题目|问题)\s*[:：]\s*/i, '')
      .replace(/[（(]\s*[）)]/g, '');
  }

  normalizeQuestionKey(question: QuestionItem | string) {
    const text = typeof question === 'string' ? question : question.question;
    return this.stripQuestionNoise(text)
      // 全角字母/数字转半角：页面题干常见全角字符（Ａ、１２３），不转换会与半角版本生成不同 key 导致题库漏命中
      .replace(/[\uff01-\uff5e]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
      .replace(/\u3000/g, ' ')
      .replace(/\s+/g, '')
      .replace(/[，。,.、；;：:？！?!"'“”‘’【】\[\]（）()]/g, '')
      .toLowerCase()
      .slice(0, 500);
  }

  normalizeQuestionContentKey(question: QuestionItem) {
    const questionKey = this.normalizeQuestionKey(question);
    const contextKey = question.context ? this.normalizeQuestionKey(question.context) : '';
    const optionKey = (question.options || [])
      // 选项前缀剥离要求标点分隔符，避免吃掉以 A-H 字母开头的正常选项文本（“Apple”→“pple”）
      .map((option) => this.normalizeQuestionKey(String(option).replace(/^\s*[A-H]\s*[.:：、。)]\s*/i, '')))
      .filter(Boolean)
      .sort()
      .join('|');
    const baseKey = optionKey ? `${questionKey}::${optionKey}` : questionKey;
    return contextKey ? `${contextKey}::${baseKey}` : baseKey;
  }

  private textSimilarity(left: string, right: string) {
    if (left === right) return 1;
    if (left.length < QUESTION_BANK_FUZZY_MIN_KEY_LENGTH || right.length < QUESTION_BANK_FUZZY_MIN_KEY_LENGTH) return 0;

    const shorter = left.length <= right.length ? left : right;
    const longer = left.length > right.length ? left : right;
    const containmentScore = longer.includes(shorter) ? shorter.length / longer.length : 0;
    const lengthBalance = shorter.length / longer.length;
    const grams = new Map<string, number>();

    for (let index = 0; index < left.length - 1; index += 1) {
      const gram = left.slice(index, index + 2);
      grams.set(gram, (grams.get(gram) || 0) + 1);
    }

    let intersection = 0;
    for (let index = 0; index < right.length - 1; index += 1) {
      const gram = right.slice(index, index + 2);
      const count = grams.get(gram) || 0;
      if (count > 0) {
        grams.set(gram, count - 1);
        intersection += 1;
      }
    }

    const diceScore = (2 * intersection) / (left.length + right.length - 2);
    const previous = new Array(right.length + 1).fill(0);
    const current = new Array(right.length + 1).fill(0);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        current[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
          ? previous[rightIndex - 1] + 1
          : Math.max(previous[rightIndex], current[rightIndex - 1]);
      }
      for (let index = 0; index <= right.length; index += 1) {
        previous[index] = current[index];
        current[index] = 0;
      }
    }
    const sequenceScore = previous[right.length] / Math.max(left.length, right.length);
    const rawScore = Math.max(containmentScore, diceScore * 0.55 + sequenceScore * 0.45);
    return rawScore * lengthBalance;
  }

  private questionBankOptionsCompatible(question: QuestionItem, entry: QuestionBankEntry) {
    const questionOptionCount = (question.options || []).filter(Boolean).length;
    const entryOptionCount = (entry.options || []).filter(Boolean).length;
    if (questionOptionCount === 0 || entryOptionCount === 0) return true;
    return Math.abs(questionOptionCount - entryOptionCount) <= 1;
  }

  private questionBankOptionsExact(question: QuestionItem, entry: QuestionBankEntry) {
    const questionOptionCount = (question.options || []).filter(Boolean).length;
    const entryOptionCount = (entry.options || []).filter(Boolean).length;
    if (questionOptionCount === 0 || entryOptionCount === 0) return true;
    if (questionOptionCount !== entryOptionCount) return false;
    // 数量相同还必须内容相似：同一题干在不同课程复用但选项不同的场景，
    // 仅凭题干+数量命中会把错误答案静默填入页面
    return this.questionBankOptionsContentSimilar(question, entry);
  }

  // 选项集合内容相似度：归一化后逐项最佳匹配，平均相似度 ≥ 0.6 视为同一组选项
  private questionBankOptionsContentSimilar(question: QuestionItem, entry: QuestionBankEntry) {
    const questionOptions = (question.options || [])
      .map((option) => this.normalizeAnswerOptionText(String(option)))
      .filter(Boolean);
    const entryOptions = (entry.options || [])
      .map((option) => this.normalizeAnswerOptionText(String(option)))
      .filter(Boolean);
    if (questionOptions.length === 0 || entryOptions.length === 0) return true;

    const scores = questionOptions.map((questionOption) => {
      let best = 0;
      for (const entryOption of entryOptions) {
        if (!entryOption) continue;
        if (questionOption === entryOption) {
          best = 1;
          break;
        }
        const shorter = questionOption.length <= entryOption.length ? questionOption : entryOption;
        const longer = questionOption.length > entryOption.length ? questionOption : entryOption;
        if (longer.includes(shorter) && shorter.length >= 2) {
          best = Math.max(best, shorter.length / longer.length);
          continue;
        }
        if (shorter.length >= 2) best = Math.max(best, this.bigramDice(questionOption, entryOption));
      }
      return best;
    });
    const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    return average >= 0.6;
  }

  private bigramDice(left: string, right: string) {
    if (left === right) return 1;
    if (left.length < 2 || right.length < 2) return 0;
    const grams = new Map<string, number>();
    for (let index = 0; index < left.length - 1; index += 1) {
      const gram = left.slice(index, index + 2);
      grams.set(gram, (grams.get(gram) || 0) + 1);
    }
    let intersection = 0;
    for (let index = 0; index < right.length - 1; index += 1) {
      const gram = right.slice(index, index + 2);
      const count = grams.get(gram) || 0;
      if (count > 0) {
        grams.set(gram, count - 1);
        intersection += 1;
      }
    }
    return (2 * intersection) / (left.length + right.length - 2);
  }

  // 题库条目 key 计算包含多轮正则归一化，查找时对每条 entry 现场重算是渲染路径的主要开销。
  // 条目对象在命中计数/更新时会被整体替换，WeakMap 以对象身份为键天然失效，无需手动清理。
  private questionBankEntryKeyCache = new WeakMap<QuestionBankEntry, string>();

  private questionBankEntryKey(entry: QuestionBankEntry) {
    const cached = this.questionBankEntryKeyCache.get(entry);
    if (cached !== undefined) return cached;
    const key = this.computeQuestionBankEntryKey(entry);
    this.questionBankEntryKeyCache.set(entry, key);
    return key;
  }

  private computeQuestionBankEntryKey(entry: QuestionBankEntry) {
    return this.normalizeQuestionContentKey({
      id: entry.id || 'bank',
      hash: entry.answer?.questionHash || '',
      question: entry.question,
      options: Array.isArray(entry.options) ? entry.options : [],
      context: entry.context,
      type: 'unknown',
      source: 'manual',
      capturedAt: entry.updatedAt || Date.now()
    });
  }

  private findExactQuestionBankEntry(question: QuestionItem) {
    const contentKey = this.normalizeQuestionContentKey(question);
    const legacyKey = this.normalizeQuestionKey(question);
    const allowLegacyQuestionOnly = !question.context;
    let best: QuestionBankEntry | null = null;
    let legacyBest: QuestionBankEntry | null = null;
    for (const entry of this.state.questionBank) {
      const entryKey = this.questionBankEntryKey(entry);
      const entryLegacyKey = this.normalizeQuestionKey(entry.question);
      const matches = entry.questionKey === contentKey ||
        (allowLegacyQuestionOnly && entry.questionKey === legacyKey) ||
        entryKey === contentKey ||
        (allowLegacyQuestionOnly && entryLegacyKey === legacyKey);
      if (matches && this.questionBankOptionsExact(question, entry)) {
        best = best ? this.preferQuestionBankEntry(best, entry) : entry;
        continue;
      }

      const legacyCompatible = Boolean(question.context) &&
        !entry.context &&
        entryLegacyKey === legacyKey &&
        this.questionBankOptionsExact(question, entry);
      if (legacyCompatible) {
        legacyBest = legacyBest ? this.preferQuestionBankEntry(legacyBest, entry) : entry;
      }
    }
    return best || legacyBest;
  }

  private findFuzzyQuestionBankEntry(question: QuestionItem) {
    const questionKey = question.context ? this.normalizeQuestionContentKey(question) : this.normalizeQuestionKey(question);
    if (questionKey.length < QUESTION_BANK_FUZZY_MIN_KEY_LENGTH) return null;

    const lengthBalanceOf = (a: string, b: string) => {
      const shorter = a.length <= b.length ? a : b;
      const longer = a.length > b.length ? a : b;
      return longer.length === 0 ? 0 : shorter.length / longer.length;
    };

    let best: { entry: QuestionBankEntry; score: number } | null = null;
    let legacyBest: { entry: QuestionBankEntry; score: number } | null = null;
    for (const entry of this.state.questionBank) {
      if (!this.questionBankOptionsCompatible(question, entry)) continue;
      // 题干相似但选项集合明显不同的题目不得命中（同题干多课程复用场景）
      if (!this.questionBankOptionsContentSimilar(question, entry)) continue;
      const entryKey = question.context ? this.questionBankEntryKey(entry) : this.normalizeQuestionKey(entry.question);
      const score = this.textSimilarity(questionKey, entryKey);
      const balance = lengthBalanceOf(questionKey, entryKey);
      if (score >= QUESTION_BANK_FUZZY_THRESHOLD && balance >= QUESTION_BANK_FUZZY_MIN_LENGTH_BALANCE &&
          (!best || score > best.score)) {
        best = { entry, score };
      }

      if (question.context && !entry.context) {
        const questionLegacyKey = this.normalizeQuestionKey(question);
        const entryLegacyKey = this.normalizeQuestionKey(entry.question);
        const legacyScore = this.textSimilarity(questionLegacyKey, entryLegacyKey);
        const legacyBalance = lengthBalanceOf(questionLegacyKey, entryLegacyKey);
        if (legacyScore >= QUESTION_BANK_FUZZY_THRESHOLD && legacyBalance >= QUESTION_BANK_FUZZY_MIN_LENGTH_BALANCE &&
            (!legacyBest || legacyScore > legacyBest.score)) {
          legacyBest = { entry, score: legacyScore };
        }
      }
    }

    return best || legacyBest;
  }

  findQuestionBankAnswer(question: QuestionItem) {
    const exactEntry = this.findExactQuestionBankEntry(question);
    const fuzzyMatch = exactEntry ? null : this.findFuzzyQuestionBankEntry(question);
    const entry = exactEntry || fuzzyMatch?.entry;
    if (!entry) return null;
    entry.hits += 1;
    this.saveQuestionBank(this.state.questionBank);
    this.emit();
    if (fuzzyMatch) {
      const percent = Math.round(fuzzyMatch.score * 100);
      this.addLog('success', `题库模糊命中，相似度 ${percent}%。`);
      return { ...entry.answer, questionHash: question.hash, provider: `本地题库·模糊 ${percent}%` };
    }
    return { ...entry.answer, questionHash: question.hash, provider: '本地题库' };
  }

  hasQuestionBankAnswer(question: QuestionItem) {
    return Boolean(this.findExactQuestionBankEntry(question)) ||
      Boolean(this.findFuzzyQuestionBankEntry(question));
  }

  private hashText(text: string) {
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  private optionLabelFor(index: number) {
    return String.fromCharCode(65 + index);
  }

  private optionLabelFromText(option: string, index: number) {
    return option.match(/^\s*([A-Z])\s*[.\s:：、。)]/i)?.[1]?.toUpperCase() || this.optionLabelFor(index);
  }

  private normalizeAnswerOptionText(text: string) {
    return String(text || '')
      .replace(/[\uff01-\uff5e]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
      .replace(/\u3000/g, ' ')
      .replace(/^\s*(?:answer|answers|\u6b63\u786e\u7b54\u6848|\u53c2\u8003\u7b54\u6848|\u7b54\u6848|\u9009\u9879|\u9009\u62e9)\s*[:\uff1a]?\s*/i, '')
      .replace(/^\s*[A-H]\s*[.\s:\uff1a\u3001\u3002)]\s*/i, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/[^\u2E80-\u9FFFA-Za-z0-9]+/g, '')
      .trim()
      .toLowerCase();
  }

  private answerOptionTextMatches(answer: string, option: string) {
    const answerBody = this.normalizeAnswerOptionText(answer);
    const optionBody = this.normalizeAnswerOptionText(option);
    if (!answerBody || !optionBody) return false;
    if (answerBody === optionBody) return true;
    // 子串匹配要求答案侧至少 2 个字符：
    // 单字母答案（如剥前缀后剩下的“c”）会对任何含该字母的选项误命中
    if (answerBody.length < 2) return false;
    return optionBody.includes(answerBody);
  }

  private normalizeManualAnswer(input: ManualQuestionBankInput, questionHash: string): AIAnswerResult {
    const answer = input.answer.trim();
    const labels = new Set<string>();
    // 零宽断言边界：消费型边界会让“A、C”只提取到 A（分隔符被上一个匹配吃掉导致 C 丢失）
    Array.from(answer.matchAll(/(?<![A-Za-z])([A-H])(?![A-Za-z])/gi))
      .map((match) => match[1].toUpperCase())
      .forEach((label) => labels.add(label));
    // 紧凑匹配前先剥离“答案：”等前缀，否则“答案：ABD”无法命中紧凑分支且字母互相粘连也无法被边界正则提取
    const compactSource = answer
      .replace(/^\s*(?:答案|参考答案|正确答案|选项|选择)\s*[:：]?\s*/i, '')
      .replace(/\s+/g, '');
    const compactLabels = compactSource.match(/^[A-H]{1,8}$/i)?.[0] || '';
    compactLabels.split('').forEach((label) => labels.add(label.toUpperCase()));

    const matchedOptions = input.options.filter((option, index) => {
      const label = this.optionLabelFromText(option, index);
      return labels.has(label) || this.answerOptionTextMatches(answer, option);
    });
    matchedOptions.forEach((option) => {
      const optionIndex = input.options.indexOf(option);
      labels.add(this.optionLabelFromText(option, optionIndex >= 0 ? optionIndex : 0));
    });

    return {
      questionHash,
      provider: '本地手动题库',
      model: 'manual',
      answer,
      choiceLabels: Array.from(labels),
      matchedOptions,
      confidence: 1,
      analysis: input.analysis?.trim() || '来自本地手动题库，未调用 AI。',
      warnings: [],
      createdAt: Date.now()
    };
  }

  addManualQuestionBankItems(items: ManualQuestionBankInput[]) {
    let added = 0;
    let skipped = 0;
    for (const item of items) {
      const question = item.question.trim();
      const answer = item.answer.trim();
      if (!question || !answer) {
        skipped += 1;
        continue;
      }
      const options = (item.options || []).map((option) => option.trim()).filter(Boolean);
      const hash = this.hashText(`${question}\n${options.join('\n')}`);
      const questionItem: QuestionItem = {
        id: `manual_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        hash,
        question,
        options,
        type: item.type || (options.length > 0 ? 'single' : 'completion'),
        source: 'manual',
        capturedAt: Date.now()
      };
      this.upsertQuestionBank(questionItem, this.normalizeManualAnswer({ ...item, question, options, answer }, hash));
      added += 1;
    }
    this.addLog(added > 0 ? 'success' : 'warn', `手动题库导入完成：新增/更新 ${added} 条，跳过 ${skipped} 条。`);
    return { added, skipped };
  }

  importQuestionBank(entries: unknown[]) {
    let imported = 0;
    let skipped = 0;
    const nextEntries = [...this.state.questionBank];
    for (const raw of entries) {
      const item = raw as Partial<QuestionBankEntry>;
      if (!item || typeof item !== 'object' || !item.question || !item.answer?.answer) {
        skipped += 1;
        continue;
      }
      const question = String(item.question).trim();
      const options = Array.isArray(item.options) ? item.options.map((option) => String(option).trim()).filter(Boolean) : [];
      const context = item.context ? String(item.context) : undefined;
      const key = item.questionKey && !context ? item.questionKey : this.normalizeQuestionContentKey({
        id: 'import',
        hash: '',
        question,
        options,
        context,
        type: options.length > 0 ? 'single' : 'completion',
        source: 'manual',
        capturedAt: Date.now()
      });
      const entry: QuestionBankEntry = {
        id: item.id || Math.random().toString(36).slice(2),
        questionKey: key,
        question,
        options,
        context,
        answer: {
          questionHash: item.answer.questionHash || this.hashText(`${question}\n${options.join('\n')}`),
          provider: item.answer.provider || '本地导入题库',
          model: item.answer.model || 'import',
          answer: String(item.answer.answer),
          choiceLabels: Array.isArray(item.answer.choiceLabels) ? item.answer.choiceLabels.map(String) : [],
          matchedOptions: Array.isArray(item.answer.matchedOptions) ? item.answer.matchedOptions.map(String) : [],
          confidence: typeof item.answer.confidence === 'number' ? item.answer.confidence : 1,
          analysis: item.answer.analysis || '来自本地导入题库，未调用 AI。',
          warnings: Array.isArray(item.answer.warnings) ? item.answer.warnings.map(String) : [],
          createdAt: typeof item.answer.createdAt === 'number' ? item.answer.createdAt : Date.now()
        },
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
        hits: typeof item.hits === 'number' ? item.hits : 0
      };
      const existingIndex = nextEntries.findIndex((entryItem) => entryItem.questionKey === entry.questionKey);
      if (existingIndex >= 0) nextEntries[existingIndex] = entry;
      else nextEntries.unshift(entry);
      imported += 1;
    }
    this.state.questionBank = this.dedupeQuestionBank(nextEntries).slice(0, 1000);
    this.saveQuestionBank(this.state.questionBank);
    this.addLog(imported > 0 ? 'success' : 'warn', `题库文件导入完成：新增/更新 ${imported} 条，跳过 ${skipped} 条。`);
    this.emit();
    return { imported, skipped };
  }

  upsertQuestionBank(question: QuestionItem, answer: AIAnswerResult) {
    const key = this.normalizeQuestionContentKey(question);
    const normalizedAnswer = { ...answer, questionHash: question.hash };
    const existing = this.findExactQuestionBankEntry(question);
    if (existing) {
      const incomingEntry: QuestionBankEntry = {
        id: existing.id,
        questionKey: key,
        question: question.question,
        options: [...question.options],
        context: question.context,
        answer: normalizedAnswer,
        updatedAt: Date.now(),
        hits: existing.hits
      };
      const preferred = this.preferQuestionBankEntry(existing, incomingEntry);
      // 仅在采纳新条目时才更新 questionKey：保留旧条目却改写其 key 会让 key 与内容脱钩，
      // 后续精确匹配可能错配到其他题目
      if (preferred === incomingEntry) {
        // 条目内容变更前先失效 key 缓存（WeakMap 以对象身份为键，原地修改不会自动失效）
        this.questionBankEntryKeyCache.delete(existing);
        existing.questionKey = key;
        existing.question = question.question;
        // 拷贝 options，避免与 questions 状态共享可变引用
        existing.options = [...question.options];
        existing.context = question.context;
        existing.answer = normalizedAnswer;
        existing.updatedAt = incomingEntry.updatedAt;
      }
    } else {
      this.state.questionBank = [{
        id: Math.random().toString(36).slice(2),
        questionKey: key,
        question: question.question,
        options: [...question.options],
        context: question.context,
        answer: normalizedAnswer,
        updatedAt: Date.now(),
        hits: 0
      }, ...this.state.questionBank].slice(0, 1000);
    }
    this.state.questionBank = this.dedupeQuestionBank(this.state.questionBank);
    this.saveQuestionBank(this.state.questionBank);
    this.emit();
  }

  updateSettings(updates: Partial<AppSettings>) {
    this.state.settings = normalizeSettings({ ...this.state.settings, ...updates });
    this.saveSettings(this.state.settings);
    this.addLog('info', '设置已更新。');
    this.emit();
  }

  recordTokenUsage(input: Omit<TokenUsageRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: number }) {
    const record: TokenUsageRecord = {
      id: input.id || Math.random().toString(36).slice(2),
      provider: input.provider || '未知服务商',
      model: input.model || 'unknown',
      promptTokens: Math.max(0, Math.floor(Number(input.promptTokens) || 0)),
      completionTokens: Math.max(0, Math.floor(Number(input.completionTokens) || 0)),
      totalTokens: Math.max(0, Math.floor(Number(input.totalTokens) || 0)),
      source: input.source,
      questionIndex: input.questionIndex,
      questionTitle: input.questionTitle,
      durationMs: input.durationMs,
      createdAt: input.createdAt || Date.now()
    };
    if (record.totalTokens <= 0) record.totalTokens = record.promptTokens + record.completionTokens;
    if (record.totalTokens <= 0) return;
    this.state.tokenUsage = [record, ...this.state.tokenUsage].slice(0, 2000);
    this.saveTokenUsage(this.state.tokenUsage);
    this.emit();
  }

  updateProvider(providerId: string, updates: Partial<AIProviderConfig>) {
    this.state.settings.providers = normalizeProviders(
      this.state.settings.providers.map((provider) =>
        provider.id === providerId ? { ...provider, ...updates } : provider
      )
    );
    this.saveSettings(this.state.settings);
    this.addLog('info', `AI 服务配置已更新：${providerId}`);
    this.emit();
  }

  setStatus(status: AutomationStatus, text: string) {
    this.state.status = status;
    this.state.statusText = text;
    this.addLog(status === 'error' ? 'error' : status === 'done' ? 'success' : 'info', text);
    this.emit();
  }

  setSnapshot(snapshot: PageSnapshot | null) {
    this.state.snapshot = snapshot;
    if (snapshot) this.addLog('success', `已从页面捕获 ${snapshot.controls.length} 个可见控件。`);
    this.emit();
  }

  setPlan(plan: AutomationPlan | null) {
    this.state.currentPlan = plan;
    if (plan) this.addLog('info', `已生成包含 ${plan.steps.length} 个步骤的自动化计划。`);
    this.emit();
  }

  approvePlan(approved: boolean) {
    if (!this.state.currentPlan) return;
    this.state.currentPlan = { ...this.state.currentPlan, approved };
    this.addLog(approved ? 'success' : 'warn', approved ? '自动化计划已批准。' : '已取消计划批准。');
    this.emit();
  }

  completePlan(result: string) {
    if (!this.state.currentPlan) return;
    const completed = { ...this.state.currentPlan, executedAt: Date.now(), result };
    this.state.currentPlan = completed;
    // 幂等：同一 plan 重复 complete 时在 history 中去重，避免同 id 记录导致 React duplicate key
    this.state.history = [completed, ...this.state.history.filter((item) => item.id !== completed.id)].slice(0, 50);
    this.saveHistory(this.state.history);
    this.setStatus('done', result);
    this.emit();
  }

  setQuestions(inputQuestions: QuestionItem[], selectedIndex = 0) {
    const questions = inputQuestions.filter((question, index, all) =>
      all.findIndex((item) => item.hash === question.hash) === index
    );
    this.state.questions = questions;
    this.state.currentQuestionIndex = Math.max(0, Math.min(selectedIndex, Math.max(questions.length - 1, 0)));
    this.state.currentAnswer = questions[this.state.currentQuestionIndex]
      ? this.state.answerMap[questions[this.state.currentQuestionIndex].hash] || null
      : null;
    if (questions.length > 0) this.addLog('success', `已抓取 ${questions.length} 道题。`);
    this.emit();
  }

  setCurrentQuestionIndex(index: number) {
    this.state.currentQuestionIndex = Math.max(0, Math.min(index, Math.max(this.state.questions.length - 1, 0)));
    const question = this.state.questions[this.state.currentQuestionIndex];
    this.state.currentAnswer = question ? this.state.answerMap[question.hash] || null : null;
    this.emit();
  }

  setCurrentQuestion(question: QuestionItem | null) {
    this.setQuestions(question ? [question] : [], 0);
  }

  setCurrentAnswer(answer: AIAnswerResult | null) {
    const question = this.state.questions[this.state.currentQuestionIndex];
    // answerMap key 口径统一为 question.hash：上游若传入不一致的 questionHash，
    // 答案会写入错误 key 导致“已解析”状态丢失并重复请求
    const normalizedAnswer = answer && question ? { ...answer, questionHash: question.hash } : answer;
    this.state.currentAnswer = normalizedAnswer;
    if (normalizedAnswer && question) {
      this.state.answerMap = { ...this.state.answerMap, [question.hash]: normalizedAnswer };
      const entry = { question, answer: normalizedAnswer };
      this.state.answerHistory = [entry, ...this.state.answerHistory.filter((item) => item.question.hash !== entry.question.hash)].slice(0, 120);
      this.saveAnswerHistory(this.state.answerHistory);
      this.addLog('success', `AI 已返回第 ${question.index || this.state.currentQuestionIndex + 1} 题参考答案，置信度 ${(normalizedAnswer.confidence * 100).toFixed(0)}%。`);
    }
    this.emit();
  }

  setAnswerForQuestion(question: QuestionItem, answer: AIAnswerResult, makeCurrent = false) {
    const normalizedAnswer = { ...answer, questionHash: question.hash };
    this.state.answerMap = { ...this.state.answerMap, [question.hash]: normalizedAnswer };
    const entry = { question, answer: normalizedAnswer };
    this.state.answerHistory = [entry, ...this.state.answerHistory.filter((item) => item.question.hash !== question.hash)].slice(0, 120);
    this.saveAnswerHistory(this.state.answerHistory);
    if (makeCurrent || this.state.questions[this.state.currentQuestionIndex]?.hash === question.hash) {
      this.state.currentAnswer = normalizedAnswer;
      const index = this.state.questions.findIndex((item) => item.hash === question.hash);
      if (index >= 0) this.state.currentQuestionIndex = index;
    }
    this.addLog('success', `已返回第 ${question.index || question.hash.slice(0, 6)} 题参考答案，置信度 ${(normalizedAnswer.confidence * 100).toFixed(0)}%。`);
    this.emit();
  }

  setChapterLearning(state: ChapterLearningState | null) {
    this.state.chapterLearning = state;
    if (state) this.addLog('info', `章节学习状态已更新：${state.lastMessage}`);
    this.emit();
  }

  clearHistory() {
    this.state.history = [];
    this.saveHistory([]);
    this.addLog('info', '自动化历史已清空。');
    this.emit();
  }

  clearAnswerHistory() {
    this.state.answerHistory = [];
    this.state.answerMap = {};
    // 同步清空当前答案：否则题目行显示“未解析”但答案面板仍展示旧答案且可继续填入，UI 自相矛盾
    this.state.currentAnswer = null;
    this.saveAnswerHistory([]);
    this.addLog('info', '答案历史已清空。');
    this.emit();
  }

  clearTokenUsage() {
    this.state.tokenUsage = [];
    this.saveTokenUsage([]);
    this.addLog('info', 'Token 消耗统计已清空。');
    this.emit();
  }

  clearQuestionBank() {
    this.state.questionBank = [];
    this.saveQuestionBank([]);
    this.addLog('info', '题库已清空。');
    this.emit();
  }

  addLog(level: AppLog['level'], message: string) {
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const log: AppLog = {
      id: Math.random().toString(36).slice(2),
      timestamp,
      level,
      message
    };
    this.state.logs = [log, ...this.state.logs].slice(0, 120);
    this.emit();
  }
}

export const appStore = new GlobalStore();

// 模块顶层绑定一次，保证 useSyncExternalStore 的 subscribe/getSnapshot 引用跨渲染稳定
const subscribeToAppStore = appStore.subscribe.bind(appStore);
const getAppStoreSnapshot = appStore.getState.bind(appStore);

export function useAppStore() {
  return useSyncExternalStore(subscribeToAppStore, getAppStoreSnapshot);
}
