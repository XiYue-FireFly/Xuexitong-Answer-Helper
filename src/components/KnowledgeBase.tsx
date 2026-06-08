import React, { useEffect, useRef, useState } from 'react';
import { Cloud, Database, Download, FileSearch, Plus, RefreshCw, Send, Trash2, Upload } from 'lucide-react';
import { appStore, ManualQuestionBankInput, QuestionType, useAppStore } from '../store/appStore';

type CloudSource = 'github' | 'gitee';

type CloudBankCard = {
  id: string;
  name: string;
  remark: string;
  count: number;
  author: string;
  path: string;
  updatedAt: string;
};

const CLOUD_SOURCE_LABELS: Record<CloudSource, string> = {
  github: 'GitHub',
  gitee: 'Gitee'
};

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
  const [cloudSource, setCloudSource] = useState<CloudSource>('github');
  const [cloudBanks, setCloudBanks] = useState<CloudBankCard[]>([]);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudMessage, setCloudMessage] = useState('');
  const [uploadName, setUploadName] = useState('');
  const [uploadRemark, setUploadRemark] = useState('');
  const [uploadAuthor, setUploadAuthor] = useState(() => localStorage.getItem('studypilot_cloud_bank_author') || '');
  const [cloudToken, setCloudToken] = useState(() => localStorage.getItem('studypilot_cloud_bank_token_github') || '');

  useEffect(() => {
    setCloudToken(localStorage.getItem(`studypilot_cloud_bank_token_${cloudSource}`) || '');
    loadCloudBanks(cloudSource);
  }, [cloudSource]);

  const saveCloudToken = (source: CloudSource, token: string) => {
    setCloudToken(token);
    localStorage.setItem(`studypilot_cloud_bank_token_${source}`, token);
  };

  const saveUploadAuthor = (author: string) => {
    setUploadAuthor(author);
    localStorage.setItem('studypilot_cloud_bank_author', author);
  };

  const loadCloudBanks = async (source = cloudSource) => {
    setCloudLoading(true);
    setCloudMessage('');
    try {
      const api = (window as any).electronAPI;
      if (!api?.listCloudQuestionBanks) throw new Error('当前环境不支持云端题库。请使用桌面版应用。');
      const result = await api.listCloudQuestionBanks(source);
      if (!result?.success) throw new Error(result?.error || '读取云端题库失败。');
      setCloudBanks(Array.isArray(result.banks) ? result.banks : []);
      setCloudMessage(result.warning || `已加载 ${CLOUD_SOURCE_LABELS[source]} 云端题库。`);
    } catch (error: any) {
      setCloudBanks([]);
      setCloudMessage(error.message || '读取云端题库失败。');
      appStore.addLog('error', `读取云端题库失败：${error.message || error}`);
    } finally {
      setCloudLoading(false);
    }
  };

  const importCloudBank = async (bank: CloudBankCard) => {
    setCloudLoading(true);
    try {
      const api = (window as any).electronAPI;
      const result = await api.downloadCloudQuestionBank({ source: cloudSource, path: bank.path });
      if (!result?.success) throw new Error(result?.error || '下载云端题库失败。');
      appStore.importQuestionBank(result.entries);
      setCloudMessage(`已从 ${CLOUD_SOURCE_LABELS[cloudSource]} 导入：${bank.name}`);
    } catch (error: any) {
      setCloudMessage(error.message || '导入云端题库失败。');
      appStore.addLog('error', `导入云端题库失败：${error.message || error}`);
    } finally {
      setCloudLoading(false);
    }
  };

  const uploadCloudBank = async () => {
    if (!uploadName.trim()) {
      appStore.addLog('error', '请填写云端题库名字。');
      return;
    }
    if (!cloudToken.trim()) {
      appStore.addLog('error', `请填写 ${CLOUD_SOURCE_LABELS[cloudSource]} Token。`);
      return;
    }
    if (questionBank.length === 0) {
      appStore.addLog('error', '本地题库为空，无法上传。');
      return;
    }
    setCloudLoading(true);
    try {
      const api = (window as any).electronAPI;
      const result = await api.uploadCloudQuestionBank({
        source: cloudSource,
        token: cloudToken,
        name: uploadName,
        remark: uploadRemark,
        author: uploadAuthor,
        entries: appStore.exportQuestionBank()
      });
      if (!result?.success) throw new Error(result?.error || '上传云端题库失败。');
      setCloudMessage(`已上传到 ${CLOUD_SOURCE_LABELS[cloudSource]}：${result.name}（${result.count} 题）`);
      setUploadName('');
      setUploadRemark('');
      await loadCloudBanks(cloudSource);
    } catch (error: any) {
      setCloudMessage(error.message || '上传云端题库失败。');
      appStore.addLog('error', `上传云端题库失败：${error.message || error}`);
    } finally {
      setCloudLoading(false);
    }
  };

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

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflowY: 'auto' }}>
      <div className="glass-panel" style={{ padding: 18, borderRadius: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Database size={18} style={{ color: 'var(--primary-color)' }} />
            <h4 style={{ color: 'var(--text-primary)', fontSize: '0.95rem' }}>本地题库</h4>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={(event) => importQuestionBankFile(event.target.files?.[0])}
              style={{ display: 'none' }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              style={{ background: 'rgba(99,102,241,0.14)', color: 'var(--text-primary)', padding: '7px 9px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', fontWeight: 700 }}
            >
              <Upload size={13} /> 导入
            </button>
            <button
              onClick={exportQuestionBank}
              disabled={questionBank.length === 0}
              style={{ background: 'rgba(16,185,129,0.14)', color: 'var(--text-primary)', padding: '7px 9px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', fontWeight: 700, opacity: questionBank.length === 0 ? 0.55 : 1 }}
            >
              <Download size={13} /> 导出
            </button>
            {questionBank.length > 0 && (
              <button
                onClick={() => appStore.clearQuestionBank()}
                style={{ background: 'rgba(239,68,68,0.12)', color: 'var(--danger-color)', padding: '7px 9px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', fontWeight: 700 }}
              >
                <Trash2 size={13} /> 清空
              </button>
            )}
          </div>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.55 }}>
          本地题库保存在本机浏览器存储中。查询答案时会优先命中题库，未命中才会调用 AI；因此你可以导入或手动加入答案，在没有 API Key 时也能使用本地解析。
        </p>
      </div>

      <div className="glass-panel" style={{ padding: 14, borderRadius: 8, color: 'var(--text-secondary)', fontSize: '0.78rem', lineHeight: 1.6 }}>
        <div><strong style={{ color: 'var(--text-primary)' }}>题库数量：</strong>{questionBank.length} 题</div>
        {snapshot && (
          <>
            <div><strong style={{ color: 'var(--text-primary)' }}>当前页面：</strong>{snapshot.title}</div>
            <div><strong style={{ color: 'var(--text-primary)' }}>捕获时间：</strong>{new Date(snapshot.capturedAt).toLocaleString()}</div>
          </>
        )}
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Cloud size={18} style={{ color: 'var(--primary-color)' }} />
            <div>
              <h5 style={{ color: 'var(--text-primary)', fontSize: '0.88rem' }}>云端题库</h5>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', lineHeight: 1.45 }}>
                可从 GitHub 或 Gitee 共享题库导入，也可以把当前本地题库上传到云端。
              </div>
            </div>
          </div>
          <button
            onClick={() => loadCloudBanks(cloudSource)}
            disabled={cloudLoading}
            className="btn btn-soft"
            style={{ minHeight: 34, padding: '7px 10px', fontSize: '0.72rem', opacity: cloudLoading ? 0.55 : 1 }}
          >
            <RefreshCw size={13} /> 刷新
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {(['github', 'gitee'] as CloudSource[]).map((source) => (
            <button
              key={source}
              onClick={() => setCloudSource(source)}
              style={{
                background: cloudSource === source ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.035)',
                border: cloudSource === source ? '1px solid var(--primary-color)' : '1px solid var(--border-glass)',
                color: 'var(--text-primary)',
                borderRadius: 8,
                padding: '9px 10px',
                fontWeight: 850
              }}
            >
              {CLOUD_SOURCE_LABELS[source]}
            </button>
          ))}
        </div>

        {cloudMessage && (
          <div style={{ color: cloudMessage.includes('失败') ? 'var(--danger-color)' : 'var(--text-secondary)', fontSize: '0.72rem', lineHeight: 1.5 }}>
            {cloudMessage}
          </div>
        )}

        {cloudBanks.length === 0 ? (
          <div style={{ border: '1px dashed var(--border-glass)', borderRadius: 8, padding: 18, color: 'var(--text-muted)', fontSize: '0.76rem', textAlign: 'center' }}>
            {cloudLoading ? '正在加载云端题库...' : '云端暂无可展示题库。上传第一份题库后会自动生成云端清单。'}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10 }}>
            {cloudBanks.map((bank) => (
              <div key={`${cloudSource}-${bank.path}`} className="glass-panel" style={{ padding: 12, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 9 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: 'var(--text-primary)', fontSize: '0.82rem', fontWeight: 900, lineHeight: 1.4, wordBreak: 'break-word' }}>{bank.name}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem', marginTop: 3 }}>上传者：{bank.author || '匿名用户'}</div>
                  </div>
                  <span className="badge badge-primary" style={{ whiteSpace: 'nowrap' }}>{bank.count} 题</span>
                </div>
                {bank.remark && (
                  <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as React.CSSProperties}>
                    {bank.remark}
                  </div>
                )}
                <div style={{ color: 'var(--text-muted)', fontSize: '0.66rem' }}>
                  {bank.updatedAt ? `更新：${new Date(bank.updatedAt).toLocaleString()}` : CLOUD_SOURCE_LABELS[cloudSource]}
                </div>
                <button
                  onClick={() => importCloudBank(bank)}
                  disabled={cloudLoading}
                  className="btn btn-success"
                  style={{ minHeight: 34, padding: '7px 10px', fontSize: '0.72rem', opacity: cloudLoading ? 0.55 : 1 }}
                >
                  <Download size={13} /> 导入这个题库
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ borderTop: '1px solid var(--border-glass)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ color: 'var(--text-primary)', fontSize: '0.8rem', fontWeight: 850 }}>上传当前本地题库</div>
          <input
            value={uploadName}
            onChange={(event) => setUploadName(event.target.value)}
            placeholder="题库名字，例如：马克思主义基本原理第七章"
          />
          <textarea
            value={uploadRemark}
            onChange={(event) => setUploadRemark(event.target.value)}
            rows={3}
            placeholder="备注，例如：包含单选、多选、判断题，适合期末复习"
            style={{ resize: 'vertical', minHeight: 76 }}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <input
              value={uploadAuthor}
              onChange={(event) => saveUploadAuthor(event.target.value)}
              placeholder="上传者名字，会脱敏显示，如 张三 -> 张*"
            />
            <input
              type="password"
              value={cloudToken}
              onChange={(event) => saveCloudToken(cloudSource, event.target.value)}
              placeholder={`${CLOUD_SOURCE_LABELS[cloudSource]} Token（只保存在本机）`}
            />
          </div>
          <button
            onClick={uploadCloudBank}
            disabled={cloudLoading || questionBank.length === 0}
            className="btn btn-primary"
            style={{ opacity: cloudLoading || questionBank.length === 0 ? 0.55 : 1 }}
          >
            <Send size={14} /> 上传到 {CLOUD_SOURCE_LABELS[cloudSource]} 云端题库
          </button>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', lineHeight: 1.5 }}>
            GitHub 仓库：XiYue-FireFly/Xuexitong-Answer-Helper-Question-bank；Gitee 仓库：SunandMoon-FireFly/xuexitong-answer-helper-question-bank。Token 只保存在本机 localStorage，不会写入题库文件。
          </div>
        </div>
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <h5 style={{ color: 'var(--text-primary)', fontSize: '0.86rem' }}>手动加入答案</h5>
          <button
            onClick={addManualItems}
            style={{ background: 'linear-gradient(135deg, var(--primary-color), var(--accent-color))', color: '#fff', padding: '8px 10px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', fontWeight: 800 }}
          >
            <Plus size={14} /> 加入题库
          </button>
        </div>
        <textarea
          value={manualText}
          onChange={(event) => setManualText(event.target.value)}
          rows={10}
          style={{ width: '100%', resize: 'vertical', fontSize: '0.78rem', lineHeight: 1.55 }}
        />
        <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', lineHeight: 1.55 }}>
          选择题格式：题目换行，A/B/C/D 选项换行，答案写“答案：A”或“答案：A、C”。填空题格式：题目换行，答案写“答案：内容”。多个题目可连续粘贴，也可用空行或 --- 分隔。
        </div>
      </div>

      {questionBank.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '40px 20px', display: 'flex', alignItems: 'center', flexDirection: 'column', gap: 10 }}>
          <FileSearch size={28} />
          <p style={{ fontSize: '0.8rem' }}>题库还是空的。可以导入题库文件，或在上方手动加入答案。</p>
        </div>
      ) : (
        questionBank.slice(0, 80).map((entry) => (
          <div key={entry.id} className="glass-panel" style={{ padding: 14, borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
              <h5 style={{ color: 'var(--text-primary)', fontSize: '0.84rem', lineHeight: 1.45 }}>{entry.question}</h5>
              <span className="badge badge-success">命中 {entry.hits}</span>
            </div>
            <div style={{ color: '#34d399', fontSize: '0.82rem', fontWeight: 800, marginBottom: 8 }}>{entry.answer.answer}</div>
            {entry.options.length > 0 && (
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.72rem', lineHeight: 1.5 }}>
                {entry.options.slice(0, 4).join(' / ')}
              </div>
            )}
            <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem', marginTop: 8 }}>
              更新：{new Date(entry.updatedAt).toLocaleString()} · 来源：{entry.answer.provider}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
