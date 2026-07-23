import React, { useMemo, useRef } from 'react';
import { aiChatText } from '../utils/aiRequest';
import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  Database,
  FileQuestion,
  ListChecks,
  MousePointer2,
  MousePointerClick,
  Pause,
  Play,
  Search,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import { AIAnswerResult, AIProviderConfig, appStore, QuestionItem, useAppStore } from '../store/appStore';

const statusLabels: Record<string, string> = {
  idle: '空闲',
  scanning: '扫描中',
  planning: '计划中',
  awaiting_approval: '待批准',
  executing: '执行中',
  extracting_question: '抓题中',
  calling_ai: 'AI 解析中',
  done: '完成',
  error: '错误'
};

const typeLabels: Record<string, string> = {
  single: '单选',
  multiple: '多选',
  judgement: '判断',
  completion: '填空',
  essay: '问答',
  unknown: '未知'
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const MAX_AI_CONCURRENCY = 5;

function normalizeApiConcurrency(value: unknown) {
  const numberValue = Math.floor(Number(value));
  if (!Number.isFinite(numberValue)) return 5;
  return Math.max(1, Math.min(MAX_AI_CONCURRENCY, numberValue));
}

function isApiBalanceError(message: string) {
  return /(insufficient|balance|quota|credit|billing|payment|required|prepaid|arrear|余额|额度|欠费|账户余额|资源包|配额|费用|充值|无可用额度|not enough)/i.test(message);
}

function apiFailureHint(message: string) {
  if (isApiBalanceError(message)) {
    return 'AI 接口提示余额或额度不足，请到对应服务商控制台充值、开通计费或更换可用 API Key。';
  }
  if (/429|Too many requests|rate limit|limitation/i.test(message)) {
    return 'AI 接口限流，请降低并发数或稍后重试。';
  }
  return '';
}

function notifyTaskDone(title: string, body: string) {
  const api = (window as any).electronAPI;
  if (!api?.notify) return;
  api.notify(title, body).catch((error: Error) => {
    appStore.addLog('warn', `桌面通知发送失败：${error.message}`);
  });
}

function buildAIHeaders(provider: AIProviderConfig) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (provider.authHeader === 'api-key') headers['api-key'] = provider.apiKey;
  else if (provider.authHeader !== 'none') headers.Authorization = `Bearer ${provider.apiKey}`;
  return headers;
}

function questionTypeHint(type?: string) {
  if (type === 'single') return 'Single choice. Return the one correct option content.';
  if (type === 'multiple') return 'Multiple choice. Return every correct option content in matchedOptions.';
  if (type === 'judgement') return 'Judgement. Return only true/correct or false/wrong.';
  if (type === 'completion') return 'Fill-in-the-blank. Separate multiple blanks with ##.';
  if (type === 'essay') return 'Short answer. Return a concise answer that can be filled directly.';
  return 'Infer the question type from the stem and options first.';
}

function buildPrompt(question: QuestionItem) {
  const optionLines = question.options.map((option, index) => {
    const label = optionLabelFromText(option, index);
    const text = option.replace(/^\s*[A-H]\s*[.\s:\uff1a\u3001\u3002)]\s*/i, '').trim();
    return `${label}. ${text}`;
  });
  return [
    'You are solving Chaoxing/Xuexitong questions. Use the OCS/ZError style: for choice questions, prefer returning the full correct option text, not only A/B/C/D. Page option letters or hidden values may be shuffled.',
    '',
    'Rules:',
    '1. Return JSON only. Do not return Markdown or code fences.',
    '2. For choice questions, answer should be the correct option content; matchedOptions must contain the full option text whenever possible.',
    '3. choiceLabels may contain A/B/C/D inferred from the option order below, but matchedOptions is the primary source for local matching.',
    '4. If the question is incomplete or uncertain, add warnings and set confidence below 0.55. Do not fabricate.',
    '5. For judgement questions, answer only true/correct or false/wrong. For fill-in questions, separate blanks with ##.',
    '',
    `Question number: ${question.index || ''}`,
    `Question type: ${question.type}`,
    `Type hint: ${questionTypeHint(question.type)}`,
    question.context ? `Context:\n${question.context}` : '',
    `Question: ${question.question}`,
    optionLines.length ? `Options in page display order:\n${optionLines.join('\n')}` : '',
    '',
    'JSON schema:',
    '{',
    '  "answer": "correct answer content",',
    '  "choiceLabels": ["A"],',
    '  "matchedOptions": ["A. full correct option text"],',
    '  "confidence": 0.9,',
    '  "analysis": "brief reason",',
    '  "warnings": []',
    '}'
  ].filter(Boolean).join('\n');
}

function toHalfWidth(text: string) {
  return String(text || '').replace(/[\uff01-\uff5e]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0)
  ).replace(/\u3000/g, ' ');
}

function optionLabelFor(index: number) {
  return String.fromCharCode(65 + index);
}

function optionLabelFromText(option: string, index: number) {
  return toHalfWidth(option).match(/^\s*([A-H])\s*[.\s:\uff1a\u3001\u3002)]/i)?.[1]?.toUpperCase() || optionLabelFor(index);
}

