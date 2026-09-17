import React, { useMemo, useRef, useState } from 'react';
import { Check, Copy, Database, Download, FileSearch, Plus, Search, Trash2, Upload } from 'lucide-react';
import { appStore, ManualQuestionBankInput, QuestionType, useAppStore } from '../store/appStore';
import { openWebAI } from '../webAI/WebAIWorkflow';
import { ClipboardPaste } from 'lucide-react';

function cleanLine(line: string) {
  return line.replace(/^\s*(题目|问题|选项|答案|正确答案|解析|分析)\s*[:：]\s*/i, '').trim();
}

function parseQuestionType(text: string, options: string[]): QuestionType {
  if (/判断题|判断/.test(text)) return 'judgement';
  if (/填空题|填空/.test(text)) return 'completion';
  if (/多选题|多选/.test(text)) return 'multiple';
  if (/问答题|简答题|论述题/.test(text)) return 'essay';
  return options.length > 0 ? 'single' : 'completion';
}

function isSeparatorLine(line: string) {
  return /^(---+|====+|###+)$/.test(line.trim());
}

function isSectionHeading(line: string) {
  return /^(一|二|三|四|五|六|七|八|九|十|[0-9]+)[、.．]\s*(单选题|多选题|判断题|填空题|问答题|简答题|论述题)/.test(line.trim());
}

function isAnswerLine(line: string) {
  return /^\s*(答案|正确答案)\s*[:：]/i.test(line);
}

function isAnalysisLine(line: string) {
  return /^\s*(解析|分析)\s*[:：]/i.test(line);
}

function isOptionLine(line: string) {
  return /^\s*[A-Z]\s*[.\s:：、。)]/.test(line) || /^\s*选项\s*[:：]/.test(line);
}

function isLikelyQuestionStart(line: string) {
  const text = line.trim();
  if (!text || isSectionHeading(text) || isAnswerLine(text) || isAnalysisLine(text) || isOptionLine(text)) return false;
  return true;
}

function splitManualBlocks(input: string) {
  const lines = input.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim());
  const blocks: string[] = [];
  let current: string[] = [];
  let hasAnswer = false;
  let hasAnalysis = false;

  const flush = () => {
    const block = current.join('\n').trim();
    if (block) blocks.push(block);
    current = [];
    hasAnswer = false;
    hasAnalysis = false;
  };

  for (const line of lines) {
    if (!line || isSeparatorLine(line)) {
      if (hasAnswer) flush();
      continue;
    }

    if (isSectionHeading(line)) {
      if (hasAnswer) flush();
      continue;
    }

    if (hasAnswer && isLikelyQuestionStart(line) && (!hasAnalysis || !isAnalysisLine(line))) {
      flush();
    }

    current.push(line);
    if (isAnswerLine(line)) hasAnswer = true;
    if (isAnalysisLine(line)) hasAnalysis = true;
  }

  flush();
  return blocks;
}

function parseManualText(input: string): ManualQuestionBankInput[] {
  const blocks = splitManualBlocks(input);

  return blocks.map((block) => {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const answerIndex = lines.findIndex(isAnswerLine);
    const analysisIndex = lines.findIndex(isAnalysisLine);
    const answerEndIndex = analysisIndex >= 0 ? analysisIndex : lines.length;
    const rawQuestionLines = answerIndex >= 0 ? lines.slice(0, answerIndex) : lines.slice(0, Math.max(1, lines.length - 1));
    const answer = answerIndex >= 0
      ? lines.slice(answerIndex, answerEndIndex).map(cleanLine).join('\n').trim()
      : cleanLine(lines[lines.length - 1] || '');
    const analysis = analysisIndex >= 0 ? lines.slice(analysisIndex).map(cleanLine).join('\n').trim() : '';

    const optionLines = rawQuestionLines.filter(isOptionLine);
    const questionLines = rawQuestionLines.filter((line) => !optionLines.includes(line));
    const question = questionLines.map(cleanLine).join('\n').trim();
    const options = optionLines.map(cleanLine).filter(Boolean);

    return {
      question,
      options,
      answer,
      analysis,
      type: parseQuestionType(`${question}\n${block}`, options)
    };
  }).filter((item) => item.question && item.answer);
}

