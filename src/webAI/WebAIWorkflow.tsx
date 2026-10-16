import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { ClipboardPaste, Copy, ExternalLink, Globe, ListChecks, Pause, Play, RotateCcw, Send, Square, X, Zap } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { parseWebAnswer, validateWebPrompt, WEB_AI_PROMPT_LIMIT, WEB_AI_PROVIDERS } from './protocol';
import type { WebProvider } from './protocol';
import { webAIController } from './WebAIController';
import './web-ai.css';

const OPEN_REQUEST_KEY = 'studypilot-web-ai-open-request-v1';
export type WebAIWorkflowProps = { embedded?: boolean };

export function openWebAI(importOnly = false) {
  try {
    // Keep the request until the answer tab mounts. This matters when the
    // action originates from the question-bank tab, where AIPanel is not
    // mounted yet.
    localStorage.setItem(OPEN_REQUEST_KEY, JSON.stringify({ importOnly, createdAt: Date.now() }));
  } catch { /* The in-memory event below is still enough when the tab is open. */ }
  window.dispatchEvent(new CustomEvent('studypilot:open-web-ai', { detail: { importOnly } }));
}

function takeOpenRequest() {
  try {
    const value = JSON.parse(localStorage.getItem(OPEN_REQUEST_KEY) || 'null');
    if (value && typeof value.createdAt === 'number' && Date.now() - value.createdAt < 10 * 60 * 1000) {
      localStorage.removeItem(OPEN_REQUEST_KEY);
      return { importOnly: Boolean(value.importOnly) };
    }
    localStorage.removeItem(OPEN_REQUEST_KEY);
  } catch { /* Ignore an unavailable persisted request. */ }
  return null;
}