function normalizeOptionText(text: string) {
  return toHalfWidth(text)
    .replace(/^\s*(?:answer|answers|\u6b63\u786e\u7b54\u6848|\u53c2\u8003\u7b54\u6848|\u7b54\u6848|\u9009\u9879|\u9009\u62e9)\s*[:\uff1a]?\s*/i, '')
    .replace(/^\s*[A-H]\s*[.\s:\uff1a\u3001\u3002)]\s*/i, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[^\u2E80-\u9FFFA-Za-z0-9]+/g, '')
    .trim()
    .toLowerCase();
}

function extractChoiceLabels(answer: string) {
  const value = toHalfWidth(answer);
  const compact = value.replace(/\s+/g, '').match(/^[A-H]{1,8}$/i)?.[0] || '';
  // 零宽断言边界：消费型边界会让“A、C”只提取到 A（分隔符被上一个匹配吃掉）
  const labels = compact
    ? compact.split('')
    : Array.from(value.matchAll(/(?:(?<=答案)|(?<=选项)|(?<=选择)|(?<![A-Za-z]))([A-H])(?![A-Za-z])/gi)).map((match) => match[1]);
  return Array.from(new Set(labels.map((label) => label.toUpperCase())));
}

function textSimilarity(left: string, right: string) {
  if (left === right) return 1;
  if (!left || !right) return 0;
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }
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

function answerParts(rawAnswer: string, rawMatched?: unknown) {
  const matched = Array.isArray(rawMatched) ? rawMatched.map((item) => String(item)).filter(Boolean) : [];
  return Array.from(new Set([
    String(rawAnswer || ''),
    ...matched,
    ...String(rawAnswer || '').split(/[\u3001,\uff0c;\uff1b\n/]+/g)
  ].map((item) => item.trim()).filter(Boolean)));
}

