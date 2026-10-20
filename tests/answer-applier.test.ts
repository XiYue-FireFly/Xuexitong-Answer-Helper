import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnswerElement } from './helpers/answer-dom';
import { applyAnswerV2 } from '../electron/preload-webview/answer-applier';
import type { QuestionOptionTarget } from '../electron/preload-webview/types';

const fixture = vi.hoisted(() => ({ targets: [] as QuestionOptionTarget[] }));
class AnswerInput extends AnswerElement {}
class AnswerTextarea extends AnswerElement {}
vi.mock('../electron/preload-webview/question-extractor', () => ({
  extractOptionTargets: () => fixture.targets,
  nearestClickableOption: (element: AnswerElement) => element,
  readQuestionTypeHint: () => ({}),
  optionTargetFromElement: (element: AnswerElement, index: number) => fixture.targets.find(target => target.selector === `#${element.id}`) || fixture.targets[index]
}));
vi.mock('../electron/preload-webview/bridge', () => ({ reportWebviewError: vi.fn() }));
vi.mock('../electron/preload-webview/page-bridge', () => ({ callPageHook: vi.fn(async () => null) }));
vi.mock('../electron/preload-webview/interaction', () => ({ dispatchUserClick: vi.fn() }));

function page(type: 'single' | 'multiple' = 'single', markerOnly = false) {
  const body = new AnswerElement('BODY');
  const root = new AnswerElement('DIV', { id: 'q', qid: '1234', qtype: type === 'single' ? '0' : '1' });
  const hidden = new AnswerElement('INPUT', { id: 'answer1234', type: 'hidden' });
  const markerClass = type === 'single' ? 'num_option' : 'num_option_dx';
  const rows = ['51.2', '51.2μs', '512μs'].map((text, index) => {
    const label = String.fromCharCode(65 + index);
    const marker = new AnswerElement('SPAN', { class: markerClass, data: label }, label);
    const row = markerOnly ? marker : new AnswerElement('DIV', { class: 'answerBg', data: label }, text).append(marker);
    row.setAttribute('id', `opt${label}`); row.setAttribute('qid', '1234');
    // A is already selected: applyAnswerV2 must still reconcile all other options.
    if (index === 0) marker.classList.toggle(type === 'single' ? 'check_answer' : 'check_answer_dx', true);
    return { row, marker, text, label };
  });
  root.append(hidden, ...rows.map(item => item.row)); body.append(root);
  fixture.targets = rows.map(({ row, text, label }) => ({ selector: `#${row.id}`, label, text, value: label }));
  vi.stubGlobal('document', { body, querySelector: (selector: string) => body.querySelector(selector), querySelectorAll: (selector: string) => body.querySelectorAll(selector) });
  vi.stubGlobal('window', { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) });
  vi.stubGlobal('HTMLInputElement', AnswerInput);
  return { rows, hidden, payload: { questionHash: 'q', answer: '51.2', choiceLabels: ['A'], matchedOptions: ['51.2'],
    question: { hash: 'q', question: '等待多久', options: rows.map(row => row.text), optionTargets: fixture.targets, type, selector: '#q' } } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('文字题答案完整填入', () => {
  function textPage(type: 'completion' | 'essay', count = 1) {
    fixture.targets = [];
    const body = new AnswerElement('BODY');
    const root = new AnswerElement('DIV', { id: 'text-question', qid: '1234', qtype: type === 'essay' ? '4' : '2' });
    const fields = Array.from({ length: count }, () => new AnswerTextarea('TEXTAREA', { value: '旧填写' }));
    const hidden = new AnswerInput('INPUT', { id: 'answer1234', type: 'hidden' });
    root.append(hidden, ...fields); body.append(root);
    const doc = { body, defaultView: { Event }, querySelector: (selector: string) => body.querySelector(selector), querySelectorAll: (selector: string) => body.querySelectorAll(selector) };
    fields.forEach(field => Object.assign(field, { ownerDocument: doc }));
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) });
    vi.stubGlobal('HTMLInputElement', AnswerInput);
    vi.stubGlobal('HTMLTextAreaElement', AnswerTextarea);
    return { fields, hidden, doc, question: { hash: 'text', question: '请分析实验结果，写出结论和心得。', type, options: [], selector: '#text-question' } };
  }
  it('简答保留分号、换行、编号和正文中的分析，不只写第一个片段', async () => {
    const test = textPage('essay');
    const answer = '实验结论：VLAN 可以划分广播域，但不能直接实现不同 VLAN 之间的通信；不同 VLAN 之间若要互访，必须借助路由器。\n心得体会：掌握了网络配置。\n1. 结果分析：配置正确；连通性正常。\n2. 检查完成。';
    expect((await applyAnswerV2({ question: test.question, questionHash: 'text', answer, matchedOptions: [] })).success).toBe(true);
    expect(test.fields[0].value).toBe(answer);
    expect(test.hidden.value).toBe(answer);
  });
  it('简答正文含 ## 时仍作为完整答案，不能被当作多个空', async () => {
    const test = textPage('essay'); const answer = '## 实验结论\n网络正常；广播隔离。\n## 心得\n继续检查。';
    await applyAnswerV2({ question: test.question, questionHash: 'text', answer });
    expect(test.fields[0].value).toBe(answer);
  });
  it('单空段落保留逗号、分号、换行和编号', async () => {
    const test = textPage('completion'); const answer = '1. VLAN划分正确；广播隔离。\n2. 连接、配置、验证。';
    await applyAnswerV2({ question: test.question, questionHash: 'text', answer });
    expect(test.fields[0].value).toBe(answer);
  });
  it('多空仍使用 ## 顺序填回，保留各空内部的分号', async () => {
    const test = textPage('completion', 2); const answer = '广播隔离；连接正确##路由互访；检查完成';
    await applyAnswerV2({ question: test.question, questionHash: 'text', answer });
    expect(test.fields.map(field => field.value)).toEqual(['广播隔离；连接正确', '路由互访；检查完成']);
  });
  it('编辑器工具栏的字号文本框不计为答题空格，也不能被覆盖', async () => {
    const test = textPage('completion');
    const font = new AnswerInput('INPUT', { type: 'text', value: '16', name: 'fontSize' });
    Object.assign(font, { ownerDocument: test.doc });
    const root = document.querySelector('#text-question') as unknown as AnswerElement;
    root.append(new AnswerElement('DIV', { class: 'edui-editor-toolbarbox' }).append(font));
    const answer = '广播隔离；路由互访。';
    await applyAnswerV2({ question: test.question, questionHash: 'text', answer });
    expect(test.fields[0].value).toBe(answer);
    expect(font.value).toBe('16');
  });
  it('普通作答弹窗内的输入框仍能完整写入', async () => {
    const test = textPage('essay'); const root = test.doc.body.children[0];
    test.doc.body.children = []; test.doc.body.append(new AnswerElement('DIV', { role: 'dialog' }).append(root));
    const answer = '实验结论完整；心得体会完整。';
    expect((await applyAnswerV2({ question: test.question, questionHash: 'text', answer })).success).toBe(true);
    expect(test.fields[0].value).toBe(answer);
  });
});

