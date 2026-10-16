import type { QuestionOptionTarget, QuestionPayload, QuestionType } from './types';
import { parseJudgementValueStable } from './answer-matcher';
import { cleanText, cssEscape, hashText, isVisible, normalizeText, optionLabel, optionLetter, optionTextCandidate, removeNoise, selectorFor, uniqueBy, visibleText } from './dom-utils';
import { decodeFontTextSync } from './font-decode';

type ExtractedQuestion = QuestionPayload & {
  id: string;
  optionTargets: QuestionOptionTarget[];
  type: QuestionType;
  source: string;
  pageUrl: string;
  pageTitle: string;
  capturedAt: number;
};

export const QUESTION_CONTAINER_SELECTORS = [
  '.questionLi',
  '[data-question]',
  '[data-sp-question]',
  '[qid][qtype]',
  '[questionid][qtype]',
  '.question',
  '.question-item',
  '.subject-item',
  '.exam-question',
  '.singleQuestionDiv',
  '.timu',
  '.TiMu',
  '.CeSheng',
  '.questionCard'
];

export const TITLE_SELECTORS = [
  '[data-question-title]',
  '.question-title',
  '.mark_name',
  '.timu-title',
  '.CeSheng_title',
  '.Zy_TItle',
  '.Zy_TItleTxt',
  '.TiMu',
  '.stem',
  '.subject-title',
  '.title',
  '.q-text',
  '.content'
];

export const OPTION_SELECTORS = [
  '.answerBg',
  '.singleoption',
  '.stem_answer > .answerBg',
  '.answerCon',
  '.ans-item',
  '.option',
  '.optionItem',
  '.option-item',
  '.options-item',
  '.optionBox',
  '.option-box',
  '.choiceOption',
  '.choice-option',
  '.option-item',
  '.choice',
  '.choice-item',
  '.answerItem',
  '.answer-item',
  '.checkOption',
  '.check-option',
  '.radio',
  '.radio-box',
  '.xuanxiang',
  '.CeSheng_option',
  '[data-option]',
  '[data][qid]',
  '[role="radio"]',
  '[role="checkbox"]',
  'label',
  'li'
];

const TEXT_ENTRY_SELECTORS = 'textarea, input[type="text"], input:not([type]), [contenteditable="true"]';
const QUESTION_ROOT_SELECTOR = [
  '.questionLi', '[data-question]', '[data-sp-question]', '[qid][qtype]',
  '[questionid][qtype]', '.question', '.question-item', '.subject-item',
  '.exam-question', '.singleQuestionDiv', '.timu', '.TiMu', '.CeSheng', '.questionCard'
].join(',');

export function readQuestionTypeHint(root: HTMLElement) {
  const qid = root.getAttribute('qid') ||
    root.getAttribute('questionid') ||
    root.getAttribute('data') ||
    root.querySelector('[qid]')?.getAttribute('qid') ||
    root.querySelector('[questionid]')?.getAttribute('questionid') ||
    root.querySelector('input[name="questionId"]')?.getAttribute('value') ||
    '';
  const directQtype = root.getAttribute('qtype') || root.querySelector('[qtype]')?.getAttribute('qtype') || '';
  const inputValue = (selector: string) => root.querySelector<HTMLInputElement>(selector)?.value || '';
  const typedValue = qid ? inputValue(`input[name="type${cssEscape(qid)}"]`) : '';
  const typedName = qid ? inputValue(`input[name="typeName${cssEscape(qid)}"]`) : '';
  let fallbackType = '';
  let fallbackTypeName = '';

  for (const input of Array.from(root.querySelectorAll<HTMLInputElement>('input[name]'))) {
    const name = input.name || '';
    if (!fallbackTypeName && /^typeName/i.test(name)) fallbackTypeName = input.value || '';
    if (!fallbackType && /^type(?!Name)/i.test(name)) fallbackType = input.value || '';
    if (fallbackType && fallbackTypeName) break;
  }

  const heading = root.querySelector('.colorShallow, .mark_name, .typeName, .question-type') as HTMLElement | null;
  return {
    qtype: cleanText(directQtype || typedValue || fallbackType),
    typeName: cleanText(typedName || fallbackTypeName || (heading ? visibleText(heading) : '')),
    qid
  };
}