export function WebAIWorkflow({ embedded = false }: WebAIWorkflowProps) {
  const { questions, settings } = useAppStore();
  const state = useSyncExternalStore(webAIController.subscribe, webAIController.getSnapshot);
  const { provider, mode, flow, selected, batch, prompt, reply, message, busy, imported, position, remaining, skipped, completedItems, aiTab, attemptedRequest, visible, source, paused } = state;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const selectedProvider = WEB_AI_PROVIDERS.find(item => item.id === provider)!;
  const batchProvider = WEB_AI_PROVIDERS.find(item => item.id === batch?.provider) || selectedProvider;
  const preview = useMemo(() => batch && reply.trim() ? parseWebAnswer(reply, batch, `${batchProvider.name} 网页`) : null, [reply, batch, batchProvider.name]);
  const matchesProvider = Boolean(batch && (!batch.provider || batch.provider === provider));
  const canUseTab = mode === 'internal' && matchesProvider && aiTab?.provider === provider;
  const promptError = useMemo(() => {
    if (!batch) return '';
    try { validateWebPrompt(prompt, batch); return ''; } catch (error) { return (error as Error).message; }
  }, [prompt, batch]);
  const canSend = !busy && canUseTab && !promptError && attemptedRequest !== batch?.requestId;
  const setVisible = (value: boolean) => webAIController.edit({ visible: value });
  const setProvider = (value: WebProvider) => webAIController.edit({ provider: value });
  const setMode = (value: 'internal' | 'external') => webAIController.edit({ mode: value });
  const setSelected = (value: string[] | ((previous: string[]) => string[])) => webAIController.edit({ selected: typeof value === 'function' ? value(webAIController.getSnapshot().selected) : value });
  const setPrompt = (value: string) => webAIController.edit({ prompt: value });
  const setReply = (value: string) => webAIController.edit({ reply: value });
  const { generate, extractQuestions, openWebsite, send, read, importPreview, approveFill, stop, copy } = webAIController;

  useEffect(() => {
    if (embedded || !dialogRef.current) return;
    if (visible && !dialogRef.current.open) dialogRef.current.showModal();
    else if (!visible && dialogRef.current.open) dialogRef.current.close();
  }, [embedded, visible]);
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      const current = webAIController.getSnapshot();
      webAIController.edit({ visible: true, ...(!current.busy ? { flow: 'manual' as const, ...(!detail.importOnly ? { selected: questions.map(q => q.hash) } : {}) } : {}) });
    };
    window.addEventListener('studypilot:open-web-ai', open);
    const pending = takeOpenRequest();
    if (pending) open(new CustomEvent('studypilot:open-web-ai', { detail: pending }));
    return () => window.removeEventListener('studypilot:open-web-ai', open);
  }, [questions]);
  useEffect(() => {
    if (!batch && !busy && !state.canRetry) webAIController.edit({ selected: questions.map(question => question.hash) });
  }, [batch, busy, questions, state.canRetry]);

  // 计算步骤状态
  const hasQuestions = questions.length > 0;
  const hasSelected = selected.length > 0;
  const hasBatch = Boolean(batch);
  const hasAITab = Boolean(aiTab);
  const hasReply = Boolean(reply.trim());
  const hasPreview = Boolean(preview?.items.length);

  const workflowBody = (
      <div className="web-ai-body">
        <div className="web-ai-flow-switch" role="tablist" aria-label="Web 答题方式">
          <button role="tab" aria-selected={flow === 'automatic'} className={flow === 'automatic' ? 'is-active' : ''} disabled={busy} onClick={() => webAIController.edit({ flow: 'automatic' })}><Zap size={15} />自动答题</button>
          <button role="tab" aria-selected={flow === 'manual'} className={flow === 'manual' ? 'is-active' : ''} disabled={busy} onClick={() => webAIController.edit({ flow: 'manual' })}><ListChecks size={15} />手动步骤</button>
        </div>
        {/* AI 网站选择区 */}
        <fieldset disabled={busy}>
          <legend>AI 网站选择</legend>
          <div className="web-ai-segments">{WEB_AI_PROVIDERS.map(item => <label key={item.id}><input type="radio" name="web-provider" checked={provider === item.id} onChange={() => setProvider(item.id)} />{item.name}</label>)}</div>
          <div className="web-ai-segments">{(['internal', 'external'] as const).map(value => <label key={value}><input type="radio" name="web-mode" checked={mode === value} onChange={() => setMode(value)} />{value === 'internal' ? '应用内浏览器' : '系统默认浏览器'}</label>)}</div>
          {flow === 'manual' && <details><summary>选择题目（{selected.length}/{questions.length}） · 不限题数</summary><p className="web-ai-message">每批完整提示词 ≤ 300000 字符，按原题顺序整题分批。</p><div className="web-ai-question-picker">{questions.map((question, index) => <label key={`${question.hash}-${index}`}><input type="checkbox" checked={selected.includes(question.hash)} onChange={event => setSelected(prev => event.target.checked ? [...prev, question.hash] : prev.filter(hash => hash !== question.hash))} /><span>{question.index || index + 1}. {question.question}</span></label>)}</div></details>}
        </fieldset>

        {flow === 'automatic' && <div className="web-ai-auto-controls">
          <div className="web-ai-auto-status"><span className={busy && !paused ? 'is-running' : ''} /><strong>{busy ? paused ? '已暂停' : '自动答题进行中' : state.canRetry ? '等待重试' : state.phase === 'completed' ? '已全部填回' : '当前页面 · 全部题目'}</strong><small>不提交</small></div>
          <div className="web-ai-actions">
            {!busy && <button className="web-ai-primary" disabled={mode !== 'internal' || !settings.allowRealPageAutomation} onClick={() => void webAIController.startAutomatic()}><Play size={16} />开始自动答题</button>}
            {!busy && state.canRetry && <button className="web-ai-secondary" onClick={() => void webAIController.retry()}><RotateCcw size={15} />重试失败步骤</button>}
            {busy && <button className="web-ai-secondary" onClick={webAIController.togglePause}>{paused ? <Play size={15} /> : <Pause size={15} />}{paused ? '继续' : '暂停'}</button>}
            {busy && <button className="web-ai-danger" onClick={stop}><Square size={15} />停止</button>}
          </div>
          <p className="web-ai-message">答案自动录入题库；缺失或无效答案自动补发，收齐后统一填回原页面。</p>
          {mode === 'external' && <p className="web-ai-message">自动答题需要切换到应用内浏览器。</p>}
          {!settings.allowRealPageAutomation && <p className="web-ai-message">请先在设置中启用真实 WebView。</p>}
        </div>}

        {/* 步骤式操作流程 */}
        {flow === 'manual' && <div className="web-ai-steps">
          {/* 步骤 1：开始抓题 */}
          <div className={`web-ai-step ${hasQuestions ? 'web-ai-step-done' : 'web-ai-step-active'}`}>
            <div className="web-ai-step-header">
              <span className="web-ai-step-num">①</span>
              <span className="web-ai-step-title">开始抓题</span>
              <span className="web-ai-step-status">{hasQuestions ? `已抓取 ${questions.length} 题` : '请先前往题目页抓题'}</span>
            </div>
            <div className="web-ai-step-body">
              <button className="web-ai-secondary" disabled={busy || !settings.allowRealPageAutomation} onClick={() => void extractQuestions()}>
                <ClipboardPaste size={15} />
                获取页面题目
              </button>
              <button
                className="web-ai-primary"
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
                className="web-ai-secondary"
                disabled={busy || !matchesProvider}
                onClick={() => void openWebsite()}
              >
                <ExternalLink size={15} />
                {hasAITab ? `重新打开 ${selectedProvider.name}` : `打开 ${selectedProvider.name}`}
              </button>
            </div>
          </div>

          {/* 步骤 3：填入提示词 */}
          <div className={`web-ai-step ${attemptedRequest === batch?.requestId ? 'web-ai-step-done' : canSend ? 'web-ai-step-active' : 'web-ai-step-disabled'}`}>
            <div className="web-ai-step-header">
              <span className="web-ai-step-num">③</span>
              <span className="web-ai-step-title">填入提示词</span>
              <span className="web-ai-step-status">
                {attemptedRequest === batch?.requestId ? state.canRetry ? '等待重试或检查回答' : '已尝试发送' : hasAITab ? '可以发送提示词' : '请先打开网页 AI'}
              </span>
            </div>
            <div className="web-ai-step-body">
              {mode === 'internal' ? (
                <button
                  className="web-ai-primary"
                  disabled={!canSend}
                  onClick={() => void send()}
                >
                  <Send size={15} />
                  {attemptedRequest === batch?.requestId ? '重新发送提示词' : '发送提示词到 AI'}
                </button>
              ) : (
                <button className="web-ai-secondary" disabled={busy || !hasBatch || Boolean(promptError)} onClick={() => void copy()}>
                  <Copy size={15} />复制提示词（手动粘贴）
                </button>
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
                  className="web-ai-secondary"
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
              <button className="web-ai-primary" disabled={busy || imported || !hasPreview} onClick={importPreview}>
                <ClipboardPaste size={15} />{imported ? '✓ 已入库' : `确认入库 ${preview?.items.length || 0} 题`}
              </button>
              {remaining.length > 0 && (
                <button className="web-ai-secondary" disabled={busy || !imported || preview?.items.length !== batch?.questions.length} onClick={() => generate(true)}>
                  <Play size={15} />生成下一批（剩余 {remaining.length} 题）
                </button>
              )}
            </div>
          </div>

          {/* 步骤 6：开始填入 */}
          {mode === 'internal' && (
            <div className={`web-ai-step ${source && completedItems.length > 0 && (imported || !batch) ? 'web-ai-step-active' : 'web-ai-step-disabled'}`}>
              <div className="web-ai-step-header">
                <span className="web-ai-step-num">⑥</span>
                <span className="web-ai-step-title">开始填入</span>
                <span className="web-ai-step-status">{completedItems.length > 0 ? `${completedItems.length} 题等待填入原页面` : '录入题库后可填入'}</span>
              </div>
              <div className="web-ai-step-body">
                <button className="web-ai-primary" disabled={busy || !source || completedItems.length === 0} onClick={() => void approveFill()}>
                  <Play size={15} />确认填入 {completedItems.length} 题到原页面
                </button>
              </div>
            </div>
          )}
        </div>}

        {/* 停止按钮 */}
        {busy && flow === 'manual' && <div className="web-ai-actions"><button className="web-ai-danger" onClick={stop}><Square size={15} />停止当前操作</button></div>}
        {!busy && flow === 'manual' && state.canRetry && <div className="web-ai-actions"><button className="web-ai-secondary" onClick={() => void webAIController.retry()}><RotateCcw size={15} />重试失败步骤</button></div>}

        {state.phase === 'needs_review' && <div className="web-ai-actions"><button className="web-ai-secondary" onClick={() => webAIController.edit({ flow: 'manual' })}><ListChecks size={15} />核对并手动处理</button></div>}

        {message && <p className="web-ai-message" role="status">{message}</p>}
        {skipped.length > 0 && <details className="web-ai-skipped">
          <summary>已跳过 {skipped.length} 题 · 原题保留</summary>
          <p>以下题目连同必要模板单独发送仍超过 300000 字符，已从本次提示词跳过。</p>
          <ul>{skipped.map(item => <li key={`${item.questionHash}-${item.questionIndex}`}>第 {item.questionIndex} 题：单题提示词 {item.promptLength.toLocaleString()} 字符，超过单批上限。</li>)}</ul>
        </details>}

        {/* 提示词与回答区 */}
        {batch && <>
          <div className="web-ai-section-heading"><h3>第 {position} 批 · 本批 {batch.questions.length} 题 · 待处理 {remaining.length} 题 · 跳过 {skipped.length} 题</h3><button className="web-ai-ghost" onClick={copy} title="复制提示词" aria-label="复制提示词" disabled={busy || !prompt || Boolean(promptError)}><Copy size={16} /></button></div>
          <textarea aria-label="题目提示词" value={prompt} readOnly={busy || attemptedRequest === batch.requestId} onChange={event => setPrompt(event.target.value)} rows={8} />
          <small className="web-ai-message">{prompt.length.toLocaleString()} / {WEB_AI_PROMPT_LIMIT.toLocaleString()} 字符</small>
          {promptError && <p className="web-ai-error" role="alert">{promptError}</p>}
          <a href={selectedProvider.url} target="_blank" rel="noreferrer">{selectedProvider.name}<ExternalLink size={12} /></a>
          <h3>AI 回答</h3>
          <textarea aria-label="粘贴 AI 回答" placeholder="粘贴完整 AI 回答" rows={8} value={reply} disabled={busy} onChange={event => setReply(event.target.value)} />
          {preview && <section className="web-ai-preview" aria-label="答案导入预览">
            {preview.errors.map((error, index) => <p className="web-ai-error" key={index}>{error}</p>)}
            {preview.items.map((item, index) => <article key={`${item.question.hash}-${index}`}><strong>{item.question.question}</strong><p>{item.answer.choiceLabels.join('、')} {item.question.type === 'judgement' ? item.answer.answer === 'true' ? '正确' : '错误' : item.answer.answer}</p>{item.answer.analysis && <p>{item.answer.analysis}</p>}<small>置信度 {Math.round(item.answer.confidence * 100)}%{item.answer.warnings.length ? ` · ${item.answer.warnings.join('；')}` : ''}</small></article>)}
          </section>}
        </>}
      </div>
  );

  if (embedded) {
    return (
      <section className="web-ai-inline" aria-labelledby="web-ai-title">
        <header className="web-ai-inline__header">
          <div>
            <span className="web-ai-inline__eyebrow">REAL WEB WORKFLOW</span>
            <h2 id="web-ai-title"><Globe size={19} />网页 AI 答题</h2>
          </div>
          <span className="web-ai-inline__live"><span />真实 WebView</span>
        </header>
        {workflowBody}
      </section>
    );
  }

  return <>
    {!visible && (busy || canUseTab) && <div className="web-ai-task" role="status">
      <Globe size={16} /><span>{message}</span>
      <div className="web-ai-task-actions">
        {!busy && state.canRetry && <button className="web-ai-secondary" onClick={() => void webAIController.retry()}><RotateCcw size={15} />重试失败步骤</button>}
        <button className="web-ai-primary" onClick={() => void send()} disabled={!canSend}><Send size={15} />发送提示词</button>
        <button className="web-ai-secondary" onClick={() => void read()} disabled={busy || !canUseTab}><ClipboardPaste size={15} />提取答案</button>
        <button className="web-ai-ghost" onClick={() => setVisible(true)}>查看</button>
        {busy && <button className="web-ai-danger" onClick={stop} title="停止网页 AI" aria-label="停止网页 AI"><Square size={15} /></button>}
      </div>
    </div>}
    <dialog ref={dialogRef} className="web-ai-dialog" onCancel={() => setVisible(false)} onClose={() => setVisible(false)} aria-labelledby="web-ai-title">
      <header><h2 id="web-ai-title"><Globe size={20} />网页 AI</h2><button className="web-ai-ghost" onClick={() => setVisible(false)} title="关闭弹窗" aria-label="关闭弹窗"><X size={18} /></button></header>
      {workflowBody}
    </dialog>
  </>;
}