describe('选择题填回的选中状态', () => {
  it('单选相似选项只选择唯一目标，隐藏答案与外观一致', async () => {
    const test = page();
    const result = await applyAnswerV2(test.payload);
    expect(result.success).toBe(true);
    expect(test.hidden.value).toBe('A');
    expect(test.rows.map(({ marker }) => marker.classList.contains('check_answer'))).toEqual([true, false, false]);
  });
  it('圆圈样式只落在字母标记上，不污染整行容器', async () => {
    const test = page();
    await applyAnswerV2(test.payload);
    expect(test.rows.every(({ row }) => !row.classList.contains('check_answer'))).toBe(true);
  });
  it('固定选择器可匹配没有保存 value 的数字值选项', async () => {
    const test = page();
    fixture.targets.forEach(target => { delete target.value; });
    test.rows.forEach(({ row }, index) => row.setAttribute('data', String(index + 1)));
    const result = await applyAnswerV2(test.payload);
    expect(result.success).toBe(true);
    expect(test.rows.map(({ marker }) => marker.classList.contains('check_answer'))).toEqual([true, false, false]);
  });
  it('独立字母标记也会清除旧选中状态', async () => {
    const test = page('single', true);
    test.rows[1].marker.classList.toggle('check_answer', true);
    await applyAnswerV2(test.payload);
    expect(test.rows.map(({ marker }) => marker.classList.contains('check_answer'))).toEqual([true, false, false]);
  });
  it('原生 radio 的 value 与字母标记不同，仍按准确节点保持唯一选中', async () => {
    const test = page();
    const inputs = test.rows.map(({ row, label }, index) => {
      const input = new AnswerInput('INPUT', { id: `input${label}`, type: 'radio', value: `option-${label}`, class: 'choice1234', qid: '1234' });
      input.checked = index === 0; row.append(input);
      fixture.targets[index].inputSelector = `#${input.id}`;
      return input;
    });
    expect((await applyAnswerV2(test.payload)).success).toBe(true);
    expect(inputs.map(input => input.checked)).toEqual([true, false, false]);
    expect(test.hidden.value).toBe('A');
    expect(test.rows.map(({ marker }) => marker.classList.contains('check_answer'))).toEqual([true, false, false]);
  });
  it('保留多选题的多个正确选项', async () => {
    const test = page('multiple'); vi.useFakeTimers();
    test.rows[2].marker.classList.toggle('check_answer_dx', true);
    test.payload.choiceLabels = ['A', 'C'];
    const result = applyAnswerV2(test.payload);
    await vi.runAllTimersAsync();
    expect((await result).success).toBe(true);
    expect(test.hidden.value).toBe('AC');
    expect(test.rows.map(({ marker }) => marker.classList.contains('check_answer_dx'))).toEqual([true, false, true]);
  });
});
