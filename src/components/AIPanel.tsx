import React, { useRef, useState } from 'react';
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
} from 'lucide-react';
import { AIAnswerResult, appStore, QuestionItem, useAppStore } from '../store/appStore';

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

function buildPrompt(question: QuestionItem) {
  return `你是一个学习辅助解析助手。请根据题目内容给出参考答案和解析。
要求：
1. 只返回 JSON，不要返回 Markdown 代码块。
2. answer 字段写最可能的答案；选择题请返回选项字母和简短选项文本。
3. choiceLabels 字段返回命中的选项字母数组，例如 ["A"] 或 ["A","C"]。
4. matchedOptions 字段返回命中的完整选项文本数组。
5. confidence 是 0 到 1 之间的小数。
6. analysis 给出简洁解析。
7. warnings 用数组提示不确定性或题目歧义。

题号：${question.index || ''}
题型：${question.type}
题目：${question.question}
${question.options.length ? `选项：\n${question.options.join('\n')}` : ''}

JSON 格式：
{
  "answer": "...",
  "choiceLabels": ["A"],
  "matchedOptions": ["A. ..."],
  "confidence": 0.9,
  "analysis": "...",
  "warnings": []
}`;
}

function normalizeOptionText(text: string) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[A-ZＡ-Ｄ][.\s:：、．。)]*/i, '')
    .replace(/[，。,.、；;：:\s"'“”‘’【】\[\]（）()]/g, '')
    .trim()
    .toLowerCase();
}

function extractChoiceLabels(answer: string) {
  const labels = Array.from(String(answer || '').matchAll(/(?:答案|选项|选择|^|[^A-Z])([A-D])(?:[^A-Z]|$)/gi))
    .map((match) => match[1].toUpperCase());
  return Array.from(new Set(labels));
}

function textMatches(answer: string, option: string) {
  const answerText = normalizeOptionText(answer);
  const optionText = normalizeOptionText(option);
  if (!answerText || !optionText) return false;
  if (answerText.includes(optionText) || optionText.includes(answerText)) return true;
  if (/正确|對|对|true|yes|是/.test(answerText) && /正确|對|对|true|yes|是/.test(optionText)) return true;
  if (/错误|錯|错|false|no|否/.test(answerText) && /错误|錯|错|false|no|否/.test(optionText)) return true;
  return false;
}

function normalizeAnswer(question: QuestionItem, rawAnswer: string, rawLabels?: unknown, rawMatched?: unknown) {
  const answer = String(rawAnswer || '未识别到答案');
  const labels = Array.isArray(rawLabels)
    ? rawLabels.map((item) => String(item).trim().toUpperCase()).filter(Boolean)
    : extractChoiceLabels(answer);

  const byLabel = question.options.filter((option, index) => {
    const fallbackLabel = String.fromCharCode(65 + index);
    const optionLabel = option.match(/^\s*([A-Z])\s*[.\s:：、．。)]/i)?.[1]?.toUpperCase() || fallbackLabel;
    return labels.includes(optionLabel);
  });
  const byText = question.options.filter((option) => textMatches(answer, option));

  const providedMatched = Array.isArray(rawMatched) ? rawMatched.map((item) => String(item)).filter(Boolean) : [];
  const matchedOptions = Array.from(new Set([...providedMatched, ...byLabel, ...byText]));
  return { choiceLabels: labels, matchedOptions };
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
  const { status, statusText, settings, questions, currentQuestion, currentQuestionIndex, currentAnswer, answerMap, questionBank } = useAppStore();
  const [batchRunning, setBatchRunning] = useState(false);
  const [liveRunning, setLiveRunning] = useState(false);
  const [livePaused, setLivePaused] = useState(false);
  const livePausedRef = useRef(false);
  const activeProvider = settings.providers.find((provider) => provider.id === settings.activeProviderId) || settings.providers[0];

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

    if (!activeProvider.apiKey) {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      const answer = demoAnswer(question);
      appStore.upsertQuestionBank(question, answer);
      return answer;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 30000);
    const response = await fetch(`${activeProvider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${activeProvider.apiKey}`
      },
      body: JSON.stringify({
        model: activeProvider.model,
        messages: [
          { role: 'system', content: '你是严谨的学习辅助解析助手，只输出 JSON。' },
          { role: 'user', content: buildPrompt(question) }
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    });
    window.clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`接口返回 ${response.status}：${await response.text()}`);

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(String(content).replace(/```json|```/g, '').trim());
    const answer = parsed.answer || '未识别到答案';
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
      analysis: parsed.analysis || '模型未返回详细解析。',
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
        if (!/429|Too many requests|limitation/i.test(message) || attempt === 3) break;
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
        if (answerMap[question.hash]) continue;
        appStore.setCurrentQuestionIndex(index);
        appStore.setStatus('calling_ai', `正在解析第 ${question.index || index + 1} / ${questions.length} 题，优先查询题库。`);
        const answer = await requestAIWithRetry(question);
        appStore.setCurrentAnswer(answer);
      }
      appStore.setStatus('done', `已完成 ${questions.length} 道题的解析。`);
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
    livePausedRef.current = !livePausedRef.current;
    setLivePaused(livePausedRef.current);
    appStore.setStatus(livePausedRef.current ? 'idle' : 'calling_ai', livePausedRef.current ? '已暂停边搜边填。' : '已继续边搜边填。');
  };

  const runSequentialExamAutomation = async () => {
    let resolvedCount = 0;
    let appliedCount = 0;
    const seen = new Set<string>();

    for (let step = 0; step < 160; step += 1) {
      await waitWhileLivePaused();
      appStore.setStatus('extracting_question', `正在抓取当前考试题目（第 ${step + 1} 轮）。`);
      const extractResult = await extractCurrentPageQuestionAsync();
      if (!extractResult?.success) throw new Error(extractResult?.error || '当前题目抓取失败。');
      const current = (Array.isArray(extractResult.questions) && extractResult.questions[0]) || extractResult.data;
      if (current) appStore.setCurrentQuestion(current);
      if (!current) throw new Error('当前页面未返回题目。');
      if (!isSequentialExamQuestion(current)) {
        appStore.setStatus('done', `已离开逐题答题页，自动化停止。已解析 ${resolvedCount} 题，填入 ${appliedCount} 题。`);
        return;
      }

      const signature = `${current.index || ''}:${current.hash}`;
      if (seen.has(signature)) {
        appStore.setStatus('done', `检测到题目未继续变化，自动化停止。已解析 ${resolvedCount} 题，填入 ${appliedCount} 题。`);
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
          appStore.setStatus('done', `已进入全卷浏览。已解析 ${resolvedCount} 题，填入 ${appliedCount} 题。`);
          return;
        }
        throw new Error(nextResult?.error || '进入下一题失败。');
      }
      if (nextResult.done) {
        appStore.setStatus('done', `已进入全卷浏览。已解析 ${resolvedCount} 题，填入 ${appliedCount} 题。`);
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    }

    appStore.setStatus('done', `逐题自动化已达到安全上限。已解析 ${resolvedCount} 题，填入 ${appliedCount} 题。`);
  };

  const callAllAIAndApplyLive = async () => {
    if (questions.length === 0) {
      appStore.setStatus('error', '请先抓取页面题目。');
      return;
    }
    if (liveRunning) return;

    setLiveRunning(true);
    setLivePaused(false);
    livePausedRef.current = false;

    const pendingQuestions = questions.filter((question) => !answerMap[question.hash]);
    const preAnsweredItems = questions
      .filter((question) => answerMap[question.hash])
      .map((question) => ({ question, answer: answerMap[question.hash] }));
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
        livePausedRef.current = false;
      }
      return;
    }

    try {
      appStore.setStatus('calling_ai', `开始并发查询 ${questions.length} 道题，答案返回后自动填入。`);
      preAnsweredItems.forEach((item) => enqueueApply(item.question, item.answer));

      const workerCount = Math.min(1, Math.max(1, pendingQuestions.length));
      const workers = Array.from({ length: workerCount }, async () => {
        while (nextIndex < pendingQuestions.length) {
          await waitWhileLivePaused();
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
            appStore.addLog('error', `第 ${question.index || '?'} 题查询失败：${error.name === 'AbortError' ? '请求超时' : error.message}`);
          }
        }
      });

      await Promise.all(workers);
      await Promise.allSettled(applyPromises);
      appStore.setStatus('done', `边搜边填完成：已解析 ${resolvedCount}/${questions.length} 题，已填入 ${appliedCount} 题。`);
    } catch (error: any) {
      appStore.setStatus('error', `边搜边填失败：${error.message}`);
    } finally {
      setLiveRunning(false);
      setLivePaused(false);
      livePausedRef.current = false;
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
    applyAnswersToPage(items);
  };

  const canParse = questions.length > 0 && !batchRunning && !liveRunning && status !== 'calling_ai';
  const parsedAnswerCount = questions.filter((question) => answerMap[question.hash]).length;
  const canFill = parsedAnswerCount > 0 && !liveRunning && status !== 'executing';

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflowY: 'auto' }}>
      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
          <div>
            <h4 style={{ fontSize: '0.95rem', color: '#fff', marginBottom: 6 }}>答题流程</h4>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.76rem', lineHeight: 1.55 }}>
              先获取当前页面题目，再解析答案，最后填入页面。自动化填入会边查题边填入，适合多题页面。
            </p>
          </div>
          <span className="badge badge-primary" style={{ whiteSpace: 'nowrap' }}>{questions.length} 题</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <button
            onClick={() => runAutomationAction('extract-question')}
            style={{ background: 'rgba(16,185,129,0.16)', color: '#fff', padding: '11px 10px', borderRadius: 8, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center', fontWeight: 900 }}
          >
            <FileQuestion size={15} /> 获取页面题目
          </button>
          <button
            onClick={callAllAI}
            disabled={!canParse}
            style={{ background: 'rgba(99,102,241,0.18)', color: '#fff', padding: '11px 10px', borderRadius: 8, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center', fontWeight: 900, opacity: canParse ? 1 : 0.55 }}
          >
            <Search size={15} /> 开始解析
          </button>
          <button
            onClick={applyAllAnswers}
            disabled={!canFill}
            style={{ background: 'rgba(245,158,11,0.15)', color: '#fff', padding: '11px 10px', borderRadius: 8, display: 'flex', justifyContent: 'center', gap: 7, alignItems: 'center', fontWeight: 900, opacity: canFill ? 1 : 0.55 }}
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
            style={{ background: livePaused ? 'rgba(16,185,129,0.16)' : 'rgba(245,158,11,0.16)', color: '#fff', padding: '10px 12px', borderRadius: 8, fontWeight: 800, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6 }}
          >
            {livePaused ? <Play size={15} /> : <Pause size={15} />} {livePaused ? '继续自动化填入' : '暂停自动化填入'}
          </button>
        )}

        <div className="glass-panel" style={{ padding: 12, borderRadius: 8, color: 'var(--text-secondary)', fontSize: '0.72rem', lineHeight: 1.5 }}>
          <MousePointer2 size={14} style={{ color: 'var(--primary-color)', marginBottom: 6 }} />
          已解析 {parsedAnswerCount}/{questions.length} 题。多题页面会按题号、题型和选项边界拆分；真实页面抓题和填入需要在设置中启用真实 WebView。
        </div>
      </div>

      <div className="glass-panel" style={{ padding: 18, borderRadius: 8, borderLeft: '4px solid var(--primary-color)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <BrainCircuit size={18} style={{ color: 'var(--primary-color)' }} />
          <h4 style={{ color: '#fff', fontSize: '0.95rem' }}>题目抓取与答案解析</h4>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', lineHeight: 1.6 }}>
          抓题会过滤脚本和样式噪声。解析时优先查询本地题库，未命中才调用 AI，AI 结果会自动入库。
        </p>
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h5 style={{ color: '#fff', fontSize: '0.86rem' }}>当前状态</h5>
          <span className="badge badge-primary">{statusLabels[status] || status}</span>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.5 }}>{statusText}</p>
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h5 style={{ color: '#fff', fontSize: '0.86rem' }}>题库与 AI</h5>
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
          <h5 style={{ color: '#fff', fontSize: '0.86rem' }}>题目列表</h5>
          <span className="badge badge-primary">{questions.length} 题</span>
        </div>
        {questions.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '28px 0', fontSize: '0.8rem' }}>
            <FileQuestion size={28} style={{ marginBottom: 8 }} />
            <div>还没有抓取题目。</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 260, overflowY: 'auto' }}>
            {questions.map((question, index) => {
              const active = index === currentQuestionIndex;
              const answered = Boolean(answerMap[question.hash]);
              const bankHit = appStore.hasQuestionBankAnswer(question);
              return (
                <button
                  key={question.hash}
                  onClick={() => appStore.setCurrentQuestionIndex(index)}
                  style={{
                    textAlign: 'left',
                    background: active ? 'rgba(99,102,241,0.16)' : 'rgba(255,255,255,0.03)',
                    border: active ? '1px solid var(--primary-color)' : '1px solid var(--border-glass)',
                    color: '#fff',
                    padding: 10,
                    borderRadius: 8
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 5 }}>
                    <span style={{ fontSize: '0.72rem', color: 'var(--primary-color)', fontWeight: 800 }}>第 {question.index || index + 1} 题 · {typeLabels[question.type] || question.type}</span>
                    <span style={{ color: answered ? 'var(--success-color)' : bankHit ? 'var(--warning-color)' : 'var(--text-muted)', fontSize: '0.7rem' }}>{answered ? '已解析' : bankHit ? '题库' : '未解析'}</span>
                  </div>
                  <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', lineHeight: 1.35 }}>
                    {question.question.slice(0, 64)}{question.question.length > 64 ? '...' : ''}
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
            <h5 style={{ color: '#fff', fontSize: '0.86rem' }}>当前题目</h5>
            <span className="badge badge-primary">{typeLabels[currentQuestion.type] || currentQuestion.type}</span>
          </div>
          <p style={{ color: '#fff', fontSize: '0.88rem', lineHeight: 1.55, fontWeight: 700 }}>{currentQuestion.question}</p>
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
              style={{ background: 'rgba(16,185,129,0.16)', color: '#fff', padding: 10, borderRadius: 8, fontWeight: 800, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6 }}
            >
              <ListChecks size={15} /> 批量查询/解析
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: liveRunning ? '1fr auto' : '1fr', gap: 8, marginTop: 8 }}>
            <button
              onClick={callAllAIAndApplyLive}
              disabled={liveRunning || batchRunning || status === 'calling_ai'}
              style={{ background: 'rgba(99,102,241,0.2)', color: '#fff', padding: 10, borderRadius: 8, fontWeight: 800, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6, opacity: liveRunning || batchRunning || status === 'calling_ai' ? 0.55 : 1 }}
            >
              <Play size={15} /> 并发查询并自动填入
            </button>
            {liveRunning && (
              <button
                onClick={toggleLivePause}
                style={{ background: livePaused ? 'rgba(16,185,129,0.16)' : 'rgba(245,158,11,0.16)', color: '#fff', padding: '10px 12px', borderRadius: 8, fontWeight: 800, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6 }}
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
            <h5 style={{ color: '#fff', fontSize: '0.86rem' }}>参考答案</h5>
            <span style={{ color: 'var(--success-color)', fontWeight: 800, fontSize: '0.8rem' }}>{(currentAnswer.confidence * 100).toFixed(0)}%</span>
          </div>
          <div style={{ color: '#34d399', fontSize: '1rem', fontWeight: 900, padding: 12, border: '1px solid rgba(16,185,129,0.18)', borderRadius: 8, marginBottom: 12 }}>
            {currentAnswer.answer}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            <button
              onClick={applyCurrentAnswer}
              style={{ background: 'rgba(16,185,129,0.16)', color: '#fff', padding: 10, borderRadius: 8, fontWeight: 800, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6 }}
            >
              <MousePointerClick size={15} /> 填入当前题
            </button>
            <button
              onClick={applyAllAnswers}
              style={{ background: 'rgba(99,102,241,0.16)', color: '#fff', padding: 10, borderRadius: 8, fontWeight: 800, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6 }}
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
