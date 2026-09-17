import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardPaste, Copy, ExternalLink, Globe, Play, Send, Square, X } from 'lucide-react';
import { appStore, useAppStore } from '../store/appStore';
import type { QuestionItem } from '../store/appStore';
import { browserCommand } from './browserBridge';
import type { BrowserSource, WebPageState } from './browserBridge';
import { buildWebPrompt, hasCompleteWebResponse, parseWebAnswer, prepareWebBatch, sameQuestions, validateWebPrompt, WEB_AI_BATCH_SIZE, WEB_AI_PROMPT_LIMIT, WEB_AI_PROVIDERS } from './protocol';
import type { AnswerItem, WebBatch, WebProvider } from './protocol';
import { sendWebPrompt } from './sendPrompt';
import './web-ai.css';

const PENDING_KEY = 'studypilot-web-ai-pending-v1';
export function openWebAI(importOnly = false) {
  window.dispatchEvent(new CustomEvent('studypilot:open-web-ai', { detail: { importOnly } }));
}
function restorePending(): WebBatch | null {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    if (typeof value?.requestId === 'string' && Array.isArray(value.questions) && value.questions.length && value.questions.every((q: any) => typeof q.hash === 'string' && typeof q.question === 'string' && Array.isArray(q.options))) return value;
  } catch { /* An unavailable draft must not block the workbench. */ }
  return null;
}
function requestPage(channel: string, detail: Record<string, unknown>, timeout = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('原题目页面响应超时。')), timeout);
    window.dispatchEvent(new CustomEvent(channel, { detail: { ...detail, onComplete: (result: any) => {
      window.clearTimeout(timer);
      if (result?.success) resolve(result); else reject(new Error(result?.error || '页面操作失败。'));
    } } }));
  });
}