export function inferTypeFromDom(root: HTMLElement, options: string[]): QuestionType {
  const hint = readQuestionTypeHint(root);
  const qtype = hint.qtype;
  // Site metadata is authoritative; shared marker classes are only a fallback.
  const explicitTypes: Record<string, QuestionType> = { '0': 'single', '1': 'multiple', '21': 'multiple', '2': 'completion', '3': 'judgement', '4': 'essay' };
  if (explicitTypes[qtype]) return explicitTypes[qtype];
  if (/判断题/.test(hint.typeName)) return 'judgement';
  if (/多选题|多项选择/.test(hint.typeName)) return 'multiple';
  if (/单选题|单项选择/.test(hint.typeName)) return 'single';
  if (/填空题/.test(hint.typeName)) return 'completion';
  if (/问答题|简答题|论述题|作文题|资料题|材料题|综合题/.test(hint.typeName)) return 'essay';
  const radios = root.querySelectorAll('input[type="radio"]').length;
  const checkboxes = root.querySelectorAll('input[type="checkbox"]').length;
  const textareas = root.querySelectorAll('textarea').length;
  const textInputs = root.querySelectorAll('input[type="text"], input:not([type])').length;
  const text = visibleText(root);
  const typeText = `${hint.typeName} ${text}`;
  const hasMultipleMarker = Boolean(root.querySelector('.num_option_dx, [role="checkbox"], input[type="checkbox"]'));
  const hasSingleMarker = Boolean(root.querySelector('.num_option, [role="radio"], input[type="radio"]'));
  const textEntryElements = Array.from(root.querySelectorAll(TEXT_ENTRY_SELECTORS)) as HTMLElement[];
  const hasCompletionEditor = textEntryElements.some((element) => {
    const metadata = [
      element.className,
      element.id,
      element.getAttribute('name'),
      element.getAttribute('data-type'),
      element.getAttribute('placeholder'),
      element.parentElement?.className
    ].filter(Boolean).join(' ');
    return /blank|fill|completion|cloze|填空/i.test(metadata);
  });
  const hasCompletionCue = qtype === '2' || /填空题|填空|第\s*\d+\s*空|_{2,}|\bblank\s*\d+/i.test(typeText) || hasCompletionEditor;
  const hasRichTextEditor = textEntryElements.some((element) =>
    element.matches('[contenteditable="true"]') && !hasCompletionEditor
  );

  // Text-entry semantics must win over generic `li` option extraction. A
  // material/essay question often contains ordered list items, which should
  // never turn a textarea-based question into a single-choice question.
  if (textEntryElements.length > 0 && hasCompletionCue) return 'completion';
  if (qtype === '4' || /问答题|简答题|论述题|作文题|资料题|材料题|综合题/i.test(typeText)) return 'essay';
  if (qtype === '1' || hasMultipleMarker || checkboxes > 0 || /\u591a\u9009\u9898|\u591a\u9879\u9009\u62e9|\u591a\u9009/.test(typeText)) return 'multiple';
  if (qtype === '3' || /判断题/.test(typeText) || (radios === 2 && /正确|错误|对|错|true|false/i.test(text))) return 'judgement';
  if (qtype === '2' || /\u586b\u7a7a\u9898|\u586b\u7a7a/.test(typeText)) return 'completion';
  if (qtype === '0' || /\u5355\u9009\u9898|\u5355\u9879\u9009\u62e9|\u5355\u9009/.test(typeText) || radios > 0 || hasSingleMarker || options.length >= 2) return 'single';
  if (textareas > 0 || hasRichTextEditor) return 'essay';
  if (textInputs > 0 && hasCompletionCue) return 'completion';
  return 'unknown';
}

function inferTypeFromText(text: string, options: string[]): QuestionType {
  if (/\u591a\u9009\u9898|\u591a\u9879\u9009\u62e9|\u591a\u9009/i.test(text)) return 'multiple';
  if ((/\u5224\u65ad\u9898|\u5224\u65ad|\u6b63\u786e|\u9519\u8bef|\u5bf9|\u9519|true|false/i.test(text)) && options.length <= 2) return 'judgement';
  if (/\u586b\u7a7a\u9898|\u586b\u7a7a/i.test(text)) return 'completion';
  if (/\u95ee\u7b54\u9898|\u7b80\u7b54\u9898|\u8bba\u8ff0\u9898|\u8d44\u6599\u9898|\u6750\u6599\u9898|\u7efc\u5408\u9898|\u4f5c\u6587\u9898/i.test(text)) return 'essay';
  if (/\u5355\u9009\u9898|\u5355\u9879\u9009\u62e9|\u5355\u9009|\u9009\u62e9\u9898/i.test(text)) return 'single';
  if (/多选题|多项选择/i.test(text)) return 'multiple';
  if (/判断题|正确|错误|对|错|true|false/i.test(text) && options.length <= 2) return 'judgement';
  if (/填空题/i.test(text)) return 'completion';
  if (/问答题|简答题|论述题|资料题|材料题|综合题|作文题/i.test(text)) return 'essay';
  if (/单选题|选择题/i.test(text) || options.length >= 2) return 'single';
  return 'unknown';
}

