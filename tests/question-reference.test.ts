import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWebReference, collectQuestionMedia, readFilledValues, resolveQuestionMediaUrl, webEnhancedQuestionHash } from '../electron/preload-webview/question-reference';
import type { QuestionPayload } from '../electron/preload-webview/types';
import { AnswerElement } from './helpers/answer-dom';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const body = new AnswerElement('BODY');
  const doc = { title: '章节练习', baseURI: 'https://example.test/course/lesson/', querySelectorAll: (selector: string) => body.querySelectorAll(selector) };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { getComputedStyle: (element: AnswerElement) => ({ display: element.attrs.hidden !== undefined ? 'none' : 'block', visibility: 'visible' }) });
  const section = new AnswerElement('SECTION', { id: 'reading-one', 'data-question-group': 'reading-one' });
  const root = new AnswerElement('DIV', { class: 'questionLi', qid: 'q1', qtype: '4' });
  body.append(section.append(root));
  return { body, section, root, doc };
}

describe('Web 参考上下文', () => {
  it('aria-hidden 仅是无障碍标记，可见材料和已填答案仍作为上下文读取', () => {
    const { section, root } = setup();
    section.append(new AnswerElement('H2', { class: 'chapter-title', 'aria-hidden': 'true' }, '交换机实验'),
      new AnswerElement('DIV', { class: 'shared-material', 'aria-hidden': 'true' }, '同一广播域内可以通信。'));
    root.append(new AnswerElement('DIV', { 'aria-hidden': 'true' }).append(new AnswerElement('TEXTAREA', { value: '已有实验结论' })));
    expect(buildWebReference(root as unknown as HTMLElement, 1)).toMatchObject({ chapterTitle: '交换机实验', material: '同一广播域内可以通信。', filledValues: ['已有实验结论'] });
  });

  it('普通作答弹窗内读取真实旧答，仅排编辑器自身的工具弹窗', () => {
    const { body, root } = setup();
    body.children = []; body.append(new AnswerElement('DIV', { role: 'dialog' }).append(root));
    root.append(new AnswerElement('TEXTAREA', { value: '真实旧答' }),
      new AnswerElement('DIV', { class: 'edui-dialog' }).append(new AnswerElement('INPUT', { type: 'text', value: '上传参数' })));
    expect(readFilledValues(root as unknown as HTMLElement)).toEqual(['真实旧答']);
  });
  it('编辑器内部无题目标识的 question 包装器不遮挡同源 iframe 旧答案', () => {
    const { root } = setup();
    const frame = new AnswerElement('IFRAME');
    Object.assign(frame, { contentDocument: { designMode: 'on', body: new AnswerElement('BODY', {}, '完整旧实验结论') } });
    root.append(new AnswerElement('DIV', { class: 'edui-editor' }).append(new AnswerElement('DIV', { class: 'question' }).append(frame)));
    expect(readFilledValues(root as unknown as HTMLElement)).toEqual(['完整旧实验结论']);
  });
  it('只把真实编辑内容作为旧答案参考，排除工具栏字号输入', () => {
    const { root } = setup();
    root.append(new AnswerElement('DIV', { class: 'edui-editor' }).append(
      new AnswerElement('DIV', { class: 'edui-editor-toolbarbox' }).append(new AnswerElement('INPUT', { type: 'text', name: 'fontSize', value: '16' })),
      new AnswerElement('DIV', { contenteditable: 'true' }, '原实验结论')
    ));
    expect(readFilledValues(root as unknown as HTMLElement)).toEqual(['原实验结论']);
  });
  it('已有题号时不扫描同组全部题目计算备用序号', () => {
    const { section, root } = setup();
    const scan = vi.spyOn(section, 'querySelectorAll');
    expect(buildWebReference(root as unknown as HTMLElement, 1).sourceQuestionId).toBe('q1');
    expect(scan.mock.calls.some(([selector]) => selector.includes('.questionLi'))).toBe(false);
  });
  it('读取题目内可见编辑值，排除页面外、隐藏和认证字段', () => {
    const { body, root } = setup();
    body.append(new AnswerElement('TEXTAREA', { value: '别的题目答案' }));
    root.append(
      new AnswerElement('TEXTAREA', { value: '已写论述' }, '默认内容不应代替 value'),
      new AnswerElement('INPUT', { type: 'text', name: 'blank1', value: '填空答案' }),
      new AnswerElement('INPUT', { type: 'hidden', value: 'csrf-secret' }),
      new AnswerElement('INPUT', { type: 'password', value: 'password-secret' }),
      new AnswerElement('INPUT', { type: 'text', name: 'authToken', value: 'token-secret' }),
      new AnswerElement('DIV', { hidden: '' }).append(new AnswerElement('TEXTAREA', { value: '不可见答案' })),
      new AnswerElement('DIV', { contenteditable: 'true' }, '富文本答案')
    );
    const frame = new AnswerElement('IFRAME');
    Object.assign(frame, { contentDocument: { designMode: 'on', body: new AnswerElement('BODY', {}, '同源编辑器答案') } });
    const inaccessibleFrame = new AnswerElement('IFRAME');
    Object.defineProperty(inaccessibleFrame, 'contentDocument', { get: () => { throw new Error('cross origin'); } });
    root.append(frame, inaccessibleFrame);
    expect(readFilledValues(root as unknown as HTMLElement)).toEqual(['已写论述', '填空答案', '富文本答案', '同源编辑器答案']);
  });

  it('只读取最近分组的标题与公共材料，不读取整页或相邻题目', () => {
    const { body, section, root } = setup();
    section.append(new AnswerElement('H2', { class: 'chapter-title' }, '第三章'), new AnswerElement('H3', { class: 'section-title' }, '阅读理解'));
    const material = new AnswerElement('DIV', { class: 'shared-material' }, '公共阅读材料。');
    material.append(new AnswerElement('TEXTAREA', { value: '不属于材料' }, '不应泄漏的默认答案'));
    section.append(material);
    body.append(new AnswerElement('SECTION').append(new AnswerElement('H3', { class: 'section-title' }, '另一个分组'), new AnswerElement('DIV', { class: 'shared-material' }, '别组材料')));
    section.append(new AnswerElement('DIV', { class: 'questionLi' }).append(new AnswerElement('DIV', { class: 'material' }, '相邻题私有材料')));
    const reference = buildWebReference(root as unknown as HTMLElement, 1);
    expect(reference).toMatchObject({ pageTitle: '章节练习', chapterTitle: '第三章', sectionTitle: '阅读理解', sourceQuestionId: 'q1', material: '公共阅读材料。', filledValues: [] });
    root.append(new AnswerElement('TEXTAREA', { value: '新的答案' }));
    expect(buildWebReference(root as unknown as HTMLElement, 1).groupKey).toBe(reference.groupKey);
  });

  it('最近题组缺少标题或材料时，不向外读取应用包装器的同名节点', () => {
    const { body, section, root } = setup();
    const outer = new AnswerElement('DIV', { id: 'app' }).append(
      new AnswerElement('H2', { class: 'chapter-title' }, '应用导航章节'),
      new AnswerElement('H3', { class: 'section-title' }, '其他区域标题'),
      new AnswerElement('DIV', { class: 'material' }, '外层不相关材料'), section
    );
    body.children = []; body.append(outer);
    const reference = buildWebReference(root as unknown as HTMLElement, 1);
    expect(reference.chapterTitle).toBeUndefined(); expect(reference.sectionTitle).toBeUndefined(); expect(reference.material).toBeUndefined();
  });

  it('无 qid 题目的来源序号仅在当前题组计数，分组键不依赖 DOM 位置', () => {
    const { body, section, root } = setup();
    root.removeAttribute('qid');
    const first = buildWebReference(root as unknown as HTMLElement, 1);
    const other = new AnswerElement('SECTION', { 'data-question-group': 'other' }).append(new AnswerElement('DIV', { class: 'questionLi' }, '前面的其他题目'));
    body.children.unshift(other); other.parentElement = body;
    const second = buildWebReference(root as unknown as HTMLElement, 99);
    expect(second.sourceQuestionId).toBe('index:1'); expect(second.groupKey).toBe(first.groupKey);
    section.removeAttribute('id');
    const withoutId = buildWebReference(root as unknown as HTMLElement, 99);
    expect(withoutId.groupKey).toBe(first.groupKey);
  });
});

