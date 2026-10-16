import { describe, expect, it } from 'vitest';
import { buildWebPrompt, parseWebAnswer, type WebBatch } from '../src/webAI/protocol';
import type { QuestionItem } from '../src/store/appStore';

function question(index: number, type: QuestionItem['type'], text: string): QuestionItem {
  return {
    id: `q-${index}`,
    hash: `hash-${index}`,
    question: text,
    options: [],
    type,
    source: 'webview',
    capturedAt: Date.now(),
    index
  };
}

describe('网页 AI 提示词中的填空题', () => {
  it('完整包含同一批中的每个填空题，并保留格式约束', () => {
    const batch: WebBatch = {
      requestId: 'request-fill-1',
      questions: [
        question(21, 'completion', '实验结论：____；心得体会：____。'),
        question(22, 'completion', '请按有序列表填写三个步骤：____。'),
        question(23, 'essay', '请写出实验注意事项。')
      ]
    };

    const prompt = buildWebPrompt(batch);

    expect(prompt).toContain('实验结论：____；心得体会：____。');
    expect(prompt).toContain('请按有序列表填写三个步骤：____。');
    expect(prompt).toContain('以 `##` 作为唯一分隔符');
    expect(prompt).toContain('首行缩进 2 个字符');
    expect(prompt).toContain('两个全角空格');
    expect(prompt).toContain('有序或无序内容');
    expect(prompt).toContain('短填空');
    expect(prompt).toContain('长答案');
    expect(prompt).not.toContain('不要擅自改成列表、编号或无序内容');
    expect(prompt).toContain('不得省略、合并题目');
  });
});

describe('网页 AI 明确题型与判断答案', () => {
  it('逐题注明单选唯一答案，同时保留多选题型', () => {
    const prompt = buildWebPrompt({ requestId: 'types', questions: [
      { ...question(1, 'single', '选择一项'), options: ['A. 苹果', 'B. 香蕉'] },
      { ...question(2, 'multiple', '选择多项'), options: ['A. 苹果', 'B. 香蕉'] }
    ] });
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n{') + 2));
    expect(payload.questions[0]).toMatchObject({ type: 'single', typeName: '单选题' });
    expect(payload.questions[0].answerRule).toContain('唯一一个选项');
    expect(payload.questions[0].answerRule).toContain('长度必须都是 1');
    expect(payload.questions[1]).toMatchObject({ type: 'multiple', typeName: '多选题' });
    expect(payload.questions[1].answerRule).not.toContain('唯一一个');
  });

  it.each([true, false])('接受判断题 JSON 布尔值 %s 并保留存储格式', value => {
    const batch = { requestId: 'bool', questions: [question(1, 'judgement', '地球是圆的。')] };
    const parsed = parseWebAnswer(JSON.stringify({ requestId: 'bool', answers: [{
      id: 'q1', answer: value, choiceLabels: [], matchedOptions: [], confidence: 0.9, analysis: '', warnings: []
    }] }), batch, 'web');
    expect(parsed.errors).toEqual([]);
    expect(parsed.items[0].answer.answer).toBe(String(value));
  });

  it('仍然拒绝单选多答案，不能截取第一个当正确答案', () => {
    const batch = { requestId: 'single', questions: [{ ...question(1, 'single', '选择一项'), options: ['A. 苹果', 'B. 香蕉'] }] };
    const parsed = parseWebAnswer(JSON.stringify({ requestId: 'single', answers: [{
      id: 'q1', answer: 'AB', choiceLabels: ['A', 'B'], matchedOptions: ['苹果', '香蕉'], confidence: 1, analysis: '', warnings: []
    }] }), batch, 'web');
    expect(parsed.items).toEqual([]);
    expect(parsed.errors[0]).toContain('单选题必须只有一个');
  });

  it('截断恢复保留完整行的转义和括号，严格校验选项且不接受其他请求', () => {
    const batch = { requestId: 'partial', questions: [
      { ...question(1, 'single', '选择一项'), options: ['A. 苹果', 'B. 香蕉'] },
      question(2, 'completion', '填空')
    ] };
    const row = { id: 'q1', answer: '苹果', choiceLabels: ['A'], matchedOptions: ['苹果'], confidence: 0.9, analysis: '引号"和括号 } [ 以及斜杠\\', warnings: [] };
    const truncated = '{"requestId":"partial","answers":[' + JSON.stringify(row) + ',{"id":"q2","answer":"未完成';
    const preview = parseWebAnswer(truncated, batch, 'web', true);
    expect(preview.items.map(item => item.question.id)).toEqual(['q-1']);
    expect(preview.items[0].answer.analysis).toBe(row.analysis);
    expect(preview.errors.some(error => error.includes('q2'))).toBe(true);
    expect(parseWebAnswer(truncated.replace('"partial"', '"old"'), batch, 'web', true).items).toEqual([]);
    expect(parseWebAnswer(truncated, batch, 'web').items).toEqual([]);
    expect(parseWebAnswer(truncated.replace('"A"', '"B"'), batch, 'web', true).items).toEqual([]);
  });
});