function isNoiseText(text: string) {
  const normalized = cleanText(text);
  if (normalized.length < 4) return true;
  if (normalized.length > 2500) return true;
  if (/(function\s+\w+|var\s+\w+\s*=|\$\(|\.css|@keyframes|document\.|window\.|ajax|submitWork|ready2Submit)/i.test(normalized)) return true;
  const codeHits = (normalized.match(/[{}();=<>]/g) || []).length;
  return codeHits > Math.max(12, normalized.length / 20);
}

export function isQuestionMetadataOnly(rawText: string) {
  let text = cleanText(rawText)
    .replace(/^\s*\d{1,3}\s*[.、．)]\s*/, '')
    .trim();
  text = text.replace(/^[（(【\[]\s*/, '').replace(/[）)】\]]\s*$/, '').trim();
  return /^(?:单选题|多选题|判断题|填空题|问答题|简答题|论述题|资料题|材料题|综合题|作文题)(?:\s*[,，:：]?\s*\d+(?:\.\d+)?\s*分?)?$/i.test(text);
}

export function isQuestionRootTextNoise(rawText: string) {
  const text = cleanText(rawText);
  if (!text) return true;
  if (text.length <= 2500) return isNoiseText(text);
  // A material/reading question can legitimately be long. Keep the normal
  // code-noise checks, but do not apply the body-page length limit to a known
  // question root.
  if (/(function\s+\w+|var\s+\w+\s*=|\$\(|\.css|@keyframes|document\.|window\.|ajax|submitWork|ready2Submit)/i.test(text)) return true;
  const codeHits = (text.match(/[{}();=<>]/g) || []).length;
  return codeHits > Math.max(24, text.length / 20);
}

function isLikelyReadingContext(text: string) {
  const value = cleanText(text);
  if (value.length < 120) return false;
  const englishWords = (value.match(/[A-Za-z]{3,}/g) || []).length;
  const optionMarkers = (value.match(/(?:^|\s)[A-HＡ-Ｈ]\s*[.、．)]/g) || []).length;
  const questionMarkers = (value.match(/(?:^|\s)\d{1,3}[.、．)]\s*/g) || []).length;
  return englishWords >= 30 || (value.length >= 220 && optionMarkers >= 4 && questionMarkers >= 2);
}

export function nearestClickableOption(element: HTMLElement) {
  return element.closest([
    'label',
    '[role="radio"]',
    '[role="checkbox"]',
    '[onclick]',
    '[data][qid]',
    '[data-option]',
    '.choice',
    '.choice-item',
    '.choiceOption',
    '.choice-option',
    '.option',
    '.optionItem',
    '.option-item',
    '.options-item',
    '.optionBox',
    '.option-box',
    '.answerCon',
    '.ans-item',
    '.answerItem',
    '.answer-item',
    '.checkOption',
    '.check-option',
    '.radio',
    '.radio-box',
    'li'
  ].join(',')) as HTMLElement | null;
}

function optionLabelFromText(rawText: string, dataValue: string, index: number) {
  const text = cleanText(rawText);
  const dataLabel = /^[A-H]$/i.test(dataValue) ? dataValue : '';
  const firstToken = text.match(/^\s*([A-H])\s*[.\s:：、。)]?/i)?.[1];
  if (firstToken) return firstToken.toUpperCase();
  if (dataLabel) return dataLabel.toUpperCase();
  return optionLetter(index);
}

function optionSortAnchor(element: HTMLElement) {
  const clickable = nearestClickableOption(element) || element;
  return isVisible(clickable) ? clickable : element;
}

function sortOptionElementsByVisualOrder<T extends HTMLElement>(elements: T[]) {
  return elements
    .map((element, index) => {
      const anchor = optionSortAnchor(element);
      const rect = anchor.getBoundingClientRect();
      return {
        element,
        index,
        top: rect.top,
        left: rect.left,
        height: rect.height
      };
    })
    .filter((item) => isVisible(optionSortAnchor(item.element)) || isVisible(item.element))
    .sort((left, right) => {
      const rowTolerance = Math.max(6, Math.min(left.height || 0, right.height || 0) / 2);
      if (Math.abs(left.top - right.top) > rowTolerance) return left.top - right.top;
      if (Math.abs(left.left - right.left) > 1) return left.left - right.left;
      return left.index - right.index;
    })
    .map((item) => item.element);
}

function optionTargetsFromElements(elements: HTMLElement[]) {
  return sortOptionElementsByVisualOrder(elements)
    .map((element, index) => optionTargetFromElement(element, index));
}

function optionLabelRank(label: string) {
  const normalized = String(label || '').trim().toUpperCase();
  return /^[A-H]$/.test(normalized) ? normalized.charCodeAt(0) - 65 : -1;
}