export function WebAIWorkflow() {
  const { questions, settings } = useAppStore();
  const [visible, setVisible] = useState(false);
  const [provider, setProvider] = useState<WebProvider>(() => {
    try { const value = restorePending()?.provider || localStorage.getItem('studypilot-web-ai-provider'); return WEB_AI_PROVIDERS.find(p => p.id === value)?.id || 'deepseek'; } catch { return 'deepseek'; }
  });
  const [mode, setMode] = useState<'internal' | 'external'>('internal');
  const [selected, setSelected] = useState<string[]>([]);
  const [batch, setBatch] = useState<WebBatch | null>(restorePending);
  const [prompt, setPrompt] = useState(() => { const pending = restorePending(); return pending ? buildWebPrompt(pending) : ''; });
  const [reply, setReply] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState(false);
  const [position, setPosition] = useState({ current: 0, total: 0 });
  const [remaining, setRemaining] = useState<QuestionItem[]>([]);
  const [completedItems, setCompletedItems] = useState<AnswerItem[]>([]);
  const [aiTab, setAITab] = useState<{ id: string; provider: WebProvider } | null>(null);
  const [attemptedRequest, setAttemptedRequest] = useState('');
  const sourceRef = useRef<BrowserSource | null>(null);
  const runRef = useRef(0);
  const ownsTaskRef = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const selectedProvider = WEB_AI_PROVIDERS.find(item => item.id === provider)!;
  const batchProvider = WEB_AI_PROVIDERS.find(item => item.id === batch?.provider) || selectedProvider;
  const preview = useMemo(() => batch && reply.trim() ? parseWebAnswer(reply, batch, `${batchProvider.name} 网页`) : null, [reply, batch, batchProvider.name]);
  const matchesProvider = Boolean(batch && (!batch.provider || batch.provider === provider));
  const canUseTab = mode === 'internal' && matchesProvider && aiTab?.provider === provider;
  const canSend = !busy && canUseTab && attemptedRequest !== batch?.requestId;

  useEffect(() => {
    if (visible) dialogRef.current?.showModal(); else dialogRef.current?.close();
  }, [visible]);
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      setVisible(true);
      if (!detail.importOnly && !busy) setSelected(appStore.getState().questions.map(q => q.hash));
    };
    window.addEventListener('studypilot:open-web-ai', open);
    return () => window.removeEventListener('studypilot:open-web-ai', open);
  }, [busy]);
  useEffect(() => () => {
    runRef.current++;
    if (ownsTaskRef.current) appStore.setAutomationRunning({ batchRunning: false });
  }, []);

  const checkRun = (run: number) => { if (run !== runRef.current) throw new Error('操作已停止。'); };
  const beginAction = () => {
    const state = appStore.getState();
    if (busy || state.batchRunning || state.liveRunning || ['calling_ai', 'executing', 'learning'].includes(state.status)) {
      setMessage('请先等待当前任务结束。');
      return null;
    }
    const run = ++runRef.current;
    ownsTaskRef.current = true;
    appStore.setAutomationRunning({ batchRunning: true });
    setBusy(true);
    return run;
  };
  const finishAction = (run: number) => {
    if (run !== runRef.current) return;
    ownsTaskRef.current = false;
    appStore.setAutomationRunning({ batchRunning: false });
    setBusy(false);
  };
  const showError = (error: unknown, run: number) => {
    if (run !== runRef.current) return;
    setMessage((error as Error).message);
    appStore.setStatus('error', (error as Error).message);
  };

  const generate = (nextBatch = false) => {
    if (busy) return;
    try {
      const items = nextBatch ? remaining : questions.filter(q => selected.includes(q.hash));
      const next = prepareWebBatch(items, provider);
      if (!nextBatch) {
        setCompletedItems([]);
        if (!sourceRef.current || items.some(q => !q.pageUrl || q.pageUrl !== sourceRef.current?.url)) {
          sourceRef.current = null;
          setAITab(null);
        }
      }
      setBatch(next.batch); setPrompt(next.prompt); setRemaining(next.remaining);
      setReply(''); setImported(false); setAttemptedRequest('');
      setPosition(previous => nextBatch ? { ...previous, current: previous.current + 1 } : { current: 1, total: Math.ceil(items.length / WEB_AI_BATCH_SIZE) });
      try { localStorage.setItem(PENDING_KEY, JSON.stringify(next.batch)); localStorage.setItem('studypilot-web-ai-provider', provider); } catch { /* The current session can still continue. */ }
      setMessage(`已生成 ${next.batch.questions.length} 题提示词，共 ${next.prompt.length.toLocaleString()} 字符。`);
    } catch (error) { setMessage((error as Error).message); }
  };

  const openWebsite = async () => {
    if (!batch || !matchesProvider) { setMessage('请先为所选网站生成提示词。'); return; }
    const run = beginAction();
    if (run === null) return;
    try {
      if (mode === 'external') {
        const api = (window as any).electronAPI;
        if (!api?.openExternalUrl) { setMessage('请使用下方网站链接打开聊天页。'); return; }
        const result = await api.openExternalUrl(selectedProvider.url);
        checkRun(run);
        if (!result?.success) throw new Error(result?.error || '打开系统浏览器失败。');
        setMessage('网站已打开。');
      } else {
        if (!settings.allowRealPageAutomation) throw new Error('请先在设置中启用真实 WebView。');
        const source = await browserCommand<BrowserSource>({ action: 'source', tabId: sourceRef.current?.tabId });
        checkRun(run);
        if (batch.questions.some(q => q.pageUrl && q.pageUrl !== source.url)) throw new Error('请先切回抓题来源标签，再打开 AI 网站。');
        sourceRef.current = source;
        let opened: BrowserSource;
        try {
          if (!aiTab || aiTab.provider !== provider) throw new Error('new tab');
          opened = await browserCommand<BrowserSource>({ action: 'focus', tabId: aiTab.id });
        } catch {
          checkRun(run);
          opened = await browserCommand<BrowserSource>({ action: 'open', provider });
        }
        checkRun(run);
        setAITab({ id: opened.tabId, provider });
        setVisible(false);
        setMessage('网站已打开，登录后可发送提示词。');
      }
    } catch (error) { showError(error, run); }
    finally { finishAction(run); }
  };

  const send = async () => {
    if (!batch || !aiTab || !canSend) return;
    const run = beginAction();
    if (run === null) return;
    try {
      validateWebPrompt(prompt, batch);
      setVisible(false);
      await browserCommand({ action: 'focus', tabId: aiTab.id });
      checkRun(run);
      const before = await browserCommand<WebPageState>({ action: 'inspect', provider, tabId: aiTab.id });
      checkRun(run);
      if (hasCompleteWebResponse(before.text, batch.requestId)) {
        setAttemptedRequest(batch.requestId); setMessage('本批已有回答，可以提取答案。'); return;
      }
      if (!before.ready || before.busy) throw new Error(before.busy ? '网站仍在生成，请稍后发送。' : '请先登录并进入聊天页，再点击发送提示词。');
      setMessage('正在发送提示词…');
      appStore.setStatus('calling_ai', '网页 AI：发送提示词。');
      const baseline = await browserCommand<WebPageState>({ action: 'prepare', provider, tabId: aiTab.id, prompt, isCancelled: () => run !== runRef.current });
      await sendWebPrompt({
        inspect: () => browserCommand<WebPageState>({ action: 'inspect', provider, tabId: aiTab.id }),
        send: async () => {
          try {
            const result = await browserCommand<WebPageState>({ action: 'send', provider, tabId: aiTab.id, prompt, isCancelled: () => run !== runRef.current });
            if (run === runRef.current && result.attempted) setAttemptedRequest(batch.requestId);
            return result;
          } catch (error) { if (run === runRef.current) setAttemptedRequest(batch.requestId); throw error; }
        },
        wait: async () => { await new Promise(resolve => window.setTimeout(resolve, 500)); checkRun(run); },
        checkCancelled: () => checkRun(run), onManualSend: setMessage, baseline: baseline.text
      });
      checkRun(run);
      setAttemptedRequest(batch.requestId);
      setMessage('提示词已发送，回答完成后可提取答案。');
      appStore.setStatus('done', '网页 AI 提示词已发送。');
    } catch (error) { showError(error, run); }
    finally { finishAction(run); }
  };

  const read = async () => {
    if (!batch || !aiTab || !canUseTab) return;
    const run = beginAction();
    if (run === null) return;
    try {
      const state = await browserCommand<WebPageState>({ action: 'inspect', provider: aiTab.provider, tabId: aiTab.id });
      checkRun(run);
      if (state.busy) throw new Error('回答仍在生成，请等待完成后再提取答案。');
      if (!state.text.trim()) throw new Error('尚未找到回答，请等待生成完成或粘贴回答。');
      setReply(state.text);
      if (state.text !== reply) setImported(false);
      setVisible(true);
      setMessage('已提取答案，请核对预览后确认入库。');
    } catch (error) { showError(error, run); }
    finally { finishAction(run); }
  };

  const importPreview = () => {
    if (busy || !preview?.items.length) return;
    preview.items.forEach(item => { appStore.upsertQuestionBank(item.question, item.answer); appStore.setAnswerForQuestion(item.question, item.answer); });
    setCompletedItems(previous => [...previous.filter(item => !preview.items.some(next => next.question.hash === item.question.hash)), ...preview.items]);
    setImported(true); setMessage(`已导入 ${preview.items.length} 道有效答案。`);
  };
  const approveFill = async () => {
    const source = sourceRef.current;
    if (!source || !completedItems.length) return;
    const run = beginAction();
    if (run === null) return;
    setVisible(false);
    try {
      appStore.setStatus('executing', '网页 AI：正在核对原题目。');
      await browserCommand({ action: 'focus', tabId: source.tabId });
      checkRun(run);
      const result = await requestPage('studypilot:extract-question-request', { targetTabId: source.tabId, expectedUrl: source.url });
      checkRun(run);
      const actual = Array.isArray(result.questions) ? result.questions : result.data ? [result.data] : [];
      if (!sameQuestions(completedItems.map(item => item.question), actual)) throw new Error('原页面题目或选项已变化，已停止填入；答案保留在题库。');
      for (const item of completedItems) {
        checkRun(run);
        const question = actual.find((candidate: QuestionItem) => candidate.hash === item.question.hash);
        await requestPage('studypilot:apply-answers', { items: [{ ...item, question }], targetTabId: source.tabId, expectedUrl: source.url, isCancelled: () => run !== runRef.current });
      }
      checkRun(run);
      setMessage('已填入原题目页面。'); appStore.setStatus('done', '网页 AI 答案填入完成。');
    } catch (error) { showError(error, run); }
    finally { if (run === runRef.current) setVisible(true); finishAction(run); }
  };
  const stop = () => {
    runRef.current++;
    if (ownsTaskRef.current) { appStore.setStatus('idle', '网页 AI 操作已停止。'); appStore.setAutomationRunning({ batchRunning: false }); }
    ownsTaskRef.current = false; setBusy(false);
    setMessage('已停止当前操作，网站上已发送的请求可能仍在生成。');
  };
  const copy = async () => {
    try { if (batch) validateWebPrompt(prompt, batch); await navigator.clipboard.writeText(prompt); setMessage('提示词已复制。'); }
    catch (error) { setMessage(`复制失败：${(error as Error).message}`); }
  };

  // 计算步骤状态
  const hasQuestions = questions.length > 0;
  const hasSelected = selected.length > 0;
  const hasBatch = Boolean(batch);
  const hasAITab = Boolean(aiTab);
  const hasReply = Boolean(reply.trim());
  const hasPreview = Boolean(preview?.items.length);

  return <>
    {!visible && (busy || canUseTab) && <div className="web-ai-task" role="status">
      <Globe size={16} /><span>{message}</span>
      <div className="web-ai-task-actions">
        <button onClick={() => void send()} disabled={!canSend}><Send size={15} />发送提示词</button>
        <button onClick={() => void read()} disabled={busy || !canUseTab}><ClipboardPaste size={15} />提取答案</button>
        <button onClick={() => setVisible(true)}>查看</button>
        {busy && <button onClick={stop} title="停止网页 AI"><Square size={15} /></button>}
      </div>
    </div>}
    <dialog ref={dialogRef} className="web-ai-dialog" onCancel={() => setVisible(false)} onClose={() => setVisible(false)} aria-labelledby="web-ai-title">
      <header><h2 id="web-ai-title"><Globe size={20} />网页 AI</h2><button onClick={() => setVisible(false)} title="关闭弹窗"><X size={18} /></button></header>
      <div className="web-ai-body">
        {/* AI 网站选择区 */}
        <fieldset disabled={busy}>
          <legend>AI 网站选择</legend>
          <div className="web-ai-segments">{WEB_AI_PROVIDERS.map(item => <label key={item.id}><input type="radio" name="web-provider" checked={provider === item.id} onChange={() => setProvider(item.id)} />{item.name}</label>)}</div>
          <div className="web-ai-segments">{(['internal', 'external'] as const).map(value => <label key={value}><input type="radio" name="web-mode" checked={mode === value} onChange={() => setMode(value)} />{value === 'internal' ? '应用内浏览器' : '系统默认浏览器'}</label>)}</div>
          <details><summary>选择题目（{selected.length}/{questions.length}） · 每批最多 {WEB_AI_BATCH_SIZE} 题</summary><div className="web-ai-question-picker">{questions.map((question, index) => <label key={`${question.hash}-${index}`}><input type="checkbox" checked={selected.includes(question.hash)} onChange={event => setSelected(prev => event.target.checked ? [...prev, question.hash] : prev.filter(hash => hash !== question.hash))} /><span>{question.index || index + 1}. {question.question}</span></label>)}</div></details>
        </fieldset>

        {/* 步骤式操作流程 */}
        <div className="web-ai-steps">
          {/* 步骤 1：开始抓题 */}
          <div className={`web-ai-step ${hasQuestions ? 'web-ai-step-done' : 'web-ai-step-active'}`}>
            <div className="web-ai-step-header">
              <span className="web-ai-step-num">①</span>
              <span className="web-ai-step-title">开始抓题</span>
              <span className="web-ai-step-status">{hasQuestions ? `已抓取 ${questions.length} 题` : '请先前往题目页抓题'}</span>
            </div>
            <div className="web-ai-step-body">
              <button
                disabled={busy || !hasSelected}
                onClick={() => generate()}
              >
                <Play size={15} />
                {hasBatch ? '重新生成提示词' : `生成提示词（已选 ${selected.length} 题）`}
              </button>
            </div>
          </div>

          {/* 步骤 2：打开网页 AI */}
          <div className={`web-ai-step ${hasAITab ? 'web-ai-step-done' : hasBatch ? 'web-ai-step-active' : 'web-ai-step-disabled'}`}>
            <div className="web-ai-step-header">
              <span className="web-ai-step-num">②</span>
              <span className="web-ai-step-title">打开网页 AI（{selectedProvider.name}）</span>
              <span className="web-ai-step-status">{hasAITab ? `已打开 ${selectedProvider.name}` : '打开 AI 聊天页'}</span>
            </div>
            <div className="web-ai-step-body">
              <button
                disabled={busy || !matchesProvider}
                onClick={() => void openWebsite()}
              >
                <ExternalLink size={15} />
                {hasAITab ? `重新打开 ${selectedProvider.name}` : `打开 ${selectedProvider.name}`}
              </button>
              {!hasAITab && hasBatch && <small className="web-ai-step-hint">打开后若未登录，请先登录再返回此处</small>}
            </div>
          </div>

          {/* 步骤 3：填入提示词（等待登录后） */}
          <div className={`web-ai-step ${attemptedRequest === batch?.requestId ? 'web-ai-step-done' : canSend ? 'web-ai-step-active' : 'web-ai-step-disabled'}`}>
            <div className="web-ai-step-header">
              <span className="web-ai-step-num">③</span>
              <span className="web-ai-step-title">填入提示词</span>
              <span className="web-ai-step-status">
                {attemptedRequest === batch?.requestId ? '提示词已发送' : hasAITab ? '登录后点击发送' : '请先打开网页 AI'}
              </span>
            </div>
            <div className="web-ai-step-body">
              {mode === 'internal' ? (
                <button
                  className={canSend ? 'web-ai-primary' : ''}
                  disabled={!canSend}
                  onClick={() => void send()}
                >
                  <Send size={15} />
                  {attemptedRequest === batch?.requestId ? '重新发送提示词' : '发送提示词到 AI'}
                </button>
              ) : (
                <button disabled={busy || !hasBatch} onClick={() => void copy()}>
                  <Copy size={15} />复制提示词（手动粘贴）
                </button>
              )}
              {mode === 'internal' && hasAITab && !canSend && !attemptedRequest && (
                <small className="web-ai-step-hint">⚠️ 若 AI 页面未登录，请先登录后再点击发送</small>
              )}
            </div>
          </div>

          {/* 步骤 4：提取答案 */}
          <div className={`web-ai-step ${hasReply ? 'web-ai-step-done' : (canUseTab && attemptedRequest === batch?.requestId) ? 'web-ai-step-active' : 'web-ai-step-disabled'}`}>
            <div className="web-ai-step-header">
              <span className="web-ai-step-num">④</span>
              <span className="web-ai-step-title">提取答案</span>
              <span className="web-ai-step-status">{hasReply ? 'AI 回答已提取' : 'AI 生成完成后提取'}</span>
            </div>
            <div className="web-ai-step-body">
              {mode === 'internal' ? (
                <button
                  disabled={busy || !canUseTab}
                  onClick={() => void read()}
                >
                  <ClipboardPaste size={15} />{hasReply ? '重新提取答案' : '从 AI 页面提取答案'}
                </button>
              ) : (
                <small className="web-ai-step-hint">请将 AI 回答粘贴到下方文本框</small>
              )}
            </div>
          </div>

          {/* 步骤 5：录入题库 */}
          <div className={`web-ai-step ${imported ? 'web-ai-step-done' : hasPreview ? 'web-ai-step-active' : 'web-ai-step-disabled'}`}>
            <div className="web-ai-step-header">
              <span className="web-ai-step-num">⑤</span>
              <span className="web-ai-step-title">录入题库</span>
              <span className="web-ai-step-status">{imported ? `已入库 ${preview?.items.length ?? 0} 题` : hasPreview ? `解析到 ${preview!.items.length} 题，待入库` : '等待答案'}</span>
            </div>
            <div className="web-ai-step-body">
              <button disabled={busy || imported || !hasPreview} onClick={importPreview}>
                <ClipboardPaste size={15} />{imported ? '✓ 已入库' : `确认入库 ${preview?.items.length || 0} 题`}
              </button>
              {remaining.length > 0 && (
                <button disabled={busy || !imported || preview?.items.length !== batch?.questions.length} onClick={() => generate(true)}>
                  <Play size={15} />生成下一批（剩余 {remaining.length} 题）
                </button>
              )}
            </div>
          </div>

          {/* 步骤 6：开始填入 */}
          {mode === 'internal' && (
            <div className={`web-ai-step ${sourceRef.current && completedItems.length > 0 && imported ? 'web-ai-step-active' : 'web-ai-step-disabled'}`}>
              <div className="web-ai-step-header">
                <span className="web-ai-step-num">⑥</span>
                <span className="web-ai-step-title">开始填入</span>
                <span className="web-ai-step-status">{completedItems.length > 0 ? `${completedItems.length} 题等待填入原页面` : '录入题库后可填入'}</span>
              </div>
              <div className="web-ai-step-body">
                <button disabled={busy || !sourceRef.current || completedItems.length === 0} onClick={() => void approveFill()}>
                  <Play size={15} />确认填入 {completedItems.length} 题到原页面
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 停止按钮 */}
        {busy && <div className="web-ai-actions"><button onClick={stop}><Square size={15} />停止当前操作</button></div>}

        {message && <p className="web-ai-message" role="status">{message}</p>}

        {/* 提示词与回答区 */}
        {batch && <>
          <div className="web-ai-section-heading"><h3>提示词 · {batch.questions.length} 题{position.total > 0 ? ` · ${position.current}/${position.total} 批` : ''}</h3><button onClick={copy} title="复制提示词" disabled={busy || !prompt}><Copy size={16} /></button></div>
          <textarea aria-label="题目提示词" value={prompt} readOnly={busy || attemptedRequest === batch.requestId} onChange={event => setPrompt(event.target.value)} rows={8} />
          <small className="web-ai-message">{prompt.length.toLocaleString()} / {WEB_AI_PROMPT_LIMIT.toLocaleString()} 字符</small>
          <a href={selectedProvider.url} target="_blank" rel="noreferrer">{selectedProvider.name}<ExternalLink size={12} /></a>
          <h3>AI 回答</h3>
          <textarea aria-label="粘贴 AI 回答" placeholder="粘贴完整 AI 回答" rows={8} value={reply} disabled={busy} onChange={event => { setReply(event.target.value); setImported(false); }} />
          {preview && <section className="web-ai-preview" aria-label="答案导入预览">
            {preview.errors.map((error, index) => <p className="web-ai-error" key={index}>{error}</p>)}
            {preview.items.map((item, index) => <article key={`${item.question.hash}-${index}`}><strong>{item.question.question}</strong><p>{item.answer.choiceLabels.join('、')} {item.answer.answer}</p>{item.answer.analysis && <p>{item.answer.analysis}</p>}<small>置信度 {Math.round(item.answer.confidence * 100)}%{item.answer.warnings.length ? ` · ${item.answer.warnings.join('；')}` : ''}</small></article>)}
          </section>}
        </>}
      </div>
    </dialog>
  </>;
}
