import { afterEach, describe, expect, it, vi } from 'vitest';
import { inferTypeFromDom, isQuestionMetadataOnly, isQuestionRootTextNoise } from '../electron/preload-webview/question-extractor';
import { AnswerElement } from './helpers/answer-dom';

afterEach(() => vi.unstubAllGlobals());

describe('题目提取标题判定', () => {
  it('不会把论述题或资料题的分值标题当成完整题目', () => {
    expect(isQuestionMetadataOnly('21.（论述题，30分）')).toBe(true);
    expect(isQuestionMetadataOnly('22.（资料题，10分）')).toBe(true);
  });

  it('保留带实际题意的题干，即使题干包含题型和分值', () => {
    expect(isQuestionMetadataOnly('请写出实验结论和心得体会。（论述题，30分）')).toBe(false);
    expect(isQuestionMetadataOnly('根据材料分析双绞线制作步骤。（资料题，10分）')).toBe(false);
  });

  it('保留长资料题正文，但仍过滤脚本噪声', () => {
    expect(isQuestionRootTextNoise('材料正文'.repeat(900))).toBe(false);
    expect(isQuestionRootTextNoise('function submitWork(){ window.ajax({}); }'.repeat(100))).toBe(true);
  });
});

describe('题型元数据优先级', () => {
  function root(qtype?: string, typeName?: string) {
    vi.stubGlobal('window', {});
    const element = new AnswerElement('DIV', { qid: '1234', ...(qtype ? { qtype } : {}) });
    if (typeName) element.append(new AnswerElement('SPAN', { class: 'typeName' }, typeName));
    return element;
  }
  it('无原生 radio 的判断题标题仍识别为判断题', () => {
    const element = root(undefined, '判断题');
    element.append(new AnswerElement('SPAN', { class: 'num_option' }, 'A'));
    expect(inferTypeFromDom(element as unknown as HTMLElement, ['A. 对', 'B. 错'])).toBe('judgement');
  });
  it.each([['0', 'single'], ['3', 'judgement'], ['1', 'multiple'], ['21', 'multiple']])('明确 qtype=%s 不被通用多选标记覆盖', (qtype, expected) => {
    const element = root(qtype);
    element.append(new AnswerElement('SPAN', { class: 'num_option_dx' }));
    expect(inferTypeFromDom(element as unknown as HTMLElement, ['A. 对', 'B. 错'])).toBe(expected);
  });
});