function sortOptionTargetsByLabelOrder(targets: QuestionOptionTarget[]) {
  const ranks = targets.map((target) => optionLabelRank(target.label));
  const canSortByLabel = targets.length >= 2 &&
    ranks.every((rank) => rank >= 0) &&
    new Set(ranks).size === ranks.length;
  if (!canSortByLabel) return targets;
  return targets.slice().sort((left, right) => optionLabelRank(left.label) - optionLabelRank(right.label));
}

function normalizeOptionTargets(targets: QuestionOptionTarget[]) {
  return sortOptionTargetsByLabelOrder(dedupeOptionTargets(targets));
}

export function optionTargetFromElement(element: HTMLElement, index: number): QuestionOptionTarget {
  const input = element.matches('input[type="radio"], input[type="checkbox"]')
    ? element
    : element.querySelector('input[type="radio"], input[type="checkbox"]');
  const marker = element.matches('.num_option, .num_option_dx, [data], [value]')
    ? element
    : element.querySelector('.num_option, .num_option_dx, [data], [value]');
  const dataValue = element.getAttribute('data') ||
    marker?.getAttribute('data') ||
    element.getAttribute('value') ||
    marker?.getAttribute('value') ||
    (input as HTMLInputElement | null)?.value ||
    '';
  const rawText = visibleText(element) || element.getAttribute('aria-label') || dataValue;
  const labelMatch = rawText.match(/^\s*([A-ZＡ-Ｈ])\s*[.\s:：、．。)]/i);
  const dataLabel = /^[A-Z]$/i.test(dataValue) ? dataValue : '';
  const label = (labelMatch?.[1] || dataLabel || optionLetter(index)).toUpperCase();
  const clickTarget = nearestClickableOption(element) || element;
  // 选项文本替换为“对/错”仅在值是显式判断语义（true/false/对/错等）时启用；
  // 裸数字 1/0 是普通选择题极常见的选项值，直接替换会把选项文本毁掉
  const explicitJudgementValue = /^\d+$/.test(dataValue) ? null : parseJudgementValueStable(dataValue);
  const displayText = explicitJudgementValue === 'true'
    ? '对'
    : explicitJudgementValue === 'false'
      ? '错'
      : optionTextCandidate(clickTarget, label);
  return {
    label,
    text: optionLabel(label, displayText || rawText || label),
    selector: selectorFor(element),
    inputSelector: input ? selectorFor(input) : undefined,
    clickSelector: clickTarget !== element ? selectorFor(clickTarget) : undefined,
    value: dataValue || undefined
  };
}

export function dedupeOptionTargets(targets: QuestionOptionTarget[]) {
  return uniqueBy(targets, (target) => `${target.label}:${normalizeText(target.text)}`)
    .filter((target) => {
      const text = normalizeText(target.text);
      return text.length > 0 && text.length <= 160 && !isNoiseText(target.text);
    });
}

function isLikelyOptionListItem(element: HTMLElement) {
  const text = cleanText(element.textContent || '');
  if (!text || text.length > 240) return false;
  const optionClass = /(?:^|[-_])(option|answer|choice)(?:[-_]|$)/i.test(element.className || '');
  const hasControl = Boolean(element.querySelector('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'));
  const hasLetterPrefix = /^\s*[A-HＡ-Ｈ]\s*[.、．):：。)]\s*/i.test(text);
  return optionClass || hasControl || hasLetterPrefix;
}

export function extractOptionTargets(root: HTMLElement) {
  const chaoxingExamTargets = normalizeOptionTargets(optionTargetsFromElements((Array.from(root.querySelectorAll('.answerBg')) as HTMLElement[])
    .filter((element) => element.querySelector('.num_option, .num_option_dx') && element.querySelector('.answer_p'))));
  if (chaoxingExamTargets.length >= 2) return chaoxingExamTargets.slice(0, 12);

  const inputTargets = normalizeOptionTargets(optionTargetsFromElements((Array.from(root.querySelectorAll('input[type="radio"], input[type="checkbox"]')) as HTMLInputElement[])
    .map((input) => {
      const label = input.closest('label') || (input.id ? document.querySelector(`label[for="${cssEscape(input.id)}"]`) : null);
      return (label || input) as HTMLElement;
    })));
  if (inputTargets.length >= 2) return inputTargets.slice(0, 12);

  for (const selector of OPTION_SELECTORS) {
    const elements = Array.from(root.querySelectorAll(selector)) as HTMLElement[];
    const filtered = selector === 'li' ? elements.filter(isLikelyOptionListItem) : elements;
    const targets = normalizeOptionTargets(optionTargetsFromElements(filtered));
    if (targets.length >= 2) return targets.slice(0, 12);
  }

  const letterTargets = normalizeOptionTargets(optionTargetsFromElements((Array.from(root.querySelectorAll('*')) as HTMLElement[])
    .filter((element) => {
      const text = cleanText(element.textContent || '');
      return /^[A-H]$/.test(text) && isVisible(element);
    })
    .map((element) => nearestClickableOption(element) || element)));
  if (letterTargets.length >= 2) return letterTargets.slice(0, 12);

  return [];
}