describe('题目媒体描述', () => {
  it('解析懒加载相对路径并按实际选项和材料分类，忽略页面图标及答案图片', () => {
    const { body, section, root } = setup();
    const image = new AnswerElement('IMG', { 'data-src': '../images/stem.png', alt: '题干图', width: '240', height: '120' });
    const option = new AnswerElement('LABEL', { id: 'opt-b' }, 'B.').append(new AnswerElement('IMG', { src: '/options/b.png' }));
    root.append(image, option, new AnswerElement('DIV', { class: 'toolbar' }).append(new AnswerElement('IMG', { src: '/icon.png' })), new AnswerElement('DIV', { contenteditable: 'true' }).append(new AnswerElement('IMG', { src: '/answer.png' })));
    section.append(new AnswerElement('DIV', { class: 'shared-material' }).append(new AnswerElement('IMG', { src: '/material.png' })));
    body.append(new AnswerElement('IMG', { src: '/outside.png' }));
    const media = collectQuestionMedia(root as unknown as HTMLElement, [{ element: option as unknown as HTMLElement, label: 'B' }]);
    expect(media).toHaveLength(3);
    expect(media[0]).toMatchObject({ role: 'stem', sourceUrl: 'https://example.test/course/images/stem.png', alt: '题干图', width: 240, height: 120, status: 'discovered' });
    expect(media[1]).toMatchObject({ role: 'option', optionLabel: 'B', sourceUrl: 'https://example.test/options/b.png' });
    expect(media[2].role).toBe('material');
  });

  it('优先使用 picture 已选出的 currentSrc，为 SVG/canvas 提供截图描述', () => {
    const { root } = setup();
    const image = new AnswerElement('IMG', { src: '/fallback.png' });
    Object.assign(image, { currentSrc: 'https://example.test/retina.png' });
    root.append(new AnswerElement('PICTURE').append(image), new AnswerElement('SVG', { 'aria-label': '向量图' }), new AnswerElement('CANVAS'));
    expect(resolveQuestionMediaUrl(image as unknown as Element)).toBe('https://example.test/retina.png');
    expect(collectQuestionMedia(root as unknown as HTMLElement).slice(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'stem', alt: '向量图', status: 'discovered', reason: expect.stringContaining('SVG'), selector: expect.any(String) }),
      expect.objectContaining({ role: 'stem', status: 'discovered', reason: expect.stringContaining('CANVAS') })
    ]));
  });

  it('使用懒加载真实地址，避免把 currentSrc 中的占位图当作题目图片', () => {
    setup();
    const image = new AnswerElement('IMG', { src: '/loading.gif', 'data-original': '../real-question.png' });
    Object.assign(image, { currentSrc: 'https://example.test/loading.gif', src: 'https://example.test/loading.gif' });
    expect(resolveQuestionMediaUrl(image as unknown as Element)).toBe('https://example.test/course/real-question.png');
  });
});

describe('Web 增强题目键', () => {
  it('保留同题干的不同来源与章节，同时忽略全局序号、填入答案和上传状态', () => {
    setup();
    const question: QuestionPayload = { hash: '', question: '题干相同？', options: ['A. 甲', 'B. 乙'], index: 1, webReference: { pageTitle: '练习', groupKey: 'first', sourceQuestionId: 'one', filledValues: ['旧答案'] }, media: [{ id: 'img', role: 'stem', sourceUrl: 'https://example.test/q.png', alt: '', status: 'discovered' }] };
    const hash = webEnhancedQuestionHash(question);
    expect(webEnhancedQuestionHash({ ...question, webReference: { ...question.webReference!, filledValues: ['新答案'] }, media: [{ ...question.media![0], status: 'ready', contentDigest: 'uploaded', reason: '已上传' }] })).toBe(hash);
    expect(webEnhancedQuestionHash({ ...question, index: 2 })).toBe(hash);
    expect(webEnhancedQuestionHash({ ...question, webReference: { ...question.webReference!, sourceQuestionId: 'two' } })).not.toBe(hash);
    expect(webEnhancedQuestionHash({ ...question, webReference: { ...question.webReference!, groupKey: 'second' } })).not.toBe(hash);
  });
});
