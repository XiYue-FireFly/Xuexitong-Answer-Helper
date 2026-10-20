import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractQuestions, inferTypeFromDom, isQuestionMetadataOnly, isQuestionRootTextNoise } from '../electron/preload-webview/question-extractor';
import { AnswerElement } from './helpers/answer-dom';

afterEach(() => vi.unstubAllGlobals());

vi.mock('../electron/preload-webview/font-decode', () => ({ decodeFontTextSync: (text: string) => text.replace(/\ue001/g, '文') }));

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

class CaptureElement extends AnswerElement {
  get childNodes() { return this.children; }
  override cloneNode(): CaptureElement {
    return new CaptureElement(this.tagName, { ...this.attrs }, this.text).append(...this.children.map((child) => child.cloneNode()));
  }
}

function capturePage() {
  const body = new CaptureElement('BODY');
  const doc = { title: '练习页面', baseURI: 'https://example.test/chapter/', body, querySelectorAll: (selector: string) => body.querySelectorAll(selector), querySelector: (selector: string) => body.querySelector(selector) };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('HTMLElement', CaptureElement);
  vi.stubGlobal('window', { location: { href: doc.baseURI }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
  const section = new CaptureElement('SECTION', { 'data-question-group': 'first', id: 'first' });
  section.append(new CaptureElement('H2', { class: 'section-title' }, '第一部分'));
  body.append(section);
  return { body, section };
}

function choiceRoot(id: string, stem = '请选择正确的答案？') {
  return new CaptureElement('DIV', { class: 'questionLi', id, qid: id, qtype: '0' }).append(
    new CaptureElement('DIV', { class: 'question-title' }, stem),
    new CaptureElement('LABEL', { id: `${id}-a` }, 'A. Apple').append(new CaptureElement('INPUT', { type: 'radio', value: 'A' })),
    new CaptureElement('LABEL', { id: `${id}-b` }, 'B. Banana').append(new CaptureElement('INPUT', { type: 'radio', value: 'B' }))
  );
}

describe('Web 增强抓取', () => {
  it('超星可见题干和选项的 aria-hidden 无障碍标记不能导致已答选择判断题漏抓', () => {
    const { section } = capturePage();
    for (const [id, qtype, stem, answers] of [
      ['accessible-choice', '0', '请选择正确的网络地址？', ['网络地址一', '网络地址二']],
      ['accessible-judge', '3', '不同网段需要通过路由通信。', ['对', '错']]
    ] as const) {
      const root = new CaptureElement('DIV', { class: 'questionLi', id, data: id });
      root.append(new CaptureElement('H3', { class: 'mark_name', 'aria-hidden': 'true' }, stem),
        new CaptureElement('INPUT', { type: 'hidden', name: 'answer' + id, value: 'A' }));
      answers.forEach((answer, index) => root.append(
        new CaptureElement('DIV', { class: 'answerBg', role: 'radio', qid: id, qtype, 'aria-checked': index === 0 ? 'true' : 'false' }).append(
          new CaptureElement('SPAN', { class: 'num_option', data: index === 0 ? 'A' : 'B', 'aria-hidden': 'true' }, index === 0 ? 'A ' : 'B '),
          new CaptureElement('DIV', { class: 'answer_p', 'aria-hidden': 'true' }, answer)
        )
      ));
      section.append(root);
    }
    const questions = extractQuestions({ webEnhanced: true });
    expect(questions.map(item => [item.selector, item.type])).toEqual([['#accessible-choice', 'single'], ['#accessible-judge', 'judgement']]);
    expect(questions[0].question).toBe('请选择正确的网络地址？');
    expect(questions[0].options).toEqual(['A. 网络地址一', 'B. 网络地址二']);
    expect(questions[1].options).toEqual(['A. 对', 'B. 错']);
  });

  it('aria-hidden 可见题干图片仍提取，但真正由 CSS 隐藏的题干副本必须排除', () => {
    const { section } = capturePage();
    window.getComputedStyle = ((element: HTMLElement) => ({ display: element.getAttribute('style') === 'display: none' ? 'none' : 'block', visibility: 'visible' })) as typeof window.getComputedStyle;
    const root = choiceRoot('accessible-media');
    root.children[0].attrs['aria-hidden'] = 'true';
    root.children[0].append(new CaptureElement('IMG', { src: '/visible-stem.png' }));
    const hiddenTitle = new CaptureElement('DIV', { class: 'mark_name', 'aria-hidden': 'true', style: 'display: none' }, '不可见重复题干').append(new CaptureElement('IMG', { src: '/hidden-stem.png' }));
    root.children.unshift(hiddenTitle); hiddenTitle.parentElement = root;
    section.append(root);
    const question = extractQuestions({ webEnhanced: true })[0];
    expect(question.question).toBe('请选择正确的答案？');
    expect(question.media?.map(item => item.sourceUrl)).toEqual(['https://example.test/visible-stem.png']);
  });

  it('普通作答弹窗中的真实题目仍完整抓取，不能当成编辑器工具弹窗', () => {
    const { body, section } = capturePage();
    section.append(choiceRoot('dialog-choice'));
    const dialog = new CaptureElement('DIV', { role: 'dialog' }).append(section);
    body.children = []; body.append(dialog);
    expect(extractQuestions({ webEnhanced: true }).map(item => item.selector)).toEqual(['#dialog-choice']);
  });
  it('富文本编辑器内部的 question/title/content 不能吞掉真实题干和同页已答题', () => {
    const { section } = capturePage();
    const choice = choiceRoot('answered-choice');
    choice.querySelector('input')!.checked = true;
    const essay = new CaptureElement('DIV', { class: 'questionLi', id: 'report', qid: 'report', qtype: '4' });
    essay.append(new CaptureElement('DIV', { class: 'mark_name' }, '请你分析实验结果，论述实验结论，并写出心得体会。'));
    const editor = new CaptureElement('DIV', { class: 'edui-editor' }).append(
      new CaptureElement('DIV', { class: 'question', id: 'editor-ui' }).append(
        new CaptureElement('DIV', { class: 'title' }, '段落格式字体字号点击上传x'),
        new CaptureElement('DIV', { class: 'content' }, '段落格式字体字号点击上传x'),
        new CaptureElement('INPUT', { type: 'text', value: '字号' }),
        new CaptureElement('TEXTAREA', { value: '旧实验结论' }),
        new CaptureElement('IMG', { src: '/editor-button.png' })
      )
    );
    essay.append(editor); section.append(choice, essay);
    const questions = extractQuestions({ webEnhanced: true });
    expect(questions.map(item => [item.selector, item.type])).toEqual([['#answered-choice', 'single'], ['#report', 'essay']]);
    expect(questions[1].question).toBe('请你分析实验结果，论述实验结论，并写出心得体会。');
    expect(questions[1].media).toEqual([]);
    const firstHash = questions[1].hash;
    editor.querySelector('.title')!.text = '字体段落格式新按钮';
    expect(extractQuestions({ webEnhanced: true })[1].hash).toBe(firstHash);
  });

  it('同一作业完整提取只有本地题型元数据的单选、多选、判断、填空和问答，包含已填题', () => {
    const { section } = capturePage();
    const single = choiceRoot('single'); single.attrs.class = ''; single.children[0].attrs.class = 'TiMu';
    const multiple = choiceRoot('multiple'); multiple.attrs.class = ''; multiple.attrs.qtype = '1';
    delete multiple.attrs.qid;
    multiple.querySelectorAll('input').forEach(input => { input.attrs.type = 'checkbox'; });
    const judgement = new CaptureElement('DIV', { id: 'judge', qtype: '3' }).append(
      new CaptureElement('DIV', { class: 'question-title' }, '以太网使用载波侦听机制。'),
      new CaptureElement('LABEL', {}, '正确').append(new CaptureElement('INPUT', { type: 'radio', value: 'true' })),
      new CaptureElement('LABEL', {}, '错误').append(new CaptureElement('INPUT', { type: 'radio', value: 'false' }))
    );
    const completion = new CaptureElement('DIV', { id: 'fill', qtype: '2' }).append(
      new CaptureElement('DIV', { class: 'question-title' }, '网线接线标准为____。'), new CaptureElement('TEXTAREA', { value: '568B' })
    );
    const essay = new CaptureElement('DIV', { id: 'essay', qtype: '4' }).append(
      new CaptureElement('DIV', { class: 'question-title' }, '请写出实验结论。'), new CaptureElement('TEXTAREA', { value: '原结论' })
    );
    section.append(single, multiple, judgement, completion, essay);
    const questions = extractQuestions({ webEnhanced: true });
    expect(questions.map(item => item.type)).toEqual(['single', 'multiple', 'judgement', 'completion', 'essay']);
    expect(questions.map(item => item.index)).toEqual([1, 2, 3, 4, 5]);
    expect(questions[0].options).toEqual(['A. Apple', 'B. Banana']);
    expect(questions[2].options).toEqual(['A. 正确', 'B. 错误']);
    expect(questions[3].webReference?.filledValues).toEqual(['568B']);
  });

  it('没有标准题目 class 的题块按本地 type 输入及选择控件补抓，不能只补抓填空', () => {
    const { body, section } = capturePage();
    const single = choiceRoot('typed'); delete single.attrs.class; delete single.attrs.qid; delete single.attrs.qtype;
    single.children[0].attrs.class = 'TiMu';
    single.append(new CaptureElement('INPUT', { type: 'hidden', name: 'typetyped', value: '0' }));
    const judgement = new CaptureElement('ARTICLE', { id: 'bool' }).append(
      new CaptureElement('DIV', { class: 'question-title' }, '判断题：实验步骤正确。'),
      new CaptureElement('SPAN', { role: 'radio', value: 'true' }, '对'),
      new CaptureElement('SPAN', { role: 'radio', value: 'false' }, '错')
    );
    section.append(single, judgement);
    body.append(new CaptureElement('NAV').append(new CaptureElement('LABEL', {}, '界面模式').append(new CaptureElement('INPUT', { type: 'radio', value: 'dark' }))));
    const questions = extractQuestions({ webEnhanced: true });
    expect(questions.map(item => item.type)).toEqual(['single', 'judgement']);
    expect(questions[0].options).toEqual(['A. Apple', 'B. Banana']);
    expect(questions[1].options).toEqual(['A. 对', 'B. 错']);
  });

  it('通用 question 包装器内的本地 qtype 题块仍逐题恢复，不能整体当成一道题', () => {
    const { section } = capturePage(); section.attrs.class = 'question';
    const first = choiceRoot('bare-first'); delete first.attrs.class; delete first.attrs.qid;
    const second = choiceRoot('bare-second'); delete second.attrs.class; delete second.attrs.qid;
    second.attrs.qtype = '3';
    section.append(first, second);
    expect(extractQuestions({ webEnhanced: true }).map(item => [item.selector, item.type])).toEqual([
      ['#bare-first', 'single'], ['#bare-second', 'judgement']
    ]);
  });

  it('聚合 content 包装器不能遮挡其中多道仅带 hidden type 的作业题', () => {
    const { section } = capturePage(); section.attrs.class = 'question';
    const wrapper = new CaptureElement('DIV', { class: 'content' });
    for (const id of ['wrapped-one', 'wrapped-two']) {
      const root = choiceRoot(id); delete root.attrs.class; delete root.attrs.qid; delete root.attrs.qtype;
      root.append(new CaptureElement('INPUT', { type: 'hidden', name: 'type' + id, value: '0' }));
      wrapper.append(root);
    }
    section.append(wrapper);
    expect(extractQuestions({ webEnhanced: true }).map(item => item.selector)).toEqual(['#wrapped-one', '#wrapped-two']);
  });

  it('作业含 singleQuestionDiv 时仍合并其他题目容器，不提前只返回其中一道', () => {
    const { section } = capturePage();
    const single = choiceRoot('first'); single.attrs.class = 'singleQuestionDiv';
    const fill = new CaptureElement('DIV', { class: 'questionLi', qtype: '2', id: 'second' }).append(
      new CaptureElement('DIV', { class: 'question-title' }, '实验名称____。'), new CaptureElement('TEXTAREA')
    );
    section.append(single, fill);
    expect(extractQuestions({ webEnhanced: true }).map(item => item.type)).toEqual(['single', 'completion']);
  });

  it('题组包装器不吞并内部不同题型，旧版 TiMu 题干也不遮挡完整选择题', () => {
    const { section } = capturePage();
    section.attrs.class = 'question';
    const single = choiceRoot('nested'); single.children[0].attrs.class = 'TiMu';
    const judgement = new CaptureElement('DIV', { class: 'question-item', qid: 'judge', qtype: '3' }).append(
      new CaptureElement('DIV', { class: 'question-title' }, '判断题：网络连接正常。'),
      new CaptureElement('INPUT', { type: 'radio', value: 'true' }), new CaptureElement('INPUT', { type: 'radio', value: 'false' })
    );
    section.append(single, judgement);
    const questions = extractQuestions({ webEnhanced: true });
    expect(questions.map(item => item.type)).toEqual(['single', 'judgement']);
    expect(questions[0].options).toEqual(['A. Apple', 'B. Banana']);
    expect(questions[0].selector).toBe('#nested');
  });

  it('选项内的 content 或 title 不能被补抓成题干并替代完整题目', () => {
    const { section } = capturePage();
    const root = new CaptureElement('DIV', { class: 'questionLi', id: 'options-content', qid: 'options-content', qtype: '0' }).append(
      new CaptureElement('DIV', { class: 'mark_name' }, '请选择网络实验的正确步骤？'),
      new CaptureElement('DIV', { class: 'answer-options', id: 'answer-options' }).append(
        new CaptureElement('LABEL', {}, 'A.').append(new CaptureElement('INPUT', { type: 'radio', value: 'A' }), new CaptureElement('SPAN', { class: 'content' }, '连接网线')),
        new CaptureElement('LABEL', {}, 'B.').append(new CaptureElement('INPUT', { type: 'radio', value: 'B' }), new CaptureElement('SPAN', { class: 'title' }, '断开网线'))
      )
    );
    section.append(root);
    const questions = extractQuestions({ webEnhanced: true });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ question: '请选择网络实验的正确步骤？', selector: '#options-content', type: 'single' });
    expect(questions[0].options).toEqual(['A. 连接网线', 'B. 断开网线']);
  });

  it('TiMu 内隐藏 type 元数据不能把题干包装器恢复成无选项的伪题', () => {
    const { section } = capturePage();
    const root = choiceRoot('old-type'); root.children[0].attrs.class = 'TiMu';
    root.children[0].append(new CaptureElement('DIV', { class: 'Zy_TItleTxt' }, '请选择正确网络实验步骤？'), new CaptureElement('INPUT', { type: 'hidden', name: 'typeold-type', value: '0' }));
    section.append(root);
    const questions = extractQuestions({ webEnhanced: true });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ selector: '#old-type', type: 'single' });
    expect(questions[0].options).toEqual(['A. Apple', 'B. Banana']);
  });

  it('默认接口保留原去重行为，增强模式保留相同题干的独立题目', () => {
    const { section } = capturePage();
    section.append(choiceRoot('one'), choiceRoot('two'));
    const legacy = extractQuestions();
    const explicitLegacy = extractQuestions({ webEnhanced: false });
    expect(legacy).toHaveLength(1);
    expect(explicitLegacy.map(({ id: _id, capturedAt: _time, ...question }) => question)).toEqual(legacy.map(({ id: _id, capturedAt: _time, ...question }) => question));
    expect(legacy[0].webReference).toBeUndefined();
    const enhanced = extractQuestions({ webEnhanced: true });
    expect(enhanced).toHaveLength(2);
    expect(enhanced[0].hash).not.toBe(enhanced[1].hash);
    expect(enhanced[0].options).toEqual(['A. Apple', 'B. Banana']);
  });

  it('读取已填答案但不会把答案放入题干或改变解码后的增强键', () => {
    const { section } = capturePage();
    const root = new CaptureElement('DIV', { class: 'questionLi', id: 'essay', qid: 'essay', qtype: '4' });
    const answer = new CaptureElement('DIV', { contenteditable: 'true' }, '最初答案');
    root.append(new CaptureElement('DIV', { class: 'question-title' }, '\ue001章分析题。').append(answer));
    section.append(root);
    const first = extractQuestions({ webEnhanced: true })[0];
    expect(first.question).toBe('文章分析题。');
    expect(first.webReference?.filledValues).toEqual(['最初答案']);
    answer.text = '后来填入的新答案';
    const second = extractQuestions({ webEnhanced: true })[0];
    expect(second.question).toBe(first.question);
    expect(second.hash).toBe(first.hash);
    expect(second.webReference?.filledValues).toEqual(['后来填入的新答案']);
    expect(second.type).toBe('essay');
  });

  it('接受纯图片题干和纯图片选项，并将图片对应到正确的选项标签', () => {
    const { body, section } = capturePage();
    const root = new CaptureElement('DIV', { class: 'questionLi', id: 'picture', qid: 'picture', qtype: '0' });
    root.append(
      new CaptureElement('DIV', { class: 'mark_name' }).append(new CaptureElement('IMG', { src: '/stem.png' })),
      new CaptureElement('LABEL', { id: 'picture-a' }, 'A.').append(new CaptureElement('INPUT', { type: 'radio', value: 'A' }), new CaptureElement('IMG', { 'data-src': '/a.png' })),
      new CaptureElement('LABEL', { id: 'picture-b' }, 'B.').append(new CaptureElement('INPUT', { type: 'radio', value: 'B' }), new CaptureElement('IMG', { src: '/b.png' }))
    );
    section.append(root);
    body.append(new CaptureElement('IMG', { src: '/logo.png' }));
    const question = extractQuestions({ webEnhanced: true })[0];
    expect(question.question).toContain('[图片题干');
    expect(question.options).toEqual(['A. [图片选项 A]', 'B. [图片选项 B]']);
    expect(question.media).toHaveLength(3);
    expect(question.media?.map((media) => [media.role, media.optionLabel])).toEqual([['stem', undefined], ['option', 'A'], ['option', 'B']]);
    expect(extractQuestions({ webEnhanced: true })[0].hash).toBe(question.hash);
  });

  it('保留旧版 TiMu 题干节点中的图片，而不将其当成另一个嵌套题目', () => {
    const { section } = capturePage();
    const root = choiceRoot('old-layout');
    root.children[0].attrs.class = 'TiMu';
    root.children[0].append(new CaptureElement('IMG', { src: '/old-stem.png' }));
    section.append(root);
    expect(extractQuestions({ webEnhanced: true })[0].media).toEqual([
      expect.objectContaining({ role: 'stem', sourceUrl: 'https://example.test/old-stem.png' })
    ]);
  });

  it('恢复带本地 qtype=2 的独立填空编辑器，排除填写值且填入后键稳定', () => {
    const { section } = capturePage();
    const field = new CaptureElement('TEXTAREA', { value: '旧答案' });
    const root = new CaptureElement('DIV', { qtype: '2' }).append(new CaptureElement('DIV', { class: 'question-title' }, '请填写实验名称：____。'), field);
    section.append(root);
    expect(extractQuestions()[0].webReference).toBeUndefined();
    const first = extractQuestions({ webEnhanced: true })[0];
    expect(first).toMatchObject({ type: 'completion', question: '请填写实验名称：____。', webReference: { filledValues: ['旧答案'] } });
    field.value = '新答案';
    expect(extractQuestions({ webEnhanced: true })[0].hash).toBe(first.hash);
  });

  it('混合题目选择器按 DOM 顺序返回，带 qid 的键不受其他题目插入影响', () => {
    const { section } = capturePage();
    const earlier = choiceRoot('early'); earlier.attrs.class = 'question-item';
    const later = choiceRoot('late');
    section.append(earlier, later);
    const first = extractQuestions({ webEnhanced: true });
    expect(first.map((question) => question.webReference?.sourceQuestionId)).toEqual(['early', 'late']);
    const inserted = choiceRoot('inserted'); section.children.unshift(inserted); inserted.parentElement = section;
    const after = extractQuestions({ webEnhanced: true });
    expect(after.find((question) => question.webReference?.sourceQuestionId === 'late')?.hash).toBe(first[1].hash);
  });

  it('保留仅有 true/false 原生 radio 的判断语义', () => {
    const { section } = capturePage();
    section.append(new CaptureElement('DIV', { class: 'questionLi', qid: 'judgement', qtype: '3' }).append(
      new CaptureElement('DIV', { class: 'question-title' }, '该实验结论正确吗？'),
      new CaptureElement('INPUT', { type: 'radio', value: 'true' }),
      new CaptureElement('INPUT', { type: 'radio', value: 'false' })
    ));
    expect(extractQuestions({ webEnhanced: true })[0]).toMatchObject({ type: 'judgement', options: ['A. 对', 'B. 错'] });
  });
});
