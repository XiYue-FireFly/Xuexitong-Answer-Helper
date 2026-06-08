import type { QuestionOptionTarget, QuestionType } from './types';
import { parseJudgementValueStable } from './answer-matcher';
import { cleanText, cssEscape, hashText, isVisible, normalizeText, optionLabel, optionLetter, optionTextCandidate, removeNoise, selectorFor, uniqueBy, visibleText } from './dom-utils';

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

function inferTypeFromDom(root: HTMLElement, options: string[]): QuestionType {
  const hint = readQuestionTypeHint(root);
  const qtype = hint.qtype;
  const radios = root.querySelectorAll('input[type="radio"]').length;
  const checkboxes = root.querySelectorAll('input[type="checkbox"]').length;
  const textareas = root.querySelectorAll('textarea').length;
  const textInputs = root.querySelectorAll('input[type="text"], input:not([type])').length;
  const text = visibleText(root);
  const typeText = `${hint.typeName} ${text}`;
  const hasMultipleMarker = Boolean(root.querySelector('.num_option_dx, [role="checkbox"], input[type="checkbox"]'));
  const hasSingleMarker = Boolean(root.querySelector('.num_option, [role="radio"], input[type="radio"]'));

  if (qtype === '1' || hasMultipleMarker || checkboxes > 0 || /\u591a\u9009\u9898|\u591a\u9879\u9009\u62e9|\u591a\u9009/.test(typeText)) return 'multiple';
  if (qtype === '3' || (radios === 2 && /正确|错误|对|错|true|false/i.test(text))) return 'judgement';
  if (qtype === '2' || /\u586b\u7a7a\u9898|\u586b\u7a7a/.test(typeText)) return 'completion';
  if (qtype === '4' || /\u95ee\u7b54\u9898|\u7b80\u7b54\u9898|\u8bba\u8ff0\u9898/.test(typeText)) return 'essay';
  if (qtype === '0' || /\u5355\u9009\u9898|\u5355\u9879\u9009\u62e9|\u5355\u9009/.test(typeText) || radios > 0 || hasSingleMarker || options.length >= 2) return 'single';
  if (textareas > 0) return 'essay';
  if (textInputs > 0) return 'completion';
  return 'unknown';
}

function inferTypeFromText(text: string, options: string[]): QuestionType {
  if (/\u591a\u9009\u9898|\u591a\u9879\u9009\u62e9|\u591a\u9009/i.test(text)) return 'multiple';
  if ((/\u5224\u65ad\u9898|\u5224\u65ad|\u6b63\u786e|\u9519\u8bef|\u5bf9|\u9519|true|false/i.test(text)) && options.length <= 2) return 'judgement';
  if (/\u586b\u7a7a\u9898|\u586b\u7a7a/i.test(text)) return 'completion';
  if (/\u95ee\u7b54\u9898|\u7b80\u7b54\u9898|\u8bba\u8ff0\u9898/i.test(text)) return 'essay';
  if (/\u5355\u9009\u9898|\u5355\u9879\u9009\u62e9|\u5355\u9009|\u9009\u62e9\u9898/i.test(text)) return 'single';
  if (/多选题|多项选择/i.test(text)) return 'multiple';
  if (/判断题|正确|错误|对|错|true|false/i.test(text) && options.length <= 2) return 'judgement';
  if (/填空题/i.test(text)) return 'completion';
  if (/问答题|简答题|论述题/i.test(text)) return 'essay';
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
  const dataLabel = /^[A-D]$/i.test(dataValue) ? dataValue : '';
  const firstToken = text.match(/^\s*([A-D])\s*[.\s:：、。)]?/i)?.[1];
  if (dataLabel) return dataLabel.toUpperCase();
  if (firstToken) return firstToken.toUpperCase();
  return optionLetter(index);
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
  const labelMatch = rawText.match(/^\s*([A-ZＡ-Ｄ])\s*[.\s:：、．。)]/i);
  const dataLabel = /^[A-Z]$/i.test(dataValue) ? dataValue : '';
  const label = (dataLabel || labelMatch?.[1] || optionLetter(index)).toUpperCase();
  const clickTarget = nearestClickableOption(element) || element;
  const judgementValue = parseJudgementValueStable(dataValue);
  const displayText = judgementValue === 'true'
    ? '\u5bf9'
    : judgementValue === 'false'
      ? '\u9519'
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

