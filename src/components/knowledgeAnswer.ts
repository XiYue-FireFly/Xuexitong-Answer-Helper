import type { QuestionBankEntry, QuestionType } from '../store/appStore';

export function getEntryType(entry: QuestionBankEntry): QuestionType {
  if (entry.type && ['single', 'multiple', 'judgement', 'completion', 'essay'].includes(entry.type)) return entry.type;
  // Captured metadata and explicit type labels win over heuristics and AI answers.
  if (/判断题/.test(entry.question)) return 'judgement';
  if (/多选题|多项选择|多选/.test(entry.question)) return 'multiple';
  if (/单选题|单项选择|单选/.test(entry.question)) return 'single';
  if (/填空题|填空/.test(entry.question)) return 'completion';
  if (/问答题|简答题|论述题/.test(entry.question)) return 'essay';
  const judgementOptions = entry.options.map(judgementValue);
  if (judgementOptions.length === 2 && judgementOptions.includes(true) && judgementOptions.includes(false)) return 'judgement';
  const text = `${entry.question}\n${entry.options.join('\n')}`;
  if (entry.options.length <= 2 && !entry.answer.choiceLabels.length && /^(true|false)$/i.test(entry.answer.answer.trim()) &&
    !/单选|单项选择|多选|多项选择|填空|问答|简答/.test(entry.question)) return 'judgement';
  if (/填空题|填空/.test(text) || entry.options.length === 0) return 'completion';
  if (/多选题|多选/.test(text) || entry.answer.choiceLabels.length > 1) return 'multiple';
  return 'single';
}

function judgementValue(answer: string): boolean | null {
  const value = answer.normalize('NFKC').replace(/^\s*[A-Z]\s*[.、:。)\s]\s*/i, '').trim();
  if (/^(true|correct|正确|对|是|√|✓|✔)$/i.test(value)) return true;
  if (/^(false|wrong|incorrect|错误|错|否|×|✗|✘)$/i.test(value)) return false;
  return null;
}

export function judgementAnswerText(answer: string) {
  const value = judgementValue(answer);
  return value === null ? answer : value ? '正确' : '错误';
}

export function isCorrectOption(entry: QuestionBankEntry, option: string, index: number) {
  if (getEntryType(entry) === 'judgement') {
    const value = judgementValue(entry.answer.answer);
    if (value !== null) return judgementValue(option) === value;
  }
  const label = option.match(/^\s*([A-H])\s*[.\s:：、。)]/i)?.[1]?.toUpperCase() || String.fromCharCode(65 + index);
  return entry.answer.choiceLabels.map(value => value.toUpperCase()).includes(label) ||
    new RegExp(`(^|[^A-Z])${label}([^A-Z]|$)`, 'i').test(entry.answer.answer);
}
