import { describe, expect, it } from 'vitest';
import { appStore, type QuestionItem, type AIAnswerResult } from '../src/store/appStore';
import { buildWebReferences, stableWebQuestionKey, toWebBankQuestion } from '../src/webAI/questionContext';
import { buildWebPrompt, prepareWebBatch, sameQuestions } from '../src/webAI/protocol';

function question(hash: string, text: string, group = 'cable', filled: string[] = []): QuestionItem {
  return { id: hash, hash, question: text, index: Number(hash.slice(1)) || 1, options: [], type: 'completion', source: 'webview', capturedAt: 0,
    webReference: { pageTitle: '网络实验', chapterTitle: '网络实验', sectionTitle: '直通网线制作', groupKey: group, sourceQuestionId: hash, filledValues: filled } };
}
const answer: AIAnswerResult = { questionHash: 'q1', answer: '568B', choiceLabels: [], matchedOptions: [], confidence: 1, analysis: '', warnings: [], provider: 'test' };
describe('Web report references', () => {
  it('adds the local chapter, preceding live answer and adjacent stems without another group', () => {
    const items = [question('q1', '接线标准', 'cable', ['568B']), question('q2', '实验结论'), question('q3', '心得'), question('q4', '另一实验机密', 'other', ['不应引用'])];
    const result = prepareWebBatch([items[1]], 'deepseek', buildWebReferences(items));
    expect(result.prompt).toContain('网络实验'); expect(result.prompt).toContain('直通网线制作');
    expect(result.prompt).toContain('568B'); expect(result.prompt).toContain('page-filled'); expect(result.prompt).toContain('心得');
    expect(result.prompt).not.toContain('另一实验机密'); expect(result.prompt).not.toContain('不应引用');
  });
  it('uses validated preceding batches and preserves static identity when values change', () => {
    const first = question('q1', '接线标准', 'cable', ['旧填写']); const current = question('q2', '实验结论');
    expect(buildWebReferences([first, current], [{ question: first, answer }]).q2.previousAnswers[0]).toMatchObject({ answer: '568B', source: 'web-generated' });
    const changed = { ...first, webReference: { ...first.webReference!, filledValues: ['new value'] } };
    expect(stableWebQuestionKey(changed)).toBe(stableWebQuestionKey(first));
    expect(sameQuestions([first], [changed])).toBe(true); expect(toWebBankQuestion(changed)).toEqual(toWebBankQuestion(first));
  });
  it('budgets optional references and counts them in the exact 300000 character boundary', () => {
    const first = question('q1', '前题'.repeat(9000), 'cable', ['答案'.repeat(9000)]);
    const current = question('q2', '结论'); current.webReference!.material = '材料'.repeat(12000);
    const references = buildWebReferences([first, current]);
    expect(references.q2.reduced).toBe(true);
    const id = '00000000-0000-0000-0000-000000000000';
    const overhead = buildWebPrompt({ requestId: id, questions: [{ ...current, question: '' }], references }).length;
    const exact = { ...current, question: 'x'.repeat(300000 - overhead) };
    expect(prepareWebBatch([exact], 'deepseek', references).prompt.length).toBe(300000);
    expect(prepareWebBatch([{ ...exact, question: exact.question + 'x' }], 'deepseek', references).skipped).toHaveLength(1);
  });
  it('keeps distinct report bank entries and leaves default legacy writes compatible', () => {
    appStore.clearQuestionBank();
    const first = question('q1', '实验结论'); const second = question('q1', '实验结论', 'another-report');
    appStore.upsertQuestionBank(toWebBankQuestion(first), answer, { exactContext: true });
    appStore.upsertQuestionBank(toWebBankQuestion(second), { ...answer, answer: '另一结论' }, { exactContext: true });
    const changed = { ...first, webReference: { ...first.webReference!, filledValues: ['updated'] } };
    appStore.upsertQuestionBank(toWebBankQuestion(changed), { ...answer, answer: '更新结论' }, { exactContext: true });
    expect(appStore.exportQuestionBank()).toHaveLength(2);
    expect(appStore.exportQuestionBank().map(item => item.answer.answer).sort()).toEqual(['另一结论', '更新结论'].sort());
    appStore.clearQuestionBank();
  });
});