export function extractOptionTargets(root: HTMLElement) {
  const chaoxingExamTargets = dedupeOptionTargets((Array.from(root.querySelectorAll('.answerBg')) as HTMLElement[])
    .filter((element) => element.querySelector('.num_option, .num_option_dx') && element.querySelector('.answer_p'))
    .map((element, index) => optionTargetFromElement(element, index)));
  if (chaoxingExamTargets.length >= 2) return chaoxingExamTargets.slice(0, 12);

  const inputTargets = dedupeOptionTargets((Array.from(root.querySelectorAll('input[type="radio"], input[type="checkbox"]')) as HTMLInputElement[])
    .map((input, index) => {
      const label = input.closest('label') || (input.id ? document.querySelector(`label[for="${cssEscape(input.id)}"]`) : null);
      return optionTargetFromElement((label || input) as HTMLElement, index);
    }));
  if (inputTargets.length >= 2) return inputTargets.slice(0, 12);

  for (const selector of OPTION_SELECTORS) {
    const targets = dedupeOptionTargets(Array.from(root.querySelectorAll(selector))
      .map((element, index) => optionTargetFromElement(element as HTMLElement, index)));
    if (targets.length >= 2) return targets.slice(0, 12);
  }

  const letterTargets = dedupeOptionTargets((Array.from(root.querySelectorAll('*')) as HTMLElement[])
    .filter((element) => {
      const text = cleanText(element.textContent || '');
      return /^[A-D]$/.test(text) && isVisible(element);
    })
    .map((element, index) => optionTargetFromElement(nearestClickableOption(element) || element, index)));
  if (letterTargets.length >= 2) return letterTargets.slice(0, 12);

  return [];
}

function extractOptionsFromText(body: string) {
  const matches = Array.from(body.matchAll(/(?:^|\s)([A-DＡ-Ｄ])\s*[.、．)]?\s*(.*?)(?=\s+[A-DＡ-Ｄ]\s*[.、．)]?\s+|$)/g));
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
    if (!isNoiseText(text) && text.length >= 4) return text;
  }

  for (const selector of TITLE_SELECTORS) {
    const element = root.querySelector(selector);
    if (!element) continue;
    const text = visibleText(element);
    if (!isNoiseText(text) && text.length >= 4) return text;
  }

  const clone = root.cloneNode(true) as HTMLElement;
  removeNoise(clone);
  OPTION_SELECTORS.forEach((selector) => clone.querySelectorAll(selector).forEach((node) => node.remove()));
  let text = cleanText(clone.textContent || '');
  for (const option of optionTargets) text = text.replace(option.text, '');
  return cleanText(text);
}

function questionFromRoot(root: HTMLElement, index: number) {
  const optionTargets = extractOptionTargets(root);
  const options = optionTargets.map((target) => target.text);
  const question = findQuestionText(root, optionTargets);

  if (!question || isNoiseText(question)) return null;
  if (options.length > 0 && question.length > 1200) return null;
  if (options.length === 0 && !/[？?]|(单选|多选|判断|填空|问答|题)/.test(question)) return null;

  return {
    id: `q_${Date.now()}_${index}`,
    hash: hashText(`${question}\n${options.join('\n')}`),
    question,
    options,
    optionTargets,
    type: inferTypeFromDom(root, options),
    source: 'webview',
    pageUrl: window.location.href,
    pageTitle: cleanText(document.title) || window.location.href,
    capturedAt: Date.now(),
    index,
    selector: selectorFor(root)
  };
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

function questionFromSegment(segment: { number: number; typeLabel: string; body: string }) {
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

export function extractQuestions() {
  const currentExamRoot = document.querySelector('.singleQuestionDiv') as HTMLElement | null;
  if (currentExamRoot && isVisible(currentExamRoot)) {
    const currentQuestion = questionFromRoot(currentExamRoot, 1);
    if (currentQuestion) return [currentQuestion];
  }

  const roots: HTMLElement[] = [];
  const seen = new Set<string>();

  for (const selector of QUESTION_CONTAINER_SELECTORS) {
    const elements = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
    for (const element of elements) {
      if (!isVisible(element)) continue;
      const text = visibleText(element);
      if (isNoiseText(text) || seen.has(text)) continue;
      seen.add(text);
      roots.push(element);
    }
    if (roots.length > 1) break;
  }

  const domQuestions = roots
    .map((root, index) => questionFromRoot(root, index + 1))
    .filter(Boolean) as any[];

  if (domQuestions.length > 0) return uniqueBy(domQuestions, (question) => question.hash);

  const bodyClone = document.body.cloneNode(true) as HTMLElement;
  removeNoise(bodyClone);
  const textQuestions = splitContinuousText(bodyClone.textContent || '')
    .map(questionFromSegment)
    .filter(Boolean) as any[];
  if (textQuestions.length > 0) return uniqueBy(textQuestions, (question) => question.hash);

  const fallback = questionFromRoot(document.body, 1);
  return fallback ? [fallback] : [];
}