function extractOptionsFromText(body: string) {
  const matches = Array.from(body.matchAll(/(?:^|\s)([A-HＡ-Ｈ])\s*[.、．)]?\s*(.*?)(?=\s+[A-HＡ-Ｈ]\s*[.、．)]?\s+|$)/g));
  if (matches.length < 2) return { question: cleanText(body), options: [] as string[] };

  const firstIndex = matches[0].index || 0;
  const question = cleanText(body.slice(0, firstIndex));
  const options = matches.map((match, index) => optionLabel(match[1] || optionLetter(index), match[2] || ''));
  return { question: question || cleanText(body), options: uniqueBy(options, normalizeText) };
}

function findQuestionText(root: HTMLElement, optionTargets: QuestionOptionTarget[]) {
  const chaoxingStem = root.querySelector('.mark_name') as HTMLElement | null;
  if (chaoxingStem) {
    const clone = chaoxingStem.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.colorShallow').forEach((node) => node.remove());
    let text = visibleText(clone)
      .replace(/^\s*\d{1,3}\s*[.、.)]?\s*/, '')
      .replace(/^\s*[（(]?\s*单选题|多选题|判断题|填空题|问答题[\s\S]*?[）)]\s*/i, '')
      .trim();
    if (!text) {
      text = cleanText(Array.from(chaoxingStem.childNodes)
        .filter((node) => !(node instanceof HTMLElement && node.classList.contains('colorShallow')))
        .map((node) => node.textContent || '')
        .join(' '));
    }
    if (!isQuestionRootTextNoise(text) && text.length >= 4 && !isQuestionMetadataOnly(text)) return text;
  }

  for (const selector of TITLE_SELECTORS) {
    const element = root.querySelector(selector);
    if (!element) continue;
    const text = visibleText(element);
    if (!isQuestionRootTextNoise(text) && text.length >= 4 && !isQuestionMetadataOnly(text)) return text;
  }

  const clone = root.cloneNode(true) as HTMLElement;
  removeNoise(clone);
  clone.querySelectorAll(TEXT_ENTRY_SELECTORS).forEach((node) => node.remove());
  clone.querySelectorAll(TITLE_SELECTORS.join(',')).forEach((node) => {
    if (isQuestionMetadataOnly(visibleText(node))) node.remove();
  });
  OPTION_SELECTORS.filter((selector) => selector !== 'li').forEach((selector) => clone.querySelectorAll(selector).forEach((node) => node.remove()));
  if (optionTargets.length > 0) {
    clone.querySelectorAll('li').forEach((node) => {
      const text = normalizeText(visibleText(node));
      if (optionTargets.some((target) => normalizeText(target.text) === text)) node.remove();
    });
  }
  let text = cleanText(clone.textContent || '');
  for (const option of optionTargets) text = text.replace(option.text, '');
  return cleanText(text).replace(/^\s*\d{1,3}\s*[.、．)]\s*/, '').trim();
}

function questionFromRoot(root: HTMLElement, index: number): ExtractedQuestion | null {
  const optionTargets = extractOptionTargets(root);
  const options = optionTargets.map((target) => target.text);
  const question = findQuestionText(root, optionTargets);
  const inputFields = Array.from(root.querySelectorAll(TEXT_ENTRY_SELECTORS)).filter((element) => isVisible(element as HTMLElement));
  const hint = readQuestionTypeHint(root);
  const inferredType = inferTypeFromDom(root, options);
  const explicitEssay = hint.qtype === '4' || inferredType === 'essay' || /问答题|简答题|论述题|作文题|资料题|材料题|综合题/i.test(`${hint.typeName} ${question || ''}`);
  const hasBlankCue = /填空|第\s*\d+\s*空|_{2,}|\bblank\s*\d+/i.test(question || '');
  const isLikelyCompletion = !explicitEssay && inputFields.length > 0 && (hasBlankCue || inferTypeFromDom(root, options) === 'completion');

  if (!question || isQuestionRootTextNoise(question) || isQuestionMetadataOnly(question)) return null;
  if (options.length > 0 && question.length > 1200) return null;
  // Open-ended questions commonly end with a full stop rather than a question
  // mark, and the type label itself may live in a separate metadata heading
  // (for example “21.（论述题，30分）”).  In that layout the cleaned stem no
  // longer contains the word “论述题”, so the generic punctuation/type guard
  // used to discard the otherwise valid question before it reached the prompt.
  if (options.length === 0 && !isLikelyCompletion && !explicitEssay && !/[？?]|(单选|多选|判断|填空|问答|题)/.test(question)) return null;

  return {
    id: `q_${Date.now()}_${index}`,
    hash: hashText(`${question}\n${options.join('\n')}`),
    question,
    options,
    optionTargets,
    type: isLikelyCompletion ? 'completion' : inferredType,
    source: 'webview',
    pageUrl: window.location.href,
    pageTitle: cleanText(document.title) || window.location.href,
    capturedAt: Date.now(),
    index,
    selector: selectorFor(root)
  };
}

