import { describe, expect, it } from 'vitest';
import { buildWebPrompt, type WebBatch } from '../src/webAI/protocol';
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