function parseAIAnswerContent(content: string) {
  const raw = String(content || '').replace(/```json|```/gi, '').trim();
  const tryParse = (value: string) => {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const direct = tryParse(raw);
  if (direct && typeof direct === 'object') return direct;

  const jsonBlock = raw.match(/\{[\s\S]*\}/)?.[0] || '';
  const block = jsonBlock ? tryParse(jsonBlock) : null;
  if (block && typeof block === 'object') return block;

  const answerMatch = raw.match(/["']?(?:answer|anwser)["']?\s*[:?]\s*["']?([^"',?\n\r}]+)/i);
  return {
    answer: answerMatch?.[1]?.trim() || raw,
    choiceLabels: extractChoiceLabels(raw),
    matchedOptions: [],
    confidence: 0.62,
    analysis: raw,
    warnings: ['Model did not return strict JSON; fallback parsing was used.']
  };
}

function matchOptionsByText(question: QuestionItem, rawAnswer: string, rawMatched?: unknown) {
  const parts = answerParts(rawAnswer, rawMatched).map(normalizeOptionText).filter(Boolean);
  if (parts.length === 0) return [];
  const scored = question.options.map((option, index) => {
    const optionText = normalizeOptionText(option);
    const bestScore = Math.max(...parts.map((part) => textSimilarity(part, optionText)), 0);
    return { option, label: optionLabelFromText(option, index), score: bestScore };
  }).sort((left, right) => right.score - left.score);
  const best = scored[0];
  if (!best || best.score < 0.72) return [];
  const second = scored[1]?.score || 0;
  if (best.score < 0.95 && best.score - second < 0.12) return [];
  return scored.filter((item) => item.score >= 0.95 || (item.score >= 0.72 && item.score === best.score));
}

function normalizeAnswer(question: QuestionItem, rawAnswer: string, rawLabels?: unknown, rawMatched?: unknown) {
  const answer = String(rawAnswer || '\u672a\u8bc6\u522b\u5230\u7b54\u6848');
  const providedLabels = Array.isArray(rawLabels)
    ? rawLabels.map((item) => String(item).trim().toUpperCase()).filter((label) => /^[A-H]$/.test(label))
    : extractChoiceLabels(answer);
  const textMatches = matchOptionsByText(question, answer, rawMatched);
  const textLabels = textMatches.map((item) => item.label);
  const allowMultiple = question.type === 'multiple' || providedLabels.length > 1;
  const labels = textLabels.length > 0 ? textLabels : providedLabels;
  const choiceLabels = Array.from(new Set(allowMultiple ? labels : labels.slice(0, 1)));
  const byLabel = question.options.filter((option, index) => choiceLabels.includes(optionLabelFromText(option, index)));
  const providedMatched = Array.isArray(rawMatched) ? rawMatched.map((item) => String(item)).filter(Boolean) : [];
  const matchedOptions = Array.from(new Set([...providedMatched, ...textMatches.map((item) => item.option), ...byLabel]));
  return { choiceLabels, matchedOptions };
}

function demoAnswer(question: QuestionItem): AIAnswerResult {
  const optionA = question.options.find((option) => option.startsWith('A.')) || question.options[0] || '请结合题干判断';
  const normalized = normalizeAnswer(question, optionA);
  return {
    questionHash: question.hash,
    provider: '本地演示',
    model: 'demo',
    answer: optionA,
    choiceLabels: normalized.choiceLabels,
    matchedOptions: normalized.matchedOptions,
    confidence: 0.82,
    analysis: '当前未配置 API Key，因此使用本地演示解析。配置 AI 服务后，将根据抓取到的题干和选项请求真实模型。',
    warnings: ['演示结果仅用于验证题库、展示和填入流程。'],
    createdAt: Date.now()
  };
}

export function AIPanel() {
  const { status, statusText, settings, questions, currentQuestion, currentQuestionIndex, currentAnswer, answerMap, questionBank, batchRunning, liveRunning, livePaused } = useAppStore();
  // 运行状态存放在 appStore（组件随 tab 切换卸载后仍可从 store 恢复真实状态）；
  // livePausedRef 仅作 async 循环内的即时读取通道，写入时同步 store
  const livePausedRef = useRef(livePaused);
  const setBatchRunning = (value: boolean) => appStore.setAutomationRunning({ batchRunning: value });
  const setLiveRunning = (value: boolean) => appStore.setAutomationRunning({ liveRunning: value });
  const setLivePaused = (value: boolean) => {
    livePausedRef.current = value;
    appStore.setAutomationRunning({ livePaused: value });
  };
  const activeProvider = settings.providers.find((provider) => provider.id === settings.activeProviderId) || settings.providers[0];
  const aiConcurrency = normalizeApiConcurrency(settings.apiConcurrency);
  // 题库命中判定包含全库模糊匹配（O(bank×key²)），渲染期逐题现场计算会在状态高频变化时卡死 UI；
  // 仅在题目列表或题库变化时重算一次
  const bankHitSet = useMemo(() => {
    const hits = new Set<string>();
    questions.forEach((question) => {
      if (appStore.hasQuestionBankAnswer(question)) hits.add(question.hash);
    });
    return hits;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questions, questionBank]);
  const updateAiConcurrency = (value: number) => {
    appStore.updateSettings({ apiConcurrency: normalizeApiConcurrency(value) });
  };

  const runAutomationAction = (action: 'extract-question') => {
    window.dispatchEvent(new CustomEvent('studypilot:automation-action', {
      detail: { action }
    }));
  };

  const requestAI = async (question: QuestionItem): Promise<AIAnswerResult> => {
    const bankAnswer = appStore.findQuestionBankAnswer(question);
    if (bankAnswer) {
      appStore.addLog('success', `题库命中第 ${question.index || currentQuestionIndex + 1} 题，已跳过 AI。`);
      return bankAnswer;
    }

    if (activeProvider.authHeader !== 'none' && !activeProvider.apiKey) {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      // 演示答案不入库：避免占位答案覆盖真实 AI 答案、污染导出与云端共享题库
      return demoAnswer(question);
    }

    const requestBody: Record<string, any> = {
      model: activeProvider.model,
      messages: [
        { role: 'system', content: '你是严谨的学习辅助解析助手，只输出 JSON。' },
        { role: 'user', content: buildPrompt(question) }
      ],
      temperature: 0.1
    };
    if (activeProvider.supportsResponseFormat !== false && activeProvider.authHeader !== 'api-key' && activeProvider.authHeader !== 'none') {
      requestBody.response_format = { type: 'json_object' };
    }
    const startedAt = Date.now();
    // 走主进程代理（打包后 file:// 页面直接 fetch 会被 CORS 拦截），非 Electron 环境内部回退 fetch
    const response = await aiChatText({
      baseUrl: activeProvider.baseUrl,
      headers: buildAIHeaders(activeProvider),
      body: requestBody,
      timeoutMs: 30000
    });

    if (!response.ok) {
      const message = response.error || `接口返回 ${response.status}`;
      const hint = apiFailureHint(message);
      if (hint) appStore.addLog(isApiBalanceError(message) ? 'error' : 'warn', hint);
      throw new Error(hint ? `${message}\n${hint}` : message);
    }

    const data = (() => {
      try {
        return JSON.parse(response.text || '{}');
      } catch {
        throw new Error('AI 接口未返回可解析的 JSON 内容。');
      }
    })();
    const usage = data.usage || data.token_usage || {};
    const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? 0);
    const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? 0);
    const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? promptTokens + completionTokens);
    if (Number.isFinite(totalTokens) && totalTokens > 0) {
      appStore.recordTokenUsage({
        provider: activeProvider.name,
        model: activeProvider.model,
        promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
        completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
        totalTokens,
        source: 'answer',
        questionIndex: question.index,
        questionTitle: question.question.slice(0, 120),
        durationMs: Date.now() - startedAt
      });
    }
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = parseAIAnswerContent(content);
    const answer = parsed.answer || parsed.anwser || 'No answer recognized';
    const normalized = normalizeAnswer(
      question,
      answer,
      parsed.choiceLabels || parsed.choice_labels || parsed.labels,
      parsed.matchedOptions || parsed.matched_options
    );

    const result = {
      questionHash: question.hash,
      provider: activeProvider.name,
      model: activeProvider.model,
      answer,
      choiceLabels: normalized.choiceLabels,
      matchedOptions: normalized.matchedOptions,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.75,
      analysis: parsed.analysis || 'Model did not return detailed analysis.',
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      createdAt: Date.now()
    };
    appStore.upsertQuestionBank(question, result);
    return result;
  };

  const requestAIWithRetry = async (question: QuestionItem): Promise<AIAnswerResult> => {
    let lastError: any = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await requestAI(question);
      } catch (error: any) {
        lastError = error;
        const message = String(error?.message || '');
        const hint = apiFailureHint(message);
        if (hint && !/429|Too many requests|rate limit|limitation/i.test(message)) {
          appStore.setStatus('error', hint);
          break;
        }
        if (!/429|Too many requests|rate limit|limitation/i.test(message) || attempt === 3) break;
        const waitMs = 2200 * 2 ** attempt;
        appStore.addLog('warn', `AI 接口限流，等待 ${(waitMs / 1000).toFixed(1)} 秒后重试第 ${question.index || '?'} 题。`);
        await sleep(waitMs);
      }
    }
    throw lastError;
  };

  const callCurrentAI = async () => {
    if (!currentQuestion) {
      appStore.setStatus('error', '请先抓取页面题目。');
      return;
    }
    appStore.setStatus('calling_ai', `正在解析第 ${currentQuestion.index || currentQuestionIndex + 1} 题。`);
    try {
      const answer = await requestAIWithRetry(currentQuestion);
      appStore.setCurrentAnswer(answer);
      appStore.setStatus('done', `第 ${currentQuestion.index || currentQuestionIndex + 1} 题解析完成。`);
    } catch (error: any) {
      appStore.setStatus('error', `AI 请求失败：${error.name === 'AbortError' ? '请求超时' : error.message}`);
    }
  };

  const callAllAI = async () => {
    if (questions.length === 0) {
      appStore.setStatus('error', '请先抓取页面题目。');
      return;
    }
    setBatchRunning(true);
    try {
      for (let index = 0; index < questions.length; index += 1) {
        const question = questions[index];
        // 循环内实时读取 answerMap：批量运行期间题库命中/并行流程新增的答案对渲染时闭包不可见
        if (appStore.getState().answerMap[question.hash]) continue;
        appStore.setCurrentQuestionIndex(index);
        appStore.setStatus('calling_ai', `正在解析第 ${question.index || index + 1} / ${questions.length} 题，优先查询题库。`);
        const answer = await requestAIWithRetry(question);
        appStore.setCurrentAnswer(answer);
      }
      appStore.setStatus('done', `已完成 ${questions.length} 道题的解析。`);
      notifyTaskDone('题目解析已完成', `已完成 ${questions.length} 道题的解析。`);
    } catch (error: any) {
      appStore.setStatus('error', `批量解析失败：${error.name === 'AbortError' ? '请求超时' : error.message}`);
    } finally {
      setBatchRunning(false);
    }
  };

  const applyAnswersToPage = (items: { question: QuestionItem; answer: AIAnswerResult }[], onComplete?: (result: any) => void) => {
    if (items.length === 0) {
      appStore.setStatus('error', '没有可填入网页的答案。');
      onComplete?.({ success: false, error: '没有可填入网页的答案。' });
      return;
    }
    window.dispatchEvent(new CustomEvent('studypilot:apply-answers', { detail: { items, onComplete } }));
  };

  const applyAnswerToPageAsync = (question: QuestionItem, answer: AIAnswerResult) => new Promise<any>((resolve) => {
    applyAnswersToPage([{ question, answer }], resolve);
  });

  const extractCurrentPageQuestionAsync = () => new Promise<any>((resolve) => {
    window.dispatchEvent(new CustomEvent('studypilot:extract-question-request', {
      detail: { onComplete: resolve }
    }));
  });

  const goNextExamQuestionAsync = () => new Promise<any>((resolve) => {
    window.dispatchEvent(new CustomEvent('studypilot:exam-next-question', {
      detail: { onComplete: resolve }
    }));
  });

  const isSequentialExamQuestion = (question?: QuestionItem | null) => {
    if (!question) return false;
    return /reVersionTestStartNew/i.test(question.pageUrl || '') ||
      /singleQuestionDiv|fanyaMarking|questionLi/i.test(question.selector || '');
  };

  const shouldUseSequentialExamAutomation = () =>
    Boolean(currentQuestion && isSequentialExamQuestion(currentQuestion)) ||
    questions.some((question) => isSequentialExamQuestion(question));

  const waitWhileLivePaused = async () => {
    while (livePausedRef.current) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
  };

  const toggleLivePause = () => {
    const next = !livePausedRef.current;
    setLivePaused(next);
    appStore.setStatus(next ? 'idle' : 'calling_ai', next ? '已暂停边搜边填。' : '已继续边搜边填。');
  };

  const runSequentialExamAutomation = async () => {
    let resolvedCount = 0;
    let appliedCount = 0;
    const seen = new Set<string>();
    const finishSequential = (message: string) => {
      appStore.setStatus('done', message);
      notifyTaskDone('考试自动化已完成', message);
    };

    for (let step = 0; step < 160; step += 1) {
      await waitWhileLivePaused();
      appStore.setStatus('extracting_question', `正在抓取当前考试题目（第 ${step + 1} 轮）。`);
      const extractResult = await extractCurrentPageQuestionAsync();
      if (!extractResult?.success) throw new Error(extractResult?.error || '当前题目抓取失败。');
      const current = (Array.isArray(extractResult.questions) && extractResult.questions[0]) || extractResult.data;
      if (current) appStore.setCurrentQuestion(current);
      if (!current) throw new Error('当前页面未返回题目。');
      if (!isSequentialExamQuestion(current)) {
        finishSequential(`已离开逐题答题页，自动化停止。已解析 ${resolvedCount} 题，填入 ${appliedCount} 题。`);
        return;
      }

      const signature = `${current.index || ''}:${current.hash}`;
      if (seen.has(signature)) {
        finishSequential(`检测到题目未继续变化，自动化停止。已解析 ${resolvedCount} 题，填入 ${appliedCount} 题。`);
        return;
      }
      seen.add(signature);

      await waitWhileLivePaused();
      appStore.setCurrentQuestion(current);
      appStore.setStatus('calling_ai', `正在解析并填入第 ${current.index || step + 1} 题。`);
      const latestAnswer = appStore.getState().answerMap[current.hash];
      const answer = latestAnswer || await requestAIWithRetry(current);
      appStore.setAnswerForQuestion(current, answer, true);
      resolvedCount += 1;

      await waitWhileLivePaused();
      const applyResult = await applyAnswerToPageAsync(current, answer);
      if (!applyResult?.success) throw new Error(`第 ${current.index || step + 1} 题填入失败：${applyResult?.error || '未知错误'}`);
      appliedCount += 1;

      await waitWhileLivePaused();
      appStore.setStatus('executing', `第 ${current.index || step + 1} 题已填入，正在进入下一题。`);
      const nextResult = await goNextExamQuestionAsync();
      if (!nextResult?.success) {
        if (nextResult?.done) {
          finishSequential(`已进入全卷浏览。已解析 ${resolvedCount} 题，填入 ${appliedCount} 题。`);
          return;
        }
        throw new Error(nextResult?.error || '进入下一题失败。');
      }
      if (nextResult.done) {
        finishSequential(`已进入全卷浏览。已解析 ${resolvedCount} 题，填入 ${appliedCount} 题。`);
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    }

    finishSequential(`逐题自动化已达到安全上限。已解析 ${resolvedCount} 题，填入 ${appliedCount} 题。`);
  };

  const callAllAIAndApplyLive = async () => {
    if (questions.length === 0) {
      appStore.setStatus('error', '请先抓取页面题目。');
      return;
    }
    if (liveRunning) return;

    setLiveRunning(true);
    setLivePaused(false);

    // 从 store 实时取快照，避免使用渲染时闭包里的 answerMap/questions
    const liveState = appStore.getState();
    const pendingQuestions = liveState.questions.filter((question) => !liveState.answerMap[question.hash]);
    const preAnsweredItems = liveState.questions
      .filter((question) => liveState.answerMap[question.hash])
      .map((question) => ({ question, answer: liveState.answerMap[question.hash] }));
    let nextIndex = 0;
    let resolvedCount = preAnsweredItems.length;
    let appliedCount = 0;
    const applyPromises: Promise<void>[] = [];
    let applyQueue = Promise.resolve();

    const enqueueApply = (question: QuestionItem, answer: AIAnswerResult) => {
      const task = applyQueue
        .then(async () => {
          await waitWhileLivePaused();
          appStore.setStatus('executing', `正在填入第 ${question.index || '?'} 题答案。`);
          const result = await applyAnswerToPageAsync(question, answer);
          if (result?.success) {
            appliedCount += 1;
            appStore.addLog('success', `第 ${question.index || '?'} 题已自动填入。`);
          } else {
            appStore.addLog('error', `第 ${question.index || '?'} 题自动填入失败：${result?.error || '未知错误'}`);
          }
        });
      applyQueue = task.catch(() => undefined);
      applyPromises.push(task);
    };

    if (shouldUseSequentialExamAutomation()) {
      try {
        await runSequentialExamAutomation();
      } catch (error: any) {
        appStore.setStatus('error', `逐题考试自动化失败：${error.message}`);
      } finally {
        setLiveRunning(false);
        setLivePaused(false);
      }
      return;
    }

    try {
      const safeConcurrency = Math.max(1, Math.min(MAX_AI_CONCURRENCY, Math.floor(aiConcurrency) || 1, pendingQuestions.length || 1));
      appStore.setStatus('calling_ai', `开始并发查询 ${questions.length} 道题，并发数 ${safeConcurrency}，答案返回后自动填入。`);
      preAnsweredItems.forEach((item) => enqueueApply(item.question, item.answer));

      const workerCount = safeConcurrency;
      let fatalApiError = '';
      const workers = Array.from({ length: workerCount }, async () => {
        while (!fatalApiError && nextIndex < pendingQuestions.length) {
          await waitWhileLivePaused();
          if (fatalApiError) break;
          const question = pendingQuestions[nextIndex];
          nextIndex += 1;
          appStore.setStatus('calling_ai', `正在并发查询第 ${question.index || nextIndex} 题，进度 ${resolvedCount}/${questions.length}。`);
          try {
            const answer = await requestAIWithRetry(question);
            appStore.setAnswerForQuestion(question, answer, question.hash === currentQuestion?.hash);
            resolvedCount += 1;
            enqueueApply(question, answer);
          } catch (error: any) {
            resolvedCount += 1;
            const errorMessage = String(error?.message || '');
            const hint = apiFailureHint(errorMessage);
            if (hint) appStore.addLog(isApiBalanceError(errorMessage) ? 'error' : 'warn', hint);
            if (isApiBalanceError(errorMessage)) {
              fatalApiError = hint || 'AI 接口余额或额度不足，本轮自动化已停止。';
              nextIndex = pendingQuestions.length;
              appStore.setStatus('error', fatalApiError);
            }
            if (/429|Too many requests|rate limit|limitation/i.test(errorMessage) && safeConcurrency > 1) {
              updateAiConcurrency(Math.max(1, safeConcurrency - 1));
              appStore.addLog('warn', `接口限流，本轮仍会完成；下次自动化填入并发数将降为 ${safeConcurrency - 1}。`);
            }
            appStore.addLog('error', `第 ${question.index || '?'} 题查询失败：${error.name === 'AbortError' ? '请求超时' : error.message}`);
          }
        }
      });

      await Promise.all(workers);
      await Promise.allSettled(applyPromises);
      if (fatalApiError) {
        appStore.setStatus('error', `${fatalApiError} 已解析 ${resolvedCount}/${questions.length} 题，已填入 ${appliedCount} 题。`);
        return;
      }
      appStore.setStatus('done', `边搜边填完成：已解析 ${resolvedCount}/${questions.length} 题，已填入 ${appliedCount} 题。`);
      notifyTaskDone('自动化填入已完成', `已解析 ${resolvedCount}/${questions.length} 题，已填入 ${appliedCount} 题。`);
    } catch (error: any) {
      appStore.setStatus('error', `边搜边填失败：${error.message}`);
    } finally {
      setLiveRunning(false);
      setLivePaused(false);
    }
  };

  const applyCurrentAnswer = () => {
    if (!currentQuestion || !currentAnswer) {
      appStore.setStatus('error', '请先解析当前题答案。');
      return;
    }
    applyAnswersToPage([{ question: currentQuestion, answer: currentAnswer }]);
  };

  const applyAllAnswers = () => {
    const items = questions
      .map((question) => ({ question, answer: answerMap[question.hash] }))
      .filter((item): item is { question: QuestionItem; answer: AIAnswerResult } => Boolean(item.answer));
    applyAnswersToPage(items, (result) => {
      if (result?.success) notifyTaskDone('答案填入已完成', result.message || `已填入 ${items.length} 道题。`);
    });
  };

  const canParse = questions.length > 0 && !batchRunning && !liveRunning && status !== 'calling_ai';
  const parsedAnswerCount = questions.filter((question) => answerMap[question.hash]).length;
  const canFill = parsedAnswerCount > 0 && !liveRunning && status !== 'executing';

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflowY: 'auto' }}>
      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
          <div>
            <h4 style={{ fontSize: '0.95rem', color: 'var(--text-primary)', marginBottom: 6 }}>答题流程</h4>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.76rem', lineHeight: 1.55 }}>
              先获取当前页面题目，再解析答案，最后填入页面。自动化填入会边查题边填入，适合多题页面。
            </p>
          </div>
          <span className="badge badge-primary" style={{ whiteSpace: 'nowrap' }}>{questions.length} 题</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <button
            onClick={() => runAutomationAction('extract-question')}
            style={{ background: 'rgba(16,185,129,0.16)', color: 'var(--text-primary)', padding: '11px 10px', borderRadius: 8, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center', fontWeight: 900 }}
          >
            <FileQuestion size={15} /> 获取页面题目
          </button>
          <button
            onClick={callAllAI}
            disabled={!canParse}
            style={{ background: 'rgba(99,102,241,0.18)', color: 'var(--text-primary)', padding: '11px 10px', borderRadius: 8, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center', fontWeight: 900, opacity: canParse ? 1 : 0.55 }}
          >
            <Search size={15} /> 开始解析
          </button>
          <button
            onClick={applyAllAnswers}
            disabled={!canFill}
            style={{ background: 'rgba(245,158,11,0.15)', color: 'var(--text-primary)', padding: '11px 10px', borderRadius: 8, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center', fontWeight: 900, opacity: canFill ? 1 : 0.55 }}
          >
            <MousePointerClick size={15} /> 开始填入
          </button>
          <button
            onClick={callAllAIAndApplyLive}
            disabled={liveRunning || batchRunning || status === 'calling_ai' || questions.length === 0}
            style={{ background: 'linear-gradient(135deg, var(--primary-color), var(--accent-color))', color: '#fff', padding: '11px 10px', borderRadius: 8, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center', fontWeight: 900, opacity: liveRunning || batchRunning || status === 'calling_ai' || questions.length === 0 ? 0.55 : 1 }}
          >
            <Play size={15} /> 自动化填入
          </button>
        </div>

        {liveRunning && (
          <button
            onClick={toggleLivePause}
            style={{ background: livePaused ? 'rgba(16,185,129,0.16)' : 'rgba(245,158,11,0.16)', color: 'var(--text-primary)', padding: '10px 12px', borderRadius: 8, fontWeight: 800, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6 }}
          >
            {livePaused ? <Play size={15} /> : <Pause size={15} />} {livePaused ? '继续自动化填入' : '暂停自动化填入'}
          </button>
        )}

        <div className="glass-panel" style={{ padding: 12, borderRadius: 8, color: 'var(--text-secondary)', fontSize: '0.72rem', lineHeight: 1.5 }}>
          <MousePointer2 size={14} style={{ color: 'var(--primary-color)', marginBottom: 6 }} />
          已解析 {parsedAnswerCount}/{questions.length} 题。多题页面会按题号、题型和选项边界拆分；真实页面抓题和填入需要在设置中启用真实 WebView。
        </div>

        <div
          className="glass-panel"
          style={{
            padding: 12,
            borderRadius: 8,
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            gap: 12,
            alignItems: 'center',
            background: 'rgba(255,255,255,0.025)'
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--text-primary)', fontSize: '0.78rem', fontWeight: 850 }}>
              <Zap size={14} style={{ color: 'var(--primary-color)' }} /> API 并发数
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem', lineHeight: 1.45, marginTop: 4 }}>
              默认 5 路并会持久化保存；遇到 429 限流或接口不稳定时可降到 1-2 路。
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="range"
              min={1}
              max={MAX_AI_CONCURRENCY}
              step={1}
              value={aiConcurrency}
              disabled={liveRunning || batchRunning}
              onChange={(event) => updateAiConcurrency(Number(event.target.value))}
              style={{ width: 86, accentColor: 'var(--primary-color)', opacity: liveRunning || batchRunning ? 0.55 : 1 }}
            />
            <span
              className="badge badge-primary"
              style={{
                minWidth: 48,
                justifyContent: 'center',
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap'
              }}
            >
              {aiConcurrency} 路
            </span>
          </div>
        </div>
      </div>

      <div className="glass-panel" style={{ padding: 18, borderRadius: 8, borderLeft: '4px solid var(--primary-color)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <BrainCircuit size={18} style={{ color: 'var(--primary-color)' }} />
          <h4 style={{ color: 'var(--text-primary)', fontSize: '0.95rem' }}>题目抓取与答案解析</h4>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', lineHeight: 1.6 }}>
          抓题会过滤脚本和样式噪声。解析时优先查询本地题库，未命中才调用 AI，AI 结果会自动入库。
        </p>
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h5 style={{ color: 'var(--text-primary)', fontSize: '0.86rem' }}>当前状态</h5>
          <span className="badge badge-primary">{statusLabels[status] || status}</span>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.5 }}>{statusText}</p>
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h5 style={{ color: 'var(--text-primary)', fontSize: '0.86rem' }}>题库与 AI</h5>
          {activeProvider.apiKey ? <CheckCircle2 size={16} style={{ color: 'var(--success-color)' }} /> : <AlertTriangle size={16} style={{ color: 'var(--warning-color)' }} />}
        </div>
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', lineHeight: 1.6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Database size={13} /> 本地题库：{questionBank.length} 题</div>
          <div>服务商：{activeProvider.name}</div>
          <div>模型：{activeProvider.model}</div>
          <div>状态：{activeProvider.apiKey ? '已配置 API Key' : '未配置 API Key，将使用演示答案'}</div>
        </div>
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h5 style={{ color: 'var(--text-primary)', fontSize: '0.86rem' }}>题目列表</h5>
          <span className="badge badge-primary">{questions.length} 题</span>
        </div>
        {questions.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '28px 0', fontSize: '0.8rem' }}>
            <FileQuestion size={28} style={{ marginBottom: 8 }} />
            <div>还没有抓取题目。</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 340, overflowY: 'auto', paddingRight: 6 }}>
            {questions.map((question, index) => {
              const active = index === currentQuestionIndex;
              const answered = Boolean(answerMap[question.hash]);
              const bankHit = bankHitSet.has(question.hash);
              const stateLabel = answered ? '已解析' : bankHit ? '题库' : '未解析';
              const stateColor = answered ? 'var(--success-color)' : bankHit ? 'var(--warning-color)' : 'var(--text-muted)';
              return (
                <button
                  key={question.hash}
                  onClick={() => appStore.setCurrentQuestionIndex(index)}
                  style={{
                    textAlign: 'left',
                    background: active ? 'rgba(99,102,241,0.16)' : 'rgba(255,255,255,0.03)',
                    border: active ? '1px solid var(--primary-color)' : '1px solid var(--border-glass)',
                    color: 'var(--text-primary)',
                    padding: '10px 12px',
                    borderRadius: 8,
                    minHeight: 82,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    overflow: 'hidden'
                  }}
                >
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 10, alignItems: 'center' }}>
                    <span
                      style={{
                        minWidth: 0,
                        fontSize: '0.76rem',
                        color: 'var(--primary-color)',
                        fontWeight: 900,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}
                    >
                      第 {question.index || index + 1} 题 · {typeLabels[question.type] || question.type}
                    </span>
                    <span
                      style={{
                        color: stateColor,
                        fontSize: '0.7rem',
                        fontWeight: 850,
                        lineHeight: 1,
                        whiteSpace: 'nowrap',
                        flexShrink: 0
                      }}
                    >
                      {stateLabel}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: '0.76rem',
                      color: 'var(--text-secondary)',
                      lineHeight: 1.5,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                      wordBreak: 'break-word',
                      textWrap: 'pretty'
                    } as React.CSSProperties}
                  >
                    {question.question}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {currentQuestion && (
        <div className="glass-panel" style={{ padding: 16, borderRadius: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h5 style={{ color: 'var(--text-primary)', fontSize: '0.86rem' }}>当前题目</h5>
            <span className="badge badge-primary">{typeLabels[currentQuestion.type] || currentQuestion.type}</span>
          </div>
          <p style={{ color: 'var(--text-primary)', fontSize: '0.88rem', lineHeight: 1.55, fontWeight: 700 }}>{currentQuestion.question}</p>
          {currentQuestion.options.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
              {currentQuestion.options.map((option) => (
                <div key={option} style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', padding: '7px 9px', border: '1px solid var(--border-glass)', borderRadius: 6 }}>
                  {option}
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
            <button
              onClick={callCurrentAI}
              disabled={status === 'calling_ai'}
              style={{ background: 'linear-gradient(135deg, var(--primary-color), var(--accent-color))', color: '#fff', padding: 10, borderRadius: 8, fontWeight: 800, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6 }}
            >
              <Search size={15} /> 查询/解析当前题
            </button>
            <button
              onClick={callAllAI}
              disabled={batchRunning || liveRunning || status === 'calling_ai'}
              style={{ background: 'rgba(16,185,129,0.16)', color: 'var(--text-primary)', padding: 10, borderRadius: 8, fontWeight: 800, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6 }}
            >
              <ListChecks size={15} /> 批量查询/解析
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: liveRunning ? '1fr auto' : '1fr', gap: 8, marginTop: 8 }}>
            <button
              onClick={callAllAIAndApplyLive}
              disabled={liveRunning || batchRunning || status === 'calling_ai'}
              style={{ background: 'rgba(99,102,241,0.2)', color: 'var(--text-primary)', padding: 10, borderRadius: 8, fontWeight: 800, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6, opacity: liveRunning || batchRunning || status === 'calling_ai' ? 0.55 : 1 }}
            >
              <Play size={15} /> 并发查询并自动填入（{aiConcurrency} 路）
            </button>
            {liveRunning && (
              <button
                onClick={toggleLivePause}
                style={{ background: livePaused ? 'rgba(16,185,129,0.16)' : 'rgba(245,158,11,0.16)', color: 'var(--text-primary)', padding: '10px 12px', borderRadius: 8, fontWeight: 800, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6 }}
              >
                {livePaused ? <Play size={15} /> : <Pause size={15} />} {livePaused ? '继续' : '暂停'}
              </button>
            )}
          </div>
        </div>
      )}

      {currentAnswer && (
        <div className="glass-panel" style={{ padding: 16, borderRadius: 8, background: 'rgba(16,185,129,0.04)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h5 style={{ color: 'var(--text-primary)', fontSize: '0.86rem' }}>参考答案</h5>
            <span style={{ color: 'var(--success-color)', fontWeight: 800, fontSize: '0.8rem' }}>{(currentAnswer.confidence * 100).toFixed(0)}%</span>
          </div>
          <div style={{ color: '#34d399', fontSize: '1rem', fontWeight: 900, padding: 12, border: '1px solid rgba(16,185,129,0.18)', borderRadius: 8, marginBottom: 12 }}>
            {currentAnswer.answer}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            <button
              onClick={applyCurrentAnswer}
              style={{ background: 'rgba(16,185,129,0.16)', color: 'var(--text-primary)', padding: 10, borderRadius: 8, fontWeight: 800, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6 }}
            >
              <MousePointerClick size={15} /> 填入当前题
            </button>
            <button
              onClick={applyAllAnswers}
              style={{ background: 'rgba(99,102,241,0.16)', color: 'var(--text-primary)', padding: 10, borderRadius: 8, fontWeight: 800, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6 }}
            >
              <ListChecks size={15} /> 填入已解析
            </button>
          </div>
          {currentAnswer.choiceLabels.length > 0 && (
            <div style={{ color: 'var(--success-color)', fontSize: '0.78rem', fontWeight: 800, marginBottom: 10 }}>
              命中选项：{currentAnswer.choiceLabels.join('、')}
            </div>
          )}
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
            {currentAnswer.analysis}
          </div>
          {currentAnswer.warnings.length > 0 && (
            <div style={{ color: 'var(--warning-color)', fontSize: '0.75rem', lineHeight: 1.5, marginTop: 12 }}>
              {currentAnswer.warnings.map((warning) => <div key={warning}>提示：{warning}</div>)}
            </div>
          )}
          <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem', marginTop: 12 }}>
            来源：{currentAnswer.provider} / {currentAnswer.model}
          </div>
        </div>
      )}

      <div className="glass-panel" style={{ padding: 14, borderRadius: 8, color: 'var(--text-secondary)', fontSize: '0.72rem', lineHeight: 1.5 }}>
        <ShieldCheck size={14} style={{ color: 'var(--primary-color)', marginBottom: 6 }} />
        AI 返回的是学习参考答案。填入选项不会自动提交，请自行核对题目上下文、课程材料和平台规则。
      </div>
    </div>
  );
}
