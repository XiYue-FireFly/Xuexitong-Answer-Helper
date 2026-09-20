import { describe, expect, it } from 'vitest';
import { isQuestionMetadataOnly, isQuestionRootTextNoise } from '../electron/preload-webview/question-extractor';

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
