import { describe, it, expect } from 'vitest';
import { cleanText, normalizeText, hashText } from '../electron/preload-webview/dom-utils';

describe('normalizeText - 选项前缀剥离（Bug #3）', () => {
  it('剥离带标点的选项标签', () => {
    expect(normalizeText('A. 选项一')).toBe('选项一');
    expect(normalizeText('B、选项二')).toBe('选项二');
    expect(normalizeText('C) option three')).toBe('optionthree');
    expect(normalizeText('Ｄ. 全角')).toBe('全角');
  });

  it('不得吃掉 A-H 开头的正常文本首字母', () => {
    expect(normalizeText('Apple')).toBe('apple');
    expect(normalizeText('B细胞')).toBe('b细胞');
    expect(normalizeText('all')).toBe('all');
    expect(normalizeText('Be yourself')).toBe('beyourself');
    expect(normalizeText('Dog')).toBe('dog');
  });

  it('标点与大小写归一化', () => {
    expect(normalizeText('Hello, World!')).toBe('helloworld!');
    expect(normalizeText('  Abc ')).toBe('abc');
  });
});

describe('cleanText - 行首编号剥离（Bug #5）', () => {
  it('剥离题号', () => {
    expect(cleanText('1. 下列说法正确的是')).toBe('下列说法正确的是');
    expect(cleanText('12、题干内容')).toBe('题干内容');
  });

  it('不得毁坏小数（Bug #5）', () => {
    expect(cleanText('1.5倍速播放')).toBe('1.5倍速播放');
    expect(cleanText('3.14159是圆周率')).toBe('3.14159是圆周率');
    expect(cleanText('12.5')).toBe('12.5');
  });
});

describe('hashText', () => {
  it('生成稳定哈希', () => {
    expect(hashText('test')).toBe(hashText('test'));
    expect(hashText('test')).not.toBe(hashText('test2'));
  });
});
