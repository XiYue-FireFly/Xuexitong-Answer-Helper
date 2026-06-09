import type { QuestionOptionTarget } from './types';
import { normalizeText, visibleText } from './dom-utils';

export function answerAliases(text: string) {
  const normalized = normalizeText(text);
  const aliases = new Set([normalized]);
  if (/正确|對|对|true|yes|是/.test(normalized)) {
    ['正确', '对', 'true', 'yes', '是'].forEach((value) => aliases.add(value));
  }
  if (/错误|錯|错|false|no|否/.test(normalized)) {
    ['错误', '错', 'false', 'no', '否'].forEach((value) => aliases.add(value));
  }
  return Array.from(aliases).filter(Boolean);
}

export function judgementValueFromText(text: string): 'true' | 'false' | null {
  const value = String(text || '').toLowerCase().replace(/\s+/g, '');
  if (!value) return null;
  if (/(正确|对|是|√|✓|true|yes|right|correct|t\b|1)/i.test(value)) return 'true';
  if (/(错误|错|否|×|✕|false|no|wrong|incorrect|f\b|0)/i.test(value)) return 'false';
  return null;
}

export function parseJudgementValue(text: string): 'true' | 'false' | null {
  const value = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\u3002\uff0c\uff1b,.;:?;\/]/g, '');
  if (!value) return null;

  const trueValues = new Set(['true', 't', '1', 'yes', 'y', 'right', 'correct', 'ri', '\u6b63\u786e', '\u5bf9', '\u662f']);
  const falseValues = new Set(['false', 'f', '0', 'no', 'n', 'wrong', 'incorrect', 'wr', 'x', '\u9519\u8bef', '\u9519', '\u5426']);

  if (trueValues.has(value)) return 'true';
  if (falseValues.has(value)) return 'false';
  if (/(\u6b63\u786e|\u5bf9|\u662f|true|yes|right|correct)/i.test(value)) return 'true';
  if (/(\u9519\u8bef|\u9519|\u5426|false|wrong|incorrect)/i.test(value)) return 'false';
  return null;
}

export function parseStrictJudgementOption(text: string): 'true' | 'false' | null {
  const raw = String(text || '')
    .replace(/^[A-H]\s*[.、．):：]?\s*/i, '')
    .trim();
  const value = raw
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\u3002\uff0c\uff1b,.;:?;\/()（）【】\[\]]/g, '');
  if (!value) return null;
  if (/^(true|t|1|yes|y|right|correct|ri|\u6b63\u786e|\u5bf9|\u662f|\u221a|\u2713|\u2714)$/.test(value)) return 'true';
  if (/^(false|f|0|no|n|wrong|incorrect|wr|x|\u9519\u8bef|\u9519|\u5426|\u00d7|\u2717|\u2718)$/.test(value)) return 'false';
  return null;
}

export function judgementValueFromOptionTarget(target: QuestionOptionTarget) {
  return parseStrictJudgementOption(target.value || '') ||
    parseStrictJudgementOption(target.text || '');
}

export function judgementValueFromElement(element: HTMLElement | null) {
  if (!element) return null;
  const marker = element.matches('.num_option, .num_option_dx, [data], [value]')
    ? element
    : element.querySelector('.num_option, .num_option_dx, [data], [value]');
  const input = element.matches('input[type="radio"], input[type="checkbox"]')
    ? element as HTMLInputElement
    : element.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLInputElement | null;
  return parseJudgementValueStable([
    element.getAttribute('data'),
    marker?.getAttribute('data'),
    element.getAttribute('value'),
    marker?.getAttribute('value'),
    input?.value,
    element.getAttribute('aria-label'),
    visibleText(element)
  ].filter(Boolean).join(' '));
}

export function parseJudgementValueStable(text: string): 'true' | 'false' | null {
  const raw = String(text || '').trim();
  const value = raw.toLowerCase().replace(/\s+/g, '');
  if (!value) return null;
  if (/^(true|t|1|yes|y|right|correct|ri)$/.test(value)) return 'true';
  if (/^(false|f|0|no|n|wrong|incorrect|wr|x)$/.test(value)) return 'false';

  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (code === 0x6b63 || code === 0x5bf9 || code === 0x662f || code === 0x221a || code === 0x2713 || code === 0x2714) {
      return 'true';
    }
    if (code === 0x9519 || code === 0x5426 || code === 0x00d7 || code === 0x2717 || code === 0x2718) {
      return 'false';
    }
  }

  if (/(true|yes|right|correct)/i.test(raw)) return 'true';
  if (/(false|wrong|incorrect)/i.test(raw)) return 'false';
  return null;
}

export function clearMatchString(text: string) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/^[A-ZＡ-Ｈ]\s*[^A-Za-z0-9\u2E80-\u9FFF]+/i, '')
    .replace(/[^\u2E80-\u9FFFA-Za-z0-9]+/g, '');
}

export function compareTwoStrings(first: string, second: string) {
  first = clearMatchString(first);
  second = clearMatchString(second);
  if (first === second) return 1;
  if (first.length < 2 || second.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let index = 0; index < first.length - 1; index += 1) {
    const bigram = first.slice(index, index + 2);
    bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
  }
  let intersection = 0;
  for (let index = 0; index < second.length - 1; index += 1) {
    const bigram = second.slice(index, index + 2);
    const count = bigrams.get(bigram) || 0;
    if (count > 0) {
      bigrams.set(bigram, count - 1);
      intersection += 1;
    }
  }
  return (2 * intersection) / (first.length + second.length - 2);
}