export function KnowledgeBase() {
  const { snapshot, questionBank } = useAppStore();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [manualText, setManualText] = useState('题目：示例选择题题干\nA. 选项一\nB. 选项二\n答案：A\n解析：这里可以写解析\n题目：示例填空题题干\n答案：填空答案');
  const jellyPointerRef = useRef(new WeakMap<HTMLElement, { x: number; time: number; timer?: number }>());
  const [query, setQuery] = useState('');
  const [activeType, setActiveType] = useState<QuestionType | 'all'>('all');
  const [showManualEditor, setShowManualEditor] = useState(false);

  const exportQuestionBank = () => {
    const data = appStore.exportQuestionBank();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `studypilot-question-bank-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    appStore.addLog('success', `已导出 ${data.length} 条本地题库。`);
  };

  const importQuestionBankFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const entries = Array.isArray(parsed) ? parsed : parsed.entries;
      if (!Array.isArray(entries)) throw new Error('文件格式不正确，请导入题库 JSON 数组。');
      appStore.importQuestionBank(entries);
    } catch (error: any) {
      appStore.addLog('error', `导入题库失败：${error.message}`);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const addManualItems = () => {
    const items = parseManualText(manualText);
    if (items.length === 0) {
      appStore.addLog('error', '没有识别到可导入的题目。请检查格式。');
      return;
    }
    appStore.addManualQuestionBankItems(items);
  };

  const getEntryType = (entry: typeof questionBank[number]): QuestionType => {
    const text = `${entry.question}\n${entry.options.join('\n')}`;
    if (/判断题|正确|错误/.test(text) && entry.options.length <= 2) return 'judgement';
    if (/填空题|填空/.test(text) || entry.options.length === 0) return 'completion';
    if (/多选题|多选/.test(text) || entry.answer.choiceLabels.length > 1) return 'multiple';
    return 'single';
  };

  const typeLabels: Record<QuestionType, string> = {
    single: '单选题',
    multiple: '多选题',
    judgement: '判断题',
    completion: '填空题',
    essay: '问答题',
    unknown: '其他题型'
  };

  const typeCounts = useMemo(() => {
    const counts: Record<QuestionType, number> = { single: 0, multiple: 0, judgement: 0, completion: 0, essay: 0, unknown: 0 };
    questionBank.forEach((entry) => { counts[getEntryType(entry)] += 1; });
    return counts;
  }, [questionBank]);

  const filteredEntries = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return questionBank.filter((entry) => {
      const type = getEntryType(entry);
      if (activeType !== 'all' && type !== activeType) return false;
      if (!keyword) return true;
      return `${entry.question}\n${entry.options.join('\n')}\n${entry.answer.answer}\n${entry.answer.analysis}`.toLowerCase().includes(keyword);
    });
  }, [activeType, query, questionBank]);

  const copyQuestion = async (entry: typeof questionBank[number]) => {
    try {
      await navigator.clipboard.writeText([entry.question, ...entry.options, `答案：${entry.answer.answer}`, entry.answer.analysis ? `解析：${entry.answer.analysis}` : ''].filter(Boolean).join('\n'));
      appStore.addLog('success', '题目与答案已复制。');
    } catch {
      appStore.addLog('warn', '复制失败，请检查系统剪贴板权限。');
    }
  };

  const jellyMotion = {
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      const target = event.currentTarget;
      target.classList.remove('is-releasing');
      const previous = jellyPointerRef.current.get(target);
      if (previous?.timer) window.clearTimeout(previous.timer);
      jellyPointerRef.current.set(target, { x: event.clientX, time: event.timeStamp });
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const target = event.currentTarget;
      const rect = target.getBoundingClientRect();
      const x = (event.clientX - rect.left) / Math.max(1, rect.width);
      const y = (event.clientY - rect.top) / Math.max(1, rect.height);
      const previous = jellyPointerRef.current.get(target);
      const elapsed = Math.max(8, event.timeStamp - (previous?.time || event.timeStamp));
      const velocity = (event.clientX - (previous?.x || event.clientX)) / elapsed;
      const stretch = Math.min(0.022, Math.max(0, velocity) * 0.012);
      target.style.setProperty('--jelly-x', `${(x - 0.5) * 2.4}deg`);
      target.style.setProperty('--jelly-y', `${(0.5 - y) * 1.6}deg`);
      target.style.setProperty('--jelly-light-x', `${Math.round(x * 100)}%`);
      target.style.setProperty('--jelly-light-y', `${Math.round(y * 100)}%`);
      target.style.setProperty('--jelly-scale-x', String(1 + stretch));
      target.style.setProperty('--jelly-scale-y', String(1 - stretch * 0.48));
      target.style.setProperty('--jelly-shift', `${Math.min(4, stretch * 180)}px`);
      jellyPointerRef.current.set(target, { x: event.clientX, time: event.timeStamp, timer: previous?.timer });
    },
    onPointerLeave: (event: React.PointerEvent<HTMLElement>) => {
      const target = event.currentTarget;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      target.classList.remove('is-releasing');
      void target.offsetWidth;
      target.classList.add('is-releasing');
      target.style.removeProperty('--jelly-x');
      target.style.removeProperty('--jelly-y');
      target.style.removeProperty('--jelly-light-x');
      target.style.removeProperty('--jelly-light-y');
      target.style.removeProperty('--jelly-scale-x');
      target.style.removeProperty('--jelly-scale-y');
      target.style.removeProperty('--jelly-shift');
      const previous = jellyPointerRef.current.get(target);
      if (previous?.timer) window.clearTimeout(previous.timer);
      const timer = window.setTimeout(() => target.classList.remove('is-releasing'), 430);
      jellyPointerRef.current.set(target, { x: event.clientX, time: event.timeStamp, timer });
    }
  };

  return (
    <div className="knowledge-workbench">
      <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={(event) => importQuestionBankFile(event.target.files?.[0])} hidden />

      <section className="kb-bento-grid" aria-label="本地题库总览">
        <div className="kb-bento-card kb-bento-card--hero kb-jelly-surface" {...jellyMotion}>
          <div className="kb-bento-card__topline">
            <div>
              <span className="kb-kicker">本地题库总览</span>
              <div className="kb-bento-card__number">{questionBank.length}<span>道精选题</span></div>
            </div>
            <div className="kb-bento-card__icon"><Database size={20} /></div>
          </div>
          <p>已建立本地索引，命中时优先返回，不消耗 AI 调用额度。</p>
          <div className="kb-progress" aria-label={`本地题库共 ${questionBank.length} 道题`}><span style={{ width: `${Math.min(100, Math.max(6, questionBank.length / 5))}%` }} /></div>
          <div className="kb-bento-card__foot"><span>本地检索优先</span><strong>{questionBank.length} / 1000</strong></div>
        </div>
        <div className="kb-bento-card kb-jelly-surface" {...jellyMotion}>
          <div className="kb-bento-card__topline"><span className="kb-kicker">累计命中</span><Check size={17} /></div>
          <div className="kb-bento-card__number kb-bento-card__number--success">{questionBank.reduce((total, entry) => total + (entry.hits || 0), 0)}<span>次</span></div>
          <p>当前题库的精确与相似题命中次数。</p>
        </div>
        <div className="kb-bento-card kb-jelly-surface" {...jellyMotion}>
          <div className="kb-bento-card__topline"><span className="kb-kicker">当前页面</span><FileSearch size={17} /></div>
          <div className="kb-bento-card__title">{snapshot?.title || '等待抓取题目'}</div>
          <p>{snapshot ? `最近抓取：${new Date(snapshot.capturedAt).toLocaleString()}` : '抓取页面题目后会在这里显示来源。'}</p>
        </div>
      </section>

      <section className="kb-filter-area" aria-label="题库检索与操作">
        <label className="kb-search-bar">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索题干、选项、答案或解析..." />
          {query && <button type="button" className="kb-search-bar__clear" onClick={() => setQuery('')} aria-label="清空搜索">×</button>}
        </label>
        <div className="kb-type-pills" role="tablist" aria-label="题型筛选">
          {([
            ['all', '全部题目', questionBank.length],
            ['single', '单选题', typeCounts.single],
            ['multiple', '多选题', typeCounts.multiple],
            ['judgement', '判断题', typeCounts.judgement],
            ['completion', '填空题', typeCounts.completion]
          ] as const).map(([type, label, count]) => (
            <button key={type} type="button" role="tab" aria-selected={activeType === type} className={`kb-type-pill${activeType === type ? ' is-active' : ''}`} onClick={() => setActiveType(type)}>
              {label}<span>{count}</span>
            </button>
          ))}
        </div>
        <div className="kb-action-strip">
          <button className="kb-action-button" onClick={() => openWebAI(true)}><ClipboardPaste size={15} />粘贴 AI 回答</button>
          <button className="kb-action-button kb-action-button--primary" onClick={() => setShowManualEditor((value) => !value)}><Plus size={15} />录入新题</button>
          <button className="kb-action-button" onClick={() => fileInputRef.current?.click()}><Upload size={15} />导入题库</button>
          <button className="kb-action-button" onClick={exportQuestionBank} disabled={questionBank.length === 0}><Download size={15} />导出备份</button>
          {questionBank.length > 0 && <button className="kb-action-button kb-action-button--danger" onClick={() => appStore.clearQuestionBank()}><Trash2 size={15} />清空</button>}
        </div>
      </section>

      {showManualEditor && (
        <section className="kb-editor-panel">
          <div className="kb-editor-panel__heading"><div><span className="kb-kicker">手动录入</span><h5>添加题目与答案</h5></div><button className="kb-icon-button" onClick={() => setShowManualEditor(false)} title="收起录入面板">×</button></div>
          <textarea value={manualText} onChange={(event) => setManualText(event.target.value)} rows={10} />
          <div className="kb-editor-panel__foot"><span>支持连续粘贴多题；答案使用“答案：A”或“答案：内容”。</span><button className="kb-action-button kb-action-button--primary" onClick={addManualItems}><Plus size={15} />加入题库</button></div>
        </section>
      )}

      <section className="kb-question-stream" aria-live="polite">
        {filteredEntries.length === 0 ? (
          <div className="kb-empty-state"><FileSearch size={30} /><strong>{questionBank.length ? '没有符合条件的题目' : '本地题库还是空的'}</strong><span>{questionBank.length ? '试试修改搜索词或题型筛选。' : '导入题库文件，或使用“录入新题”建立你的第一条题目。'}</span></div>
        ) : filteredEntries.slice(0, 80).map((entry, index) => {
          const type = getEntryType(entry);
          const labels = entry.answer.choiceLabels.map((label) => label.toUpperCase());
          return (
            <article key={entry.id} className="kb-question-card kb-jelly-surface" {...jellyMotion}>
              <div className="kb-question-card__meta">
                <div><span className="kb-index">#{String(index + 1).padStart(2, '0')}</span><span className={`kb-type-tag kb-type-tag--${type}`}>{typeLabels[type]}</span></div>
                <div className="kb-question-card__tools"><span className="kb-hit"><i />命中 {entry.hits || 0} 次</span><button className="kb-icon-button" onClick={() => copyQuestion(entry)} title="复制题目与答案"><Copy size={14} /></button></div>
              </div>
              <h5>{entry.question}</h5>
              {entry.options.length > 0 ? (
                <div className={`kb-option-list${type === 'judgement' ? ' kb-option-list--judgement' : ''}`}>
                  {entry.options.map((option, optionIndex) => {
                    const label = option.match(/^\s*([A-H])\s*[.\s:：、。)]/i)?.[1]?.toUpperCase() || String.fromCharCode(65 + optionIndex);
                    const correct = labels.includes(label) || new RegExp(`(^|[^A-Z])${label}([^A-Z]|$)`, 'i').test(entry.answer.answer);
                    return <div key={`${entry.id}-${optionIndex}`} className={`kb-option${correct ? ' is-correct' : ''}`}><span>{label}</span><div>{option.replace(/^\s*[A-H]\s*[.\s:：、。)]\s*/i, '')}</div>{correct && <em><Check size={12} />正确答案</em>}</div>;
                  })}
                </div>
              ) : <div className="kb-answer-line"><Check size={15} /><span>答案</span><strong>{entry.answer.answer}</strong></div>}
              {entry.answer.analysis && <div className="kb-analysis"><div><span>解析</span><small>{entry.answer.provider || '本地题库'}</small></div><p>{entry.answer.analysis}</p></div>}
              <div className="kb-question-card__source">更新：{Number.isFinite(entry.updatedAt) ? new Date(entry.updatedAt).toLocaleString() : '未知'} · 来源：{entry.answer.provider || '未知'}</div>
            </article>
          );
        })}
      </section>
    </div>
  );
}
