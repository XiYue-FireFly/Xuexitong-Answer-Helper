import { appliedAnswerFor } from './applied-answer-store';
import { parseJudgementValueStable, parseStrictJudgementOption } from './answer-matcher';
import { reportWebviewError } from './bridge';
import { cleanText, cssEscape, dispatchInput, selectedClassHit, uniqueElements } from './dom-utils';
import { readQuestionTypeHint } from './question-extractor';

function optionValueForSubmit(element: HTMLElement) {
  const marker = element.matches('.num_option, .num_option_dx, [data], [value]')
    ? element
    : element.querySelector('.num_option, .num_option_dx, [data], [value]');
  const input = element.matches('input[type="radio"], input[type="checkbox"]')
    ? element as HTMLInputElement
    : element.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLInputElement | null;
  const ownData = element.getAttribute('data') || '';
  const ownValue = element.getAttribute('value') || '';
  const markerData = marker && marker !== element ? marker.getAttribute('data') || marker.getAttribute('value') || '' : '';
  const elementLooksLikeOption = isSubmitOptionElement(element);
  return cleanText(
    markerData ||
    input?.value ||
    (elementLooksLikeOption ? ownData : '') ||
    (elementLooksLikeOption ? ownValue : '') ||
    ''
  );
}

function isSubmitQuestionContainer(element: HTMLElement) {
  if (element.matches('.answerBg, .workTextWrap, .num_option, .num_option_dx')) return false;
  if (element.matches('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]')) return false;
  if (element.className && /\bchoice\d+\b/.test(String(element.className))) return false;
  return element.matches(SUBMIT_QUESTION_CONTAINER_SELECTOR) ||
    Boolean(element.getAttribute('qtype')) ||
    Boolean(element.querySelectorAll('.answerBg, .workTextWrap, input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]').length > 1);
}

function isSubmitOptionElement(element: HTMLElement) {
  if (isSubmitQuestionContainer(element)) return false;
  if (element.matches('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]')) return true;
  if (element.matches('.answerBg, .workTextWrap, .num_option, .num_option_dx')) return true;
  if (element.className && /\bchoice\d+\b/.test(String(element.className))) return true;
  const data = cleanText(element.getAttribute('data') || '');
  const value = cleanText(element.getAttribute('value') || '');
  if (/^[A-H]$/i.test(data) || /^[A-H]$/i.test(value)) return true;
  if (parseStrictJudgementOption(data) || parseJudgementValueStable(data) || parseStrictJudgementOption(value) || parseJudgementValueStable(value)) return true;
  return Boolean(element.querySelector('.num_option, .num_option_dx, input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'));
}

function selectedOptionValue(element: HTMLElement) {
  if (!isSubmitOptionElement(element)) return '';
  const input = element.matches('input[type="radio"], input[type="checkbox"]')
    ? element as HTMLInputElement
    : element.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLInputElement | null;
  if (input && !input.checked) return '';
  if (!input) {
    const selected = element.getAttribute('aria-checked') === 'true' ||
      element.getAttribute('aria-pressed') === 'true' ||
      selectedClassHit(element) ||
      Array.from(element.querySelectorAll('*')).some((child) => selectedClassHit(child as HTMLElement));
    if (!selected) return '';
  }
  return optionValueForSubmit(element);
}

interface SubmitQuestionRoot {
  qid: string;
  root: HTMLElement;
  hiddenAnswer: HTMLInputElement;
  qtype: string;
  score: number;
}

const SUBMIT_QUESTION_CONTAINER_SELECTOR = [
  '.singleQuestionDiv',
  '.questionLi',
  '.question',
  '.question-item',
  '.subject-item',
  '.exam-question',
  '.timu',
  '.TiMu',
  '.CeSheng',
  '.questionCard'
].join(',');

function questionIdFromSubmitElement(element: HTMLElement) {
  const input = element as HTMLInputElement;
  const idMatch = input.id?.match(/^answer(.+)$/i)?.[1] || '';
  const nameMatch = input.name?.match(/^answer(.+)$/i)?.[1] || '';
  const direct = element.getAttribute('qid') ||
    element.getAttribute('questionid') ||
    element.querySelector('[qid]')?.getAttribute('qid') ||
    element.querySelector('[questionid]')?.getAttribute('questionid') ||
    element.querySelector('input[name="questionId"]')?.getAttribute('value') ||
    idMatch ||
    nameMatch ||
    '';
  if (direct) {
    const normalized = cleanText(direct);
    return /^\d{4,}$/.test(normalized) ? normalized : '';
  }

  const dataValue = element.getAttribute('data') || '';
  return /^\d{4,}$/.test(dataValue) ? dataValue : '';
}

function hiddenAnswerForQuestion(qid: string, root?: HTMLElement | null) {
  const selector = `#answer${cssEscape(qid)}, input[name="answer${cssEscape(qid)}"]`;
  return (root?.querySelector(selector) || document.querySelector(selector)) as HTMLInputElement | null;
}

function canonicalSubmitRootFor(element: HTMLElement, hiddenAnswer: HTMLInputElement | null) {
  const elementRoot = element.closest(SUBMIT_QUESTION_CONTAINER_SELECTOR) as HTMLElement | null;
  if (elementRoot) return elementRoot;
  const hiddenRoot = hiddenAnswer?.closest(SUBMIT_QUESTION_CONTAINER_SELECTOR) as HTMLElement | null;
  if (hiddenRoot) return hiddenRoot;
  if (element.matches('[qid], [questionid], [qtype]')) return element;
  return document.body;
}