function extractDetachedCompletionQuestions(startIndex: number, recognizedRoots = new Set<HTMLElement>()) {
  const fields = Array.from(document.querySelectorAll(TEXT_ENTRY_SELECTORS)).filter((element) => isVisible(element as HTMLElement)) as HTMLElement[];
  const roots = new Map<HTMLElement, HTMLElement[]>();
  for (const field of fields) {
    let root = field.closest(QUESTION_ROOT_SELECTOR) as HTMLElement | null;
    if (root && recognizedRoots.has(root)) continue;
    if (!root) {
      let candidate = field.parentElement;
      for (let depth = 0; candidate && depth < 5; depth += 1, candidate = candidate.parentElement) {
        const text = visibleText(candidate);
        if (candidate.querySelector(TITLE_SELECTORS.join(',')) || (text.length >= 12 && text.length <= 1600)) {
          root = candidate;
          break;
        }
      }
    }
    if (!root || recognizedRoots.has(root)) continue;
    roots.set(root, [...(roots.get(root) || []), field]);
  }
  const recovered: ExtractedQuestion[] = [];
  let index = startIndex;
  for (const [root, rootFields] of roots) {
    const hint = readQuestionTypeHint(root);
    const stem = findQuestionText(root, []).replace(/\s+/g, ' ').trim();
    const typeText = `${hint.typeName} ${stem}`;
    if (!stem || isNoiseText(stem)) continue;
    if (hint.qtype === '4' || /问答题|简答题|论述题|作文题|资料题|材料题|综合题/i.test(typeText)) continue;
    const hasBlankEditorClass = rootFields.some((field) => /blankInpDiv|textDIV|eidtDiv|blank/i.test(`${field.className || ''} ${field.parentElement?.className || ''}`));
    const hasBlankCue = /填空|第\s*\d+\s*空|_{2,}|\bblank\s*\d+/i.test(typeText);
    if (!(hint.qtype === '2' || hasBlankEditorClass || hasBlankCue)) continue;
    if (root.querySelector('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]')) continue;
    recovered.push({
      id: `q_${Date.now()}_completion_${index}`,
      hash: hashText(`${stem}\n${rootFields.length} blanks`), question: stem,
      options: [], optionTargets: [], type: 'completion', source: 'webview',
      pageUrl: window.location.href, pageTitle: cleanText(document.title) || window.location.href,
      capturedAt: Date.now(), index, selector: selectorFor(root)
    });
    index += 1;
  }
  return recovered;
}

function splitContinuousText(rawText: string) {
  const text = cleanText(rawText);
  if (isNoiseText(text)) return [];
  const boundaryPattern = /(?:^|\s)(\d{1,3})[.、．)]\s*(?:[（(]?(单选题|多选题|判断题|填空题|问答题|简答题|论述题)[)）]?)?/g;
  const matches = Array.from(text.matchAll(boundaryPattern));
  if (matches.length <= 1) return [];

  return matches.map((match, index) => {
    const start = (match.index || 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index || text.length : text.length;
    return {
      number: Number(match[1]),
      typeLabel: match[2] || '',
      body: cleanText(text.slice(start, end))
    };
  }).filter((item) => item.body.length > 8 && !isNoiseText(item.body));
}

function questionFromSegment(segment: { number: number; typeLabel: string; body: string }): ExtractedQuestion | null {
  const parsed = extractOptionsFromText(segment.body);
  const question = parsed.question || segment.body;
  const options = parsed.options;
  if (!question || isNoiseText(question)) return null;
  return {
    id: `q_${Date.now()}_${segment.number}`,
    hash: hashText(`${segment.number}\n${question}\n${options.join('\n')}`),
    question,
    options,
    optionTargets: [],
    type: inferTypeFromText(`${segment.typeLabel} ${segment.body}`, options),
    source: 'webview',
    pageUrl: window.location.href,
    pageTitle: cleanText(document.title) || window.location.href,
    capturedAt: Date.now(),
    index: segment.number
  };
}

function textBeforeFirstQuestion(text: string, firstQuestionIndex: number) {
  return cleanText(text.slice(Math.max(0, firstQuestionIndex - 5000), firstQuestionIndex));
}

