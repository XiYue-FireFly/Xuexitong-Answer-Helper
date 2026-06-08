import { cleanText, isVisible, visibleText } from './dom-utils';
import { dispatchUserClick } from './interaction';

function currentExamQuestionSignature() {
  const root = document.querySelector('.singleQuestionDiv') as HTMLElement | null;
  if (!root) return '';
  return [
    root.getAttribute('data') || '',
    visibleText(root.querySelector('.mark_name') || root).slice(0, 180)
  ].join('|');
}

function isFullExamPreviewPage() {
  const text = cleanText(document.body?.innerText || '');
  return /全卷预览|整卷预览|答题卡|提交试卷|交卷|保存并提交/.test(text) &&
    !document.querySelector('.singleQuestionDiv .nextDiv a');
}

function isForwardExamNextButton(element: HTMLElement) {
  if (!isVisible(element)) return false;
  const text = cleanText(element.innerText || element.textContent || '');
  const inline = element.getAttribute('onclick') || '';
  const aria = element.getAttribute('aria-label') || element.getAttribute('title') || '';
  const haystack = `${text} ${aria}`.replace(/\s+/g, '');
  if (/上一题|上一步|prev|previous/i.test(`${haystack} ${inline}`)) return false;
  if (/getTheNextQuestion\s*\(\s*-\s*1\s*\)/i.test(inline)) return false;
  if (/下一题|下一步/.test(haystack)) return true;
  if (/topreview\s*\(/i.test(inline)) return true;
  const nextMatch = inline.match(/getTheNextQuestion\s*\(\s*([^)]+)\s*\)/i);
  if (nextMatch) {
    const step = Number(String(nextMatch[1]).replace(/[^\d.-]/g, ''));
    return Number.isFinite(step) && step > 0;
  }
  return false;
}

export async function clickNextExamQuestion() {
  const before = currentExamQuestionSignature();
  const candidates = Array.from(document.querySelectorAll('a, button, [role="button"]')) as HTMLElement[];
  const nextButton = candidates.find((element) => {
    if (!isVisible(element)) return false;
    if (!isForwardExamNextButton(element)) return false;
    return true;
    const text = cleanText(element.innerText || element.textContent || '');
    const inline = element.getAttribute('onclick') || '';
    const className = String(element.className || '');
    return /下一题|下一步/.test(text) ||
      /getTheNextQuestion/i.test(inline) ||
      /nextDiv|next/i.test(className);
  });

  if (!nextButton) {
    return {
      success: false,
      done: isFullExamPreviewPage(),
      error: isFullExamPreviewPage() ? undefined : '未找到“下一题/下一步”按钮。'
    };
  }

  nextButton.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  await new Promise((resolve) => setTimeout(resolve, 180));
  dispatchUserClick(nextButton);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 7000) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const after = currentExamQuestionSignature();
    if (after && after !== before) {
      return { success: true, done: false, message: '已切换到下一题。' };
    }
    if (!after && isFullExamPreviewPage()) {
      return { success: true, done: true, message: '已进入全卷浏览。' };
    }
  }

  return {
    success: true,
    done: isFullExamPreviewPage(),
    message: isFullExamPreviewPage() ? '已进入全卷浏览。' : '已点击下一题，页面未检测到明显题号变化。'
  };
}

