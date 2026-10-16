import { describe, expect, it } from 'vitest';
import type { QuestionBankEntry } from '../src/store/appStore';
import { getEntryType, judgementAnswerText, isCorrectOption } from '../src/components/knowledgeAnswer';

function entry(answer: string, options: string[] = ['A. 正确', 'B. 错误']): QuestionBankEntry {
  return { id: 'bool', questionKey: 'bool', question: '地球是圆的。', options, updatedAt: 0, hits: 0,
    answer: { questionHash: 'bool', provider: 'web', model: 'web', answer, choiceLabels: [], matchedOptions: [], confidence: 0.9, analysis: '', warnings: [], createdAt: 0 } };
}

describe('判断题展示', () => {
  it('按原始题型分类，不根据单选的错误多答案改为多选', () => {
    const item = { ...entry('A B', ['A. 苹果', 'B. 香蕉']), type: 'single' as const };
    item.answer.choiceLabels = ['A', 'B'];
    expect(getEntryType(item)).toBe('single');
  });
  it('旧题库的对/错成对选项可识别为判断题，即使已保存选项字母', () => {
    const item = entry('false', ['A. 对', 'B. 错']);
    item.answer.choiceLabels = ['B'];
    expect(getEntryType(item)).toBe('judgement');
    expect(item.options.map((option, index) => isCorrectOption(item, option, index))).toEqual([false, true]);
  });
  it('明确标注单选的正文优先于对/错选项，不同时高亮字母和正文', () => {
    const item = entry('A', ['A. 对', 'B. 错']);
    item.question = '[单选题] 选择正确的字词';
    item.answer.choiceLabels = ['A'];
    expect(getEntryType(item)).toBe('single');
  });
  it.each([['true', '正确'], ['false', '错误'], ['TRUE', '正确'], ['错误', '错误']])('将 %s 展示为 %s', (answer, text) => {
    expect(judgementAnswerText(answer)).toBe(text);
  });
  it.each(['true', 'false'])('识别没有选项或题型文字的布尔答案 %s', answer => {
    expect(getEntryType(entry(answer, []))).toBe('judgement');
  });
  it('高亮与真假含义对应的选项，不依赖选项顺序', () => {
    const item = entry('false', ['A. 正确', 'B. 错误']);
    expect(item.options.map((option, index) => isCorrectOption(item, option, index))).toEqual([false, true]);
    item.options = ['A. 错误', 'B. 正确'];
    expect(item.options.map((option, index) => isCorrectOption(item, option, index))).toEqual([true, false]);
  });
  it('支持页面上的符号和英文判断选项', () => {
    const item = entry('true', ['B. False', 'A. True']);
    expect(item.options.map((option, index) => isCorrectOption(item, option, index))).toEqual([false, true]);
    item.options = ['×', '√'];
    expect(item.options.map((option, index) => isCorrectOption(item, option, index))).toEqual([false, true]);
  });
  it('普通选择题和填空题的显示规则保持不变', () => {
    const item = entry('Banana', ['A. Apple', 'B. Banana']);
    item.answer.choiceLabels = ['B'];
    expect(getEntryType(item)).toBe('single');
    expect(isCorrectOption(item, item.options[1], 1)).toBe(true);
    expect(getEntryType(entry('a filled value', []))).toBe('completion');
    expect(judgementAnswerText('a filled value')).toBe('a filled value');
  });
  it('不把选择布尔字面量的单选题误判为判断题或高亮多个选项', () => {
    const item = entry('True', ['A. true', 'B. True']);
    item.question = '[单选题] 下列哪个是 Python 的布尔字面量？';
    item.answer.choiceLabels = ['B'];
    expect(getEntryType(item)).toBe('single');
    expect(item.options.map((option, index) => isCorrectOption(item, option, index))).toEqual([false, true]);
  });
});