function splitReadingQuestions(rawText: string): ExtractedQuestion[] {
  const text = cleanText(rawText);
  if (isNoiseText(text) || text.length < 160) return [];

  const questionPattern = /(?:^|\s)(\d{1,3})[.、．)]\s+([\s\S]*?)(?=\s+[A-HＡ-Ｈ]\s*[.、．)]\s+)/g;
  const questionMatches = Array.from(text.matchAll(questionPattern))
    .filter((match) => typeof match.index === 'number');
  if (questionMatches.length === 0) return [];

  const questionStarts = questionMatches.map((match) => match.index || 0);
  const firstQuestionStart = Math.min(...questionStarts);
  const sharedContext = textBeforeFirstQuestion(text, firstQuestionStart);
  if (!isLikelyReadingContext(sharedContext)) return [];

  const results: ExtractedQuestion[] = [];
  for (let index = 0; index < questionMatches.length; index += 1) {
    const match = questionMatches[index];
    const start = match.index || 0;
    const nextStart = index + 1 < questionMatches.length ? questionMatches[index + 1].index || text.length : text.length;
    const body = cleanText(text.slice(start, nextStart).replace(/^\s*\d{1,3}[.、．)]\s*/, ''));
    const parsed = extractOptionsFromText(body);
    if (parsed.options.length < 2) continue;
    const number = Number(match[1]);
    const question = parsed.question || cleanText(match[2] || body);
    if (!question || isNoiseText(question)) continue;
    results.push({
      id: `q_${Date.now()}_${number}`,
      hash: hashText(`${number}\n${sharedContext}\n${question}\n${parsed.options.join('\n')}`),
      question,
      options: parsed.options,
      optionTargets: [],
      type: inferTypeFromText(body, parsed.options),
      source: 'webview',
      pageUrl: window.location.href,
      pageTitle: cleanText(document.title) || window.location.href,
      capturedAt: Date.now(),
      index: number,
      context: sharedContext
    });
  }

  return results;
}

function contextAroundBlank(context: string, number: number) {
  const escaped = String(number).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`[_\\s]{2,}${escaped}[_\\s]{2,}`),
    new RegExp(`_{2,}\\s*${escaped}\\s*_{2,}`),
    new RegExp(`\\b${escaped}\\b`)
  ];
  const index = patterns
    .map((pattern) => {
      const match = pattern.exec(context);
      return match?.index ?? -1;
    })
    .find((value) => value >= 0) ?? -1;
  if (index < 0) return '';
  return cleanText(context.slice(Math.max(0, index - 180), Math.min(context.length, index + 220)));
}

function splitClozeOptionQuestions(rawText: string): ExtractedQuestion[] {
  const text = cleanText(rawText);
  if (isNoiseText(text) || text.length < 160) return [];

  const optionRowPattern = /(?:^|\s)(\d{1,3})[.、．)]\s+(?=[A-HＡ-Ｈ]\s*[.、．)]\s+)/g;
  const rowMatches = Array.from(text.matchAll(optionRowPattern))
    .filter((match) => typeof match.index === 'number');
  if (rowMatches.length < 2) return [];

  const firstRowStart = rowMatches[0].index || 0;
  const sharedContext = textBeforeFirstQuestion(text, firstRowStart);
  const hasBlankCue = /_{2,}\s*\d{1,3}\s*_{2,}|_{4,}|\b\d{1,3}\b\s*[，,.。;]/.test(sharedContext);
  if (!isLikelyReadingContext(sharedContext) || !hasBlankCue) return [];

  const results: ExtractedQuestion[] = [];
  for (let index = 0; index < rowMatches.length; index += 1) {
    const match = rowMatches[index];
    const start = match.index || 0;
    const nextStart = index + 1 < rowMatches.length ? rowMatches[index + 1].index || text.length : text.length;
    const number = Number(match[1]);
    const rowBody = cleanText(text.slice(start, nextStart).replace(/^\s*\d{1,3}[.、．)]\s*/, ''));
    const parsed = extractOptionsFromText(rowBody);
    if (parsed.options.length < 2) continue;
    const nearby = contextAroundBlank(sharedContext, number);
    const question = nearby
      ? `根据文章上下文，选择第 ${number} 空的最佳答案：${nearby}`
      : `根据文章上下文，选择第 ${number} 空的最佳答案。`;
    results.push({
      id: `q_${Date.now()}_${number}`,
      hash: hashText(`${number}\n${sharedContext}\n${question}\n${parsed.options.join('\n')}`),
      question,
      options: parsed.options,
      optionTargets: [],
      type: 'single',
      source: 'webview',
      pageUrl: window.location.href,
      pageTitle: cleanText(document.title) || window.location.href,
      capturedAt: Date.now(),
      index: number,
      context: sharedContext
    });
  }

  return results;
}

