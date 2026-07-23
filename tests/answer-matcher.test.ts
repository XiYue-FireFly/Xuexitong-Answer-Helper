import { describe, it, expect } from 'vitest';
import {
  judgementValueFromText,
  parseJudgementValue,
  parseJudgementValueStable,
  parseStrictJudgementOption,
  answerAliases
} from '../electron/preload-webview/answer-matcher';

describe('parseJudgementValueStable - 判断题答案解析', () => {
  it('识别肯定答案', () => {
    expect(parseJudgementValueStable('正确')).toBe('true');
    expect(parseJudgementValueStable('对')).toBe('true');
    expect(parseJudgementValueStable('√')).toBe('true');
    expect(parseJudgementValueStable('true')).toBe('true');
    expect(parseJudgementValueStable('A. 正确')).toBe('true');
  });

  it('识别否定答案', () => {
    expect(parseJudgementValueStable('错误')).toBe('false');
    expect(parseJudgementValueStable('错')).toBe('false');
    expect(parseJudgementValueStable('×')).toBe('false');
    expect(parseJudgementValueStable('false')).toBe('false');
  });

  it('否定表达不得被肯定词子串误判（Bug #1）', () => {
    // “不正确”包含“正”，此前先命中“正”导致答反
    expect(parseJudgementValueStable('不正确')).toBe('false');
    expect(parseJudgementValueStable('不对')).toBe('false');
    expect(parseJudgementValueStable('不是')).toBe('false');
    // “incorrectly”包含“correct”，此前被判 true
    expect(parseJudgementValueStable('incorrect')).toBe('false');
    expect(parseJudgementValueStable('incorrectly')).toBe('false');
  });

  it('数字仅在整串精确匹配时才算判断值', () => {
    expect(parseJudgementValueStable('1')).toBe('true');
    expect(parseJudgementValueStable('0')).toBe('false');
  });

  it('无法解析时返回 null', () => {
    expect(parseJudgementValueStable('属实')).toBe(null);
    expect(parseJudgementValueStable('')).toBe(null);
  });
});

describe('judgementValueFromText', () => {
  it('数字 1/0 不匹配含数字的普通文本（Bug #1）', () => {
    expect(judgementValueFromText('180度')).toBe(null);
    expect(judgementValueFromText('10')).not.toBe('true');
    expect(judgementValueFromText('1')).toBe('true');
    expect(judgementValueFromText('0')).toBe('false');
  });

  it('否定优先', () => {
    expect(judgementValueFromText('不正确')).toBe('false');
    expect(judgementValueFromText('正确')).toBe('true');
  });
});

describe('parseJudgementValue', () => {
  it('否定表达不被肯定词误判', () => {
    expect(parseJudgementValue('不正确')).toBe('false');
    expect(parseJudgementValue('正确')).toBe('true');
    expect(parseJudgementValue('错误')).toBe('false');
  });
});

describe('parseStrictJudgementOption', () => {
  it('剥离选项标签后严格匹配', () => {
    expect(parseStrictJudgementOption('A. 对')).toBe('true');
    expect(parseStrictJudgementOption('B、错')).toBe('false');
    expect(parseStrictJudgementOption('正确')).toBe('true');
  });
});

describe('answerAliases', () => {
  it('英文文本不被吃掉首字母（Bug #3 联动）', () => {
    const aliases = answerAliases('Apple');
    expect(aliases).toContain('apple');
  });
});
