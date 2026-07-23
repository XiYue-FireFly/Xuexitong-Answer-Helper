import { describe, it, expect, beforeEach } from 'vitest';
import { appStore } from '../src/store/appStore';
import type { QuestionItem } from '../src/store/appStore';

function makeQuestion(partial: Partial<QuestionItem>): QuestionItem {
  return {
    id: partial.id || 'q1',
    hash: partial.hash || 'h1',
    question: partial.question || '',
    options: partial.options || [],
    context: partial.context,
    type: partial.type || 'single',
    source: partial.source || 'test',
    capturedAt: partial.capturedAt || Date.now(),
    index: partial.index
  };
}

beforeEach(() => {
  appStore.clearQuestionBank();
});

describe('题库：手动多选答案字母提取（Bug #2）', () => {
  const options = ['A. 苹果', 'B. 香蕉', 'C. 橙子', 'D. 葡萄'];

  function addAndGet(answer: string) {
    appStore.addManualQuestionBankItems([{ question: '下列哪些是水果？', options, answer, type: 'multiple' }]);
    const bank = appStore.exportQuestionBank();
    return bank[bank.length - 1];
  }

  it('“A、C”应提取 A 和 C（此前 C 丢失）', () => {
    const entry = addAndGet('A、C');
    expect(entry.answer.choiceLabels?.sort()).toEqual(['A', 'C']);
  });

  it('“A,C”应提取 A 和 C', () => {
    const entry = addAndGet('A,C');
    expect(entry.answer.choiceLabels?.sort()).toEqual(['A', 'C']);
  });

  it('“A、C、D”应提取 A、C、D（此前 C 丢失）', () => {
    const entry = addAndGet('A、C、D');
    expect(entry.answer.choiceLabels?.sort()).toEqual(['A', 'C', 'D']);
  });

  it('“AC”紧凑格式仍可用', () => {
    const entry = addAndGet('AC');
    expect(entry.answer.choiceLabels?.sort()).toEqual(['A', 'C']);
  });

  it('“答案：ABD”带前缀格式可用', () => {
    const entry = addAndGet('答案：ABD');
    expect(entry.answer.choiceLabels?.sort()).toEqual(['A', 'B', 'D']);
  });
});

describe('题库：匹配必须比较选项内容（Bug #13）', () => {
  it('题干相同但选项不同的题目不得命中', () => {
    appStore.addManualQuestionBankItems([{
      question: '地球绕什么转？',
      options: ['A. 太阳', 'B. 月亮', 'C. 火星', 'D. 金星'],
      answer: 'A',
      type: 'single'
    }]);
    const differentOptions = makeQuestion({
      question: '地球绕什么转？',
      options: ['A. 水星', 'B. 木星', 'C. 土星', 'D. 太阳'],
      type: 'single'
    });
    expect(appStore.findQuestionBankAnswer(differentOptions)).toBe(null);
  });

  it('题干与选项都一致的题目应命中', () => {
    appStore.addManualQuestionBankItems([{
      question: '地球绕什么转？',
      options: ['A. 太阳', 'B. 月亮', 'C. 火星', 'D. 金星'],
      answer: 'A',
      type: 'single'
    }]);
    const sameQuestion = makeQuestion({
      question: '地球绕什么转？',
      options: ['A. 太阳', 'B. 月亮', 'C. 火星', 'D. 金星'],
      type: 'single'
    });
    const hit = appStore.findQuestionBankAnswer(sameQuestion);
    expect(hit).not.toBe(null);
    expect(hit?.answer).toBe('A');
  });

  it('选项完全乱序但内容一致仍可命中（选项 key 排序）', () => {
    appStore.addManualQuestionBankItems([{
      question: '地球绕什么转？',
      options: ['A. 太阳', 'B. 月亮', 'C. 火星', 'D. 金星'],
      answer: '太阳',
      type: 'single'
    }]);
    const reordered = makeQuestion({
      question: '地球绕什么转？',
      options: ['A. 金星', 'B. 火星', 'C. 太阳', 'D. 月亮'],
      type: 'single'
    });
    expect(appStore.findQuestionBankAnswer(reordered)).not.toBe(null);
  });
});

describe('题库：演示答案隔离（Bug #12）', () => {
  it('演示答案不得覆盖真实答案', () => {
    const question = makeQuestion({ question: '1+1等于几？', options: ['A. 1', 'B. 2'], type: 'single' });
    // 模拟真实 AI 答案入库
    appStore.upsertQuestionBank(question, {
      questionHash: question.hash,
      provider: 'DeepSeek',
      model: 'deepseek-chat',
      answer: 'B',
      choiceLabels: ['B'],
      matchedOptions: ['B. 2'],
      confidence: 0.9,
      analysis: '',
      warnings: [],
      createdAt: Date.now() - 10000
    });
    // 模拟更新的演示答案试图入库
    appStore.upsertQuestionBank(question, {
      questionHash: question.hash,
      provider: '本地演示',
      model: 'demo',
      answer: 'A',
      choiceLabels: ['A'],
      matchedOptions: ['A. 1'],
      confidence: 0.1,
      analysis: '',
      warnings: [],
      createdAt: Date.now()
    });
    const hit = appStore.findQuestionBankAnswer(question);
    expect(hit?.answer).toBe('B');
  });
});