function sharedReadingContextFromText(rawText: string) {
  const text = cleanText(rawText);
  if (isNoiseText(text) || text.length < 160) return '';
  const marker = /(?:^|\s)\d{1,3}[.、．)]\s+/.exec(text);
  if (!marker || typeof marker.index !== 'number') return '';
  const context = textBeforeFirstQuestion(text, marker.index);
  return isLikelyReadingContext(context) ? context : '';
}

function attachReadingContext(questions: ExtractedQuestion[], rawText: string) {
  if (questions.length === 0 || questions.some((question) => question.context)) return questions;
  const context = sharedReadingContextFromText(rawText);
  if (!context) return questions;
  const articleQuestionCount = questions.filter((question) =>
    question.options.length >= 2 &&
    question.question.length < 500 &&
    !isLikelyReadingContext(question.question)
  ).length;
  if (articleQuestionCount < 2) return questions;
  return questions.map((question) => ({
    ...question,
    context,
    hash: hashText(`${question.index || ''}\n${context}\n${question.question}\n${question.options.join('\n')}`)
  }));
}

export function extractQuestions() {
  const currentExamRoot = document.querySelector('.singleQuestionDiv') as HTMLElement | null;
  if (currentExamRoot && isVisible(currentExamRoot)) {
    const currentQuestion = questionFromRoot(currentExamRoot, 1);
    if (currentQuestion) return applyFontDecode([currentQuestion]);
  }

  const roots: HTMLElement[] = [];
  const seen = new Set<string>();

  for (const selector of QUESTION_CONTAINER_SELECTORS) {
      const elements = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
      for (const element of elements) {
        if (!isVisible(element)) continue;
        const text = visibleText(element);
        if (isQuestionRootTextNoise(text) || seen.has(text)) continue;
        seen.add(text);
        roots.push(element);
      }
    if (roots.length > 1) break;
  }

  const domQuestions = roots
    .map((root, index) => questionFromRoot(root, index + 1))
    .filter(Boolean) as ExtractedQuestion[];

  // Only skip roots that produced a usable DOM question. A known container can
  // still be a failed extraction (for example a fill editor without a title),
  // and those fields should get one recovery attempt below.
  const recognizedRoots = new Set<HTMLElement>();
  roots.forEach((root) => {
    const rootSelector = selectorFor(root);
    if (domQuestions.some((question) => question.selector === rootSelector)) recognizedRoots.add(root);
  });
  const recoveredCompletionQuestions = extractDetachedCompletionQuestions(domQuestions.length + 1, recognizedRoots);

  const bodyClone = document.body.cloneNode(true) as HTMLElement;
  removeNoise(bodyClone);
  const bodyText = bodyClone.textContent || '';

  const domCandidates = uniqueBy([...domQuestions, ...recoveredCompletionQuestions], (question) => `${question.type}|${normalizeText(question.question)}|${question.options.map(normalizeText).join('|')}`);
  if (domCandidates.length > 0) return applyFontDecode(attachReadingContext(domCandidates, bodyText));

  const readingQuestions = splitReadingQuestions(bodyClone.textContent || '');
  if (readingQuestions.length > 0) return applyFontDecode(uniqueBy(readingQuestions, (question) => question.hash));

  const clozeQuestions = splitClozeOptionQuestions(bodyClone.textContent || '');
  if (clozeQuestions.length > 0) return applyFontDecode(uniqueBy(clozeQuestions, (question) => question.hash));

  const textQuestions = splitContinuousText(bodyClone.textContent || '')
    .map(questionFromSegment)
    .filter(Boolean) as any[];
  if (textQuestions.length > 0) return applyFontDecode(uniqueBy(textQuestions, (question) => question.hash));

  const fallback = questionFromRoot(document.body, 1);
  return fallback ? applyFontDecode([fallback]) : [];
}

// 字体反爬：把选项/题干里的 PUA 私用码位还原成真实字符。
// 映射表在 preload 启动时异步加载；未就绪时原样返回（已加载后命中）。
function applyFontDecode(questions: ExtractedQuestion[]): ExtractedQuestion[] {
  for (const question of questions) {
    if (question.question) question.question = decodeFontTextSync(question.question);
    if (Array.isArray(question.options)) {
      question.options = question.options.map((option) => decodeFontTextSync(option));
    }
    if (Array.isArray(question.optionTargets)) {
      question.optionTargets = question.optionTargets.map((target) => ({
        ...target,
        text: decodeFontTextSync(target.text)
      }));
    }
    if (question.context) question.context = decodeFontTextSync(question.context);
    // 文本变化后重新计算 hash，保证题库 key 一致
    question.hash = hashText(normalizeText(question.question) + '|' + (question.options || []).map(normalizeText).join('|'));
  }
  return questions;
}