function submitRootScore(root: HTMLElement, qid: string, hiddenAnswer: HTMLInputElement) {
  let score = 0;
  if (root.contains(hiddenAnswer)) score += 100;
  if (root.matches('.singleQuestionDiv, .questionLi')) score += 90;
  else if (root.matches('.question, .question-item, .subject-item, .exam-question, .questionCard')) score += 70;
  else if (root.matches('.timu, .TiMu, .CeSheng')) score += 45;
  if (root.matches('.answerBg, .workTextWrap, .num_option, .num_option_dx, input')) score -= 80;
  if (root === document.body) score -= 120;
  const sameQidSelector = [
    `[qid="${cssEscape(qid)}"]`,
    `[questionid="${cssEscape(qid)}"]`,
    `.choice${cssEscape(qid)}`
  ].join(',');
  score += Math.min(root.querySelectorAll(sameQidSelector).length, 12);
  return score;
}

function collectSubmitQuestionRoots() {
  const candidates = uniqueElements(Array.from(document.querySelectorAll([
    '.singleQuestionDiv',
    '.questionLi',
    '[qid][qtype]',
    '[questionid][qtype]',
    'input[id^="answer"]',
    'input[name^="answer"]',
    '.TiMu'
  ].join(','))) as HTMLElement[]);
  const byQid = new Map<string, SubmitQuestionRoot>();

  for (const candidate of candidates) {
    const qid = questionIdFromSubmitElement(candidate);
    if (!qid) continue;
    const hiddenAnswer = hiddenAnswerForQuestion(qid, candidate);
    if (!hiddenAnswer) continue;
    const root = canonicalSubmitRootFor(candidate, hiddenAnswer);
    const typeHint = readQuestionTypeHint(root);
    const qtype = typeHint.qtype ||
      candidate.getAttribute('qtype') ||
      candidate.querySelector('[qtype]')?.getAttribute('qtype') ||
      '';
    const next: SubmitQuestionRoot = {
      qid,
      root,
      hiddenAnswer,
      qtype,
      score: submitRootScore(root, qid, hiddenAnswer)
    };
    const previous = byQid.get(qid);
    if (!previous || next.score > previous.score) byQid.set(qid, next);
  }

  return Array.from(byQid.values()).sort((a, b) => {
    const aTop = a.root.getBoundingClientRect?.().top ?? 0;
    const bTop = b.root.getBoundingClientRect?.().top ?? 0;
    return aTop - bTop;
  });
}

function optionElementsForSubmit(root: HTMLElement, qid: string) {
  const scopedByQid = uniqueElements(Array.from(root.querySelectorAll([
    `.choice${cssEscape(qid)}`,
    `.choice${cssEscape(qid)}[data]`,
    `.choice${cssEscape(qid)} .answerBg`,
    `.choice${cssEscape(qid)} .workTextWrap`,
    `[qid="${cssEscape(qid)}"] .answerBg`,
    `[qid="${cssEscape(qid)}"] .workTextWrap`,
    `[questionid="${cssEscape(qid)}"] .answerBg`,
    `[questionid="${cssEscape(qid)}"] .workTextWrap`,
    `[qid="${cssEscape(qid)}"][data]:not([qtype])`,
    `[questionid="${cssEscape(qid)}"][data]:not([qtype])`
  ].join(','))) as HTMLElement[]);
  const scopedOptions = scopedByQid.filter(isSubmitOptionElement);
  if (scopedOptions.length > 0) return scopedOptions;
  if (root === document.body) return [];
  return uniqueElements(Array.from(root.querySelectorAll([
    '.answerBg',
    '.workTextWrap',
    'input[type="radio"]',
    'input[type="checkbox"]',
    '[role="radio"]',
    '[role="checkbox"]'
  ].join(','))) as HTMLElement[]).filter(isSubmitOptionElement);
}

export function syncAnswersBeforeSave() {
  const questionRoots = collectSubmitQuestionRoots();
  let updated = 0;
  const details: Array<Record<string, unknown>> = [];

  for (const item of questionRoots) {
    const { qid, root, hiddenAnswer, qtype } = item;
    const appliedAnswer = appliedAnswerFor(qid);
    if (appliedAnswer) {
      if (hiddenAnswer.value !== appliedAnswer.answer) {
        hiddenAnswer.value = appliedAnswer.answer;
        dispatchInput(hiddenAnswer);
        updated += 1;
      }
      details.push({
        qid,
        qtype,
        value: hiddenAnswer.value,
        lockedByStudyPilot: true,
        labels: appliedAnswer.labels
      });
      continue;
    }
    const optionElements = optionElementsForSubmit(root, qid);
    const values = Array.from(new Set<string>(optionElements
      .map(selectedOptionValue)
      .map((value) => {
        if (qtype === '3') return parseStrictJudgementOption(value) || parseJudgementValueStable(value) || value;
        return /^[A-Z]$/i.test(value) ? value.toUpperCase() : value;
      })
      .filter(Boolean)));
    if (values.length === 0) continue;
    const nextValue = qtype === '1' || qtype === '21'
      ? values.slice().sort().join('')
      : values[0];
    if (hiddenAnswer.value !== nextValue) {
      hiddenAnswer.value = nextValue;
      dispatchInput(hiddenAnswer);
      updated += 1;
    }
    details.push({ qid, qtype, value: hiddenAnswer.value, selected: values });
  }

  reportWebviewError('webview:sync-before-save', {
    level: 'info',
    message: `Synced ${updated} answers before save/submit`,
    details: {
      updated,
      total: questionRoots.length,
      recorded: details.length,
      sampleAnswers: details.slice(0, 8),
      tailAnswers: details.length > 8 ? details.slice(-4) : []
    }
  });
}
