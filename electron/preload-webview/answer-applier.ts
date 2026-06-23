import type { AnswerApplyPayload, QuestionOptionTarget } from './types';
import { appliedAnswerFor, rememberAppliedAnswer } from './applied-answer-store';
import { answerAliases, compareTwoStrings, judgementValueFromElement, judgementValueFromOptionTarget, judgementValueFromText, parseJudgementValueStable } from './answer-matcher';
import { reportWebviewError } from './bridge';
import { cleanText, cssEscape, dispatchInput, isVisible, normalizeText, optionLetter, selectedClassHit, selectorFor, uniqueElements } from './dom-utils';
import { dispatchUserClick } from './interaction';
import { extractOptionTargets, nearestClickableOption, optionTargetFromElement, readQuestionTypeHint } from './question-extractor';

function fallbackAnswerTargets(payload: AnswerApplyPayload): QuestionOptionTarget[] {
  const root = payload.question?.selector
    ? (document.querySelector(payload.question.selector) as HTMLElement | null) || document.body
    : document.body;
  const targets = extractOptionTargets(root);
  if (targets.length > 0) return targets;

  return (payload.question?.options || []).map((option, index) => ({
    label: option.match(/^\s*([A-Z])\s*[.\s:：、．。)]/i)?.[1]?.toUpperCase() || optionLetter(index),
    text: option
  }));
}

function questionRootForPayload(payload: AnswerApplyPayload) {
  if (payload.question?.selector) {
    const root = document.querySelector(payload.question.selector) as HTMLElement | null;
    if (root) return root;
  }
  return document.body;
}

function qidForPayload(payload: AnswerApplyPayload) {
  const root = questionRootForPayload(payload);
  const normalizeQid = (value: string | null | undefined) => {
    const normalized = cleanText(value || '');
    return /^\d{4,}$/.test(normalized) ? normalized : '';
  };
  const isBroadRoot = root === document.body;
  const hiddenAnswers = Array.from(root.querySelectorAll<HTMLInputElement>('input[id^="answer"], input[name^="answer"]'));
  const hiddenAnswer = !isBroadRoot || hiddenAnswers.length === 1 ? hiddenAnswers[0] : null;
  const hiddenMatch = hiddenAnswer?.id?.match(/^answer(.+)$/i)?.[1] ||
    hiddenAnswer?.name?.match(/^answer(.+)$/i)?.[1] ||
    '';
  const uniqueDescendantQid = (attribute: 'qid' | 'questionid') => {
    const values = Array.from(root.querySelectorAll(`[${attribute}]`))
      .map((element) => normalizeQid(element.getAttribute(attribute)))
      .filter(Boolean);
    const unique = Array.from(new Set(values));
    return !isBroadRoot || unique.length === 1 ? unique[0] || '' : '';
  };
  const candidates = [
    root.getAttribute('qid'),
    root.getAttribute('questionid'),
    uniqueDescendantQid('qid'),
    uniqueDescendantQid('questionid'),
    !isBroadRoot || root.querySelectorAll('input[name="questionId"]').length === 1
      ? root.querySelector<HTMLInputElement>('input[name="questionId"]')?.value
      : '',
    hiddenMatch,
    root.getAttribute('data')
  ];
  return candidates.map(normalizeQid).find(Boolean) || '';
}

function optionTargetByLabel(payload: AnswerApplyPayload, label: string): QuestionOptionTarget | null {
  const savedTarget = (payload.question?.optionTargets || [])
    .find((target) => target.label.toUpperCase() === label.toUpperCase());
  if (savedTarget) return savedTarget;

  const root = questionRootForPayload(payload);
  const qid = qidForPayload(payload);
  const upper = label.toUpperCase();
  const selectors = [
    qid ? `[qid="${cssEscape(qid)}"][data="${cssEscape(upper)}"]` : '',
    qid ? `.choice${cssEscape(qid)}[data="${cssEscape(upper)}"]` : '',
    qid ? `[questionid="${cssEscape(qid)}"][data="${cssEscape(upper)}"]` : '',
    `[data="${cssEscape(upper)}"][qid]`,
    `[data="${cssEscape(upper)}"][questionid]`,
    `[aria-label^="${cssEscape(upper)}"]`,
    `[aria-label*="${cssEscape(upper)}."]`
  ].filter(Boolean);

  for (const selector of selectors) {
    const element = (root.querySelector(selector) || document.querySelector(selector)) as HTMLElement | null;
    if (element) return optionTargetFromElement(element, upper.charCodeAt(0) - 65);
  }

  const index = upper.charCodeAt(0) - 65;
  const options = extractOptionTargets(root);
  return options[index] || null;
}

function judgementTargets(payload: AnswerApplyPayload, targets: QuestionOptionTarget[]) {
  const answerValue = judgementValueFromText(`${payload.answer || ''} ${(payload.matchedOptions || []).join(' ')}`);
  if (!answerValue) return [];

  const semantic = targets.filter((target) => judgementValueFromText(target.text) === answerValue);
  if (semantic.length > 0) return semantic.slice(0, 1);

  const qid = qidForPayload(payload);
  if (qid) {
    const values = answerValue === 'true'
      ? ['true', '1', 'Y', 'YES', 'T', 'right', 'correct']
      : ['false', '0', 'N', 'NO', 'F', 'wrong', 'incorrect'];
    for (const value of values) {
      const selector = `[qid="${cssEscape(qid)}"][data="${cssEscape(value)}"], [qid="${cssEscape(qid)}"][value="${cssEscape(value)}"], [questionid="${cssEscape(qid)}"][data="${cssEscape(value)}"]`;
      const element = document.querySelector(selector) as HTMLElement | null;
      if (element) return [optionTargetFromElement(element, answerValue === 'true' ? 0 : 1)];
    }
  }

  if (targets.length === 2) return [targets[answerValue === 'true' ? 0 : 1]];
  return [];
}

function answerOptionContainer(element: HTMLElement) {
  return (element.closest([
    '.answerBg',
    '.workTextWrap',
    '[qid][qtype]',
    '[questionid][qtype]',
    '[role="radio"]',
    '[role="checkbox"]',
    'label',
    'li'
  ].join(',')) as HTMLElement | null) || element;
}

function pickJudgementTargets(payload: AnswerApplyPayload, targets: QuestionOptionTarget[]) {
  const answerValue = parseJudgementValueStable(`${payload.answer || ''} ${(payload.matchedOptions || []).join(' ')}`);
  if (!answerValue) return [];

  const semantic = targets.filter((target) => judgementValueFromOptionTarget(target) === answerValue);
  if (semantic.length > 0) return semantic.slice(0, 1);

  const qid = qidForPayload(payload);
  if (qid) {
    const root = questionRootForPayload(payload);
    const values = answerValue === 'true'
      ? ['true', '1', 'Y', 'YES', 'T', 'right', 'correct', '\u6b63\u786e', '\u5bf9']
      : ['false', '0', 'N', 'NO', 'F', 'wrong', 'incorrect', '\u9519\u8bef', '\u9519'];
    for (const value of values) {
      const selector = [
        `[qid="${cssEscape(qid)}"][data="${cssEscape(value)}"]`,
        `[qid="${cssEscape(qid)}"][value="${cssEscape(value)}"]`,
        `[questionid="${cssEscape(qid)}"][data="${cssEscape(value)}"]`,
        `[qid="${cssEscape(qid)}"] .num_option[data="${cssEscape(value)}"]`,
        `[qid="${cssEscape(qid)}"] .num_option_dx[data="${cssEscape(value)}"]`,
        `.choice${cssEscape(qid)}[data="${cssEscape(value)}"]`,
        `.choice${cssEscape(qid)} .num_option[data="${cssEscape(value)}"]`,
        `.choice${cssEscape(qid)} .num_option_dx[data="${cssEscape(value)}"]`
      ].join(',');
      const element = (root.querySelector(selector) || document.querySelector(selector)) as HTMLElement | null;
      if (element) return [optionTargetFromElement(answerOptionContainer(element), answerValue === 'true' ? 0 : 1)];
    }
  }

  if (targets.length === 2) return [targets[answerValue === 'true' ? 0 : 1]];
  return [];
}

function qtypeForPayload(payload: AnswerApplyPayload) {
  const root = questionRootForPayload(payload);
  return root.getAttribute('qtype') || root.querySelector('[qtype]')?.getAttribute('qtype') || '';
}

function hasExplicitJudgementType(payload: AnswerApplyPayload) {
  const qtype = qtypeForPayload(payload);
  return payload.question?.type === 'judgement' || qtype === '3';
}

function isJudgementPayload(payload: AnswerApplyPayload, targets: QuestionOptionTarget[] = []) {
  if (hasExplicitJudgementType(payload)) return true;
  if (payload.question?.type === 'multiple' || isMultipleChoicePayload(payload)) return false;
  if (payload.question?.type === 'single' || qtypeForPayload(payload) === '0') return false;
  const meaningfulTargets = targets.filter((target) => target.value || target.text);
  if (meaningfulTargets.length !== 2) return false;
  const values = meaningfulTargets.map(judgementValueFromOptionTarget);
  return values.includes('true') && values.includes('false');
}

function isMultipleChoicePayload(payload: AnswerApplyPayload) {
  const qtype = qtypeForPayload(payload);
  return payload.question?.type === 'multiple' || qtype === '1' || qtype === '21';
}

function normalizeChoiceLabels(labels: string[], allowMultiple: boolean) {
  const unique = Array.from(new Set(labels
    .map((label) => String(label || '').trim().toUpperCase())
    .filter((label) => /^[A-H]$/.test(label))));
  return allowMultiple ? unique : unique.slice(0, 1);
}

function labelsFromAnswerText(text: string, allowMultiple: boolean) {
  const value = String(text || '').trim();
  const labels: string[] = [];
  const compact = value.replace(/\s+/g, '').match(/^[A-H]{1,8}$/i)?.[0] || '';
  if (compact) {
    labels.push(...compact.split(''));
  } else {
    labels.push(...Array.from(value.matchAll(/(?:答案|选项|选择|^|[^A-Za-z])([A-H])(?:[^A-Za-z]|$)/gi))
      .map((match) => match[1]));
  }
  return normalizeChoiceLabels(labels, allowMultiple);
}

function labelsFromPayload(payload: AnswerApplyPayload) {
  const allowMultiple = isMultipleChoicePayload(payload);
  const explicitLabels = normalizeChoiceLabels(payload.choiceLabels || [], allowMultiple);
  if (explicitLabels.length > 0) return explicitLabels;
  return labelsFromAnswerText(payload.answer || '', allowMultiple);
}

function answerValuesFromTargets(targets: QuestionOptionTarget[], allowMultiple: boolean) {
  const values = targets
    .map((target) => cleanText(target.value || target.label).toUpperCase())
    .filter(Boolean);
  const unique = Array.from(new Set(values));
  return allowMultiple ? unique.slice().sort() : unique.slice(0, 1);
}

function textScore(answer: string, option: string) {
  const answerValues = answerAliases(answer);
  const optionValues = answerAliases(option);
  let best = 0;
  for (const answerValue of answerValues) {
    for (const optionValue of optionValues) {
      if (!answerValue || !optionValue) continue;
      if (answerValue === optionValue) best = Math.max(best, 100);
      if (answerValue.includes(optionValue) || optionValue.includes(answerValue)) {
        best = Math.max(best, Math.min(answerValue.length, optionValue.length) / Math.max(answerValue.length, optionValue.length));
      }
      best = Math.max(best, compareTwoStrings(answerValue, optionValue));
    }
  }
  return best;
}

function pickAnswerTargets(payload: AnswerApplyPayload) {
  const question = payload.question;
  const scannedTargets = fallbackAnswerTargets(payload);
  const savedTargets = question?.optionTargets || [];
  const targets = [...scannedTargets, ...savedTargets]
    .filter((target, index, all) => all.findIndex((item) => `${item.label}:${item.text}:${item.selector || item.inputSelector || ''}` === `${target.label}:${target.text}:${target.selector || target.inputSelector || ''}`) === index)
    .sort((left, right) => Number(Boolean(right.inputSelector)) - Number(Boolean(left.inputSelector)));
  const judgementSelected = isJudgementPayload(payload, targets) ? pickJudgementTargets(payload, targets) : [];
  if (judgementSelected.length > 0) return judgementSelected;
  const labelSet = new Set(labelsFromPayload(payload));

  let selected: QuestionOptionTarget[] = [];
  if (labelSet.size > 0) {
    selected = Array.from(labelSet)
      .map((label) => optionTargetByLabel(payload, label))
      .filter(Boolean) as QuestionOptionTarget[];
  }
  if (selected.length === 0) {
    selected = targets.filter((target) => labelSet.has(target.label.toUpperCase()));
  }
  if (selected.length === 0 && labelSet.size > 0 && targets.length > 0) {
    selected = Array.from(labelSet)
      .map((label) => targets[label.charCodeAt(0) - 65])
      .filter(Boolean) as QuestionOptionTarget[];
  }
  if (selected.length === 0) {
    const answerCandidates = answerPartsFromPayload(payload);
    const scored = targets
      .map((target) => ({
        target,
        score: Math.max(...answerCandidates.map((answer) => textScore(String(answer), target.text)), 0)
      }))
      .sort((left, right) => right.score - left.score);
    const best = scored[0];
    if (best && best.score >= 0.42) selected = [best.target];
  }

  return selected;
}

function shouldRewritePageSelection(payload: AnswerApplyPayload, targets: QuestionOptionTarget[]) {
  if (isJudgementPayload(payload, targets)) return true;
  if (!targets.some((target) => target.selector || target.inputSelector || target.clickSelector)) return true;
  const requestedLabels = labelsFromPayload(payload);
  if (requestedLabels.length === 0) return true;
  const selectedLabels = targets.map((target) => target.label.toUpperCase());
  return !requestedLabels.every((label) => selectedLabels.includes(label.toUpperCase()));
}

function answerPartsFromPayload(payload: AnswerApplyPayload) {
  return [
    payload.answer,
    ...(payload.matchedOptions || []),
    ...String(payload.answer || '').split(/[、,，;；\n/]+/g)
  ].map((item) => cleanText(item)).filter(Boolean);
}

function isFillQuestion(payload: AnswerApplyPayload) {
  const root = questionRootForPayload(payload);
  const hasFields = root.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"]').length > 0;
  return payload.question?.type === 'completion' || (hasFields && extractOptionTargets(root).length === 0);
}

function fillElementValue(element: HTMLElement, value: string) {
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  element.focus();
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    nativeSetter?.call(element, value);
    element.value = value;
    const pageAny = window as any;
    const editorName = element.getAttribute('name') || element.id || '';
    try {
      const editor = editorName && pageAny.UE?.getEditor?.(editorName);
      if (editor?.setContent) editor.setContent(value);
    } catch {
      // Ignore editor sync failures; native field events still fire below.
    }
  } else if (element.isContentEditable) {
    element.textContent = value;
  }
  dispatchInput(element);
  element.dispatchEvent(new Event('blur', { bubbles: true }));
}

function isCompletionField(element: HTMLElement) {
  if (!isVisible(element)) return false;
  if (element instanceof HTMLInputElement) {
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    if (['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'password'].includes(type)) return false;
    const nameText = `${element.name || ''} ${element.id || ''} ${element.className || ''} ${element.placeholder || ''}`;
    if (/(search|keyword|captcha|verify|phone|mobile|email|username|password|token)/i.test(nameText)) return false;
  }
  const disabled = (element as HTMLInputElement | HTMLTextAreaElement).disabled || element.getAttribute('aria-disabled') === 'true';
  const readOnly = (element as HTMLInputElement | HTMLTextAreaElement).readOnly || element.getAttribute('readonly') !== null;
  return !disabled && !readOnly;
}

function cleanCompletionValue(rawValue: string) {
  return cleanText(rawValue)
    .replace(/^(?:答案|参考答案|填空答案)\s*[:：]\s*/i, '')
    .replace(/\s*(?:解析|分析|说明)\s*[:：][\s\S]*$/i, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
}

function completionValuesFromPayload(payload: AnswerApplyPayload) {
  const raw = [
    payload.answer,
    ...(payload.matchedOptions || [])
  ].map((item) => cleanCompletionValue(item)).filter(Boolean).join('\n');
  const explicit = Array.from(raw.matchAll(/(?:第?\s*(\d+)\s*(?:空|题)?|blank\s*(\d+))\s*[:：.、)]\s*([^\n;；|]+)/gi))
    .map((match) => cleanCompletionValue(match[3] || ''))
    .filter(Boolean);
  if (explicit.length > 0) return explicit;

  const parts = raw
    .split(/(?:\n|;|；|\|)/g)
    .map((part) => cleanCompletionValue(part).replace(/^第?\d+\s*[空题]?\s*[:：.、)]?\s*/, ''))
    .filter(Boolean);
  if (parts.length > 1) return parts;

  const commaParts = raw
    .split(/[,，、]/g)
    .map((part) => cleanCompletionValue(part).replace(/^第?\d+\s*[空题]?\s*[:：.、)]?\s*/, ''))
    .filter(Boolean);
  if (commaParts.length > 1 && commaParts.every((part) => part.length <= 40)) return commaParts;

  return [cleanCompletionValue(payload.answer || raw || '')].filter(Boolean);
}

function syncCompletionAnswerWithPage(qid: string, values: string[]) {
  if (!qid) return;
  const pageAny = window as any;
  const value = values.join('|');
  for (const functionName of ['setBlankAnswer', 'setClozeTextAnswer', 'fillBlank']) {
    const handler = pageAny[functionName];
    if (typeof handler !== 'function') continue;
    try {
      handler(qid, value);
    } catch (error) {
      reportWebviewError('webview:completion-page-sync-failed', {
        level: 'warn',
        message: `${functionName} 同步填空答案失败，已保留可见输入框内容。`,
        details: { qid, error: String(error) }
      });
    }
  }
  if (typeof pageAny.answerContentChange === 'function') {
    try {
      pageAny.answerContentChange();
    } catch (error) {
      reportWebviewError('webview:completion-change-callback-failed', {
        level: 'warn',
        message: 'answerContentChange 回调失败，已保留可见输入框内容。',
        details: { qid, error: String(error) }
      });
    }
  }
}

function applyCompletionAnswer(payload: AnswerApplyPayload) {
  const root = questionRootForPayload(payload);
  const fields = (Array.from(root.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"]')) as HTMLElement[])
    .filter(isCompletionField);
  if (fields.length === 0) return { success: false, error: '未找到可填写的填空输入框。' };

  const values = completionValuesFromPayload(payload);
  if (values.length === 0) return { success: false, error: '填空答案为空，未执行填入。' };
  fields.forEach((field, index) => fillElementValue(field, values[index] || values[0] || ''));

  const qid = qidForPayload(payload);
  if (qid) {
    const hiddenAnswer = document.querySelector(`#answer${cssEscape(qid)}`) as HTMLInputElement | null;
    if (hiddenAnswer) {
      hiddenAnswer.value = values.join('|');
      dispatchInput(hiddenAnswer);
    }
  }

  syncCompletionAnswerWithPage(qid, values);

  const failedFields = fields.filter((field, index) => {
    const expected = values[index] || values[0] || '';
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      return cleanText(field.value) !== cleanText(expected);
    }
    return cleanText(field.textContent || '') !== cleanText(expected);
  });
  if (failedFields.length > 0) {
    return { success: false, error: `填空答案写入后校验失败：${failedFields.length} 个输入框未保持目标值。`, values };
  }

  const warning = fields.length > values.length ? `答案数量少于空格数量，已将第一个答案复用到剩余 ${fields.length - values.length} 个空。` : '';
  if (warning) {
    reportWebviewError('webview:completion-answer-count-mismatch', {
      level: 'warn',
      message: warning,
      details: { fieldCount: fields.length, valueCount: values.length, qid }
    });
  }

  return {
    success: true,
    message: warning || `已填入 ${Math.min(fields.length, values.length)} 个填空答案。`,
    values
  };
}

function applyAnswerDirectly(payload: AnswerApplyPayload, targets: QuestionOptionTarget[], clickSelected = true) {
  console.log('[StudyPilot] applyAnswerDirectly 开始');
  console.log('[StudyPilot] targets 数量:', targets.length, 'clickSelected:', clickSelected);

  const answerText = `${payload.answer || ''} ${(payload.matchedOptions || []).join(' ')}`;
  const judgementValue = isJudgementPayload(payload, targets) ? parseJudgementValueStable(answerText) : null;
  console.log('[StudyPilot] judgementValue:', judgementValue);

  const labels = judgementValue ? [] : (targets.length > 0 ? targets.map((target) => target.label.toUpperCase()) : labelsFromPayload(payload));
  const qid = qidForPayload(payload);
  console.log('[StudyPilot] qid:', qid, 'labels:', labels);

  if (!qid || (!judgementValue && labels.length === 0)) {
    console.log('[StudyPilot] qid 或 labels 为空，返回 false');
    return false;
  }

  const root = questionRootForPayload(payload);
  const isJudgement = Boolean(judgementValue) || root.getAttribute('qtype') === '3' || Boolean(root.querySelector('[qtype="3"]'));
  const isMultiple = !isJudgement && (root.getAttribute('qtype') === '1' || Boolean(root.querySelector('[qtype="1"], [qtype="21"]')));
  const pageValues = !isJudgement && targets.length > 0
    ? answerValuesFromTargets(targets, isMultiple)
    : (isMultiple ? labels.slice().sort() : labels);
  const answer = isJudgement && judgementValue ? judgementValue : pageValues.join('');

  console.log('[StudyPilot] isJudgement:', isJudgement, 'isMultiple:', isMultiple, 'answer:', answer);

  const hiddenAnswer = document.querySelector(`#answer${cssEscape(qid)}`) as HTMLInputElement | null;
  if (hiddenAnswer) {
    console.log('[StudyPilot] 找到隐藏输入字段，当前值:', hiddenAnswer.value, '设置为:', answer);
    hiddenAnswer.value = answer;
    dispatchInput(hiddenAnswer);
  } else {
    console.log('[StudyPilot] 未找到隐藏输入字段 #answer' + qid);
  }

  rememberAppliedAnswer(qid, answer, labels);

  if (isJudgement) {
    reportWebviewError('webview:apply-answer-judgement', {
      level: 'info',
      message: `Applied judgement answer: ${answer}`,
      details: {
        qid,
        answer,
        hasHiddenAnswer: Boolean(hiddenAnswer),
        targets: targets.map((target) => ({
          label: target.label,
          value: target.value,
          text: target.text,
          selector: target.selector,
          inputSelector: target.inputSelector,
          clickSelector: target.clickSelector
        }))
      }
    });
  }

  const optionElements = uniqueElements(Array.from(document.querySelectorAll([
    `.choice${cssEscape(qid)}`,
    `[qid="${cssEscape(qid)}"]`,
    `[questionid="${cssEscape(qid)}"]`
  ].join(','))) as HTMLElement[]);
  const optionTargetElements = uniqueElements((payload.question?.optionTargets || targets)
    .flatMap((target) => optionElementsForTarget(target)));
  const allOptionElements = uniqueElements([...optionElements, ...optionTargetElements])
    .filter((element) => isSingleOptionElement(element));

  console.log('[StudyPilot] 找到 optionElements 数量:', optionElements.length);

  // 判断题特殊处理：优先使用 .answerBg 逻辑
  if (isJudgement) {
    console.log('[StudyPilot] 判断题特殊处理 - 查找 .answerBg 元素');
    const answerBgElements = Array.from(root.querySelectorAll('.answerBg')) as HTMLElement[];
    console.log('[StudyPilot] 找到 answerBg 元素数量:', answerBgElements.length);

    if (answerBgElements.length > 0) {
      for (const answerBg of answerBgElements) {
        const numOption = answerBg.querySelector('.num_option, .num_option_dx, [data]') as HTMLElement | null;
        if (!numOption) {
          console.log('[StudyPilot] answerBg 没有 num_option 或 data 属性，跳过');
          continue;
        }

        const bgValue = judgementValueFromElement(answerBg);
        console.log('[StudyPilot] answerBg 值:', bgValue, '目标答案:', answer);

        if (!bgValue) {
          console.log('[StudyPilot] 无法解析 answerBg 的值，跳过');
          continue;
        }

        const selected = bgValue === answer;
        console.log('[StudyPilot] 是否匹配:', selected);

        const singleMarker = answerBg.querySelector('.num_option') as HTMLElement | null;
        const multiMarker = answerBg.querySelector('.num_option_dx') as HTMLElement | null;
        if (singleMarker) {
          console.log('[StudyPilot] 设置 singleMarker check_answer class:', selected);
          singleMarker.classList.toggle('check_answer', selected);
        }
        if (multiMarker) {
          console.log('[StudyPilot] 设置 multiMarker check_answer_dx class:', selected);
          multiMarker.classList.toggle('check_answer_dx', selected);
        }
        answerBg.setAttribute('aria-checked', selected ? 'true' : 'false');

        if (selected && clickSelected) {
          console.log('[StudyPilot] 点击匹配的 answerBg 元素');
          answerBg.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
          dispatchUserClick(answerBg);
        }
      }

      const pageAny = window as any;
      if (typeof pageAny.loadAnswerSheet === 'function') {
        console.log('[StudyPilot] 调用 loadAnswerSheet');
        pageAny.loadAnswerSheet(qid, answer);
      }
      if (typeof pageAny.answerContentChange === 'function') {
        console.log('[StudyPilot] 调用 answerContentChange');
        pageAny.answerContentChange();
      }
      console.log('[StudyPilot] 判断题特殊处理完成，返回 true');
      return Boolean(hiddenAnswer || answerBgElements.length > 0);
    }
  }

  // 标准处理逻辑
  for (const option of allOptionElements) {
    const value = isJudgement ? judgementValueFromElement(option) : (option.getAttribute('data') || '').toUpperCase();
    const selected = isJudgement
      ? value === answer
      : targets.length > 0
        ? targets.some((target) => elementMatchesTarget(option, target))
        : labels.includes(String(value || '').toUpperCase());
    const input = option.matches('input[type="radio"], input[type="checkbox"]')
      ? option as HTMLInputElement
      : option.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLInputElement | null;
    if (input) {
      input.checked = selected;
      input.setAttribute('checked', selected ? 'checked' : '');
      if (!selected) input.removeAttribute('checked');
      dispatchInput(input);
    }
    option.setAttribute('aria-checked', selected ? 'true' : 'false');
    option.setAttribute('aria-pressed', selected ? 'true' : 'false');
    const singleMarker = option.querySelector('.num_option') as HTMLElement | null;
    const multiMarker = option.querySelector('.num_option_dx') as HTMLElement | null;
    if (singleMarker) singleMarker.classList.toggle('check_answer', selected && !isMultiple);
    if (multiMarker) multiMarker.classList.toggle('check_answer_dx', selected);
    option.classList.toggle('check_answer', selected && !isMultiple);
    option.classList.toggle('check_answer_dx', selected && Boolean(isMultiple));
    if (selected && clickSelected) dispatchUserClick(option);
  }

  const pageAny = window as any;
  if (typeof pageAny.loadAnswerSheet === 'function') pageAny.loadAnswerSheet(qid, answer);
  if (typeof pageAny.answerContentChange === 'function') pageAny.answerContentChange();
  return Boolean(hiddenAnswer || allOptionElements.length > 0);
}

function ensureAppliedAnswerValue(payload: AnswerApplyPayload, targets: QuestionOptionTarget[]) {
  const answerText = `${payload.answer || ''} ${(payload.matchedOptions || []).join(' ')}`;
  const judgementValue = isJudgementPayload(payload, targets) ? parseJudgementValueStable(answerText) : null;
  const labels = judgementValue ? [] : (targets.length > 0 ? targets.map((target) => target.label.toUpperCase()) : labelsFromPayload(payload));
  const pageValues = !judgementValue && targets.length > 0
    ? answerValuesFromTargets(targets, isMultipleChoicePayload(payload))
    : labels;
  const qid = qidForPayload(payload);
  if (!qid || (!judgementValue && pageValues.length === 0)) return true;

  const root = questionRootForPayload(payload);
  const isJudgement = Boolean(judgementValue) || root.getAttribute('qtype') === '3' || Boolean(root.querySelector('[qtype="3"]'));
  const isMultiple = !isJudgement && (root.getAttribute('qtype') === '1' || Boolean(root.querySelector('[qtype="1"], [qtype="21"]')));
  const expected = isJudgement && judgementValue ? judgementValue : (isMultiple ? pageValues.slice().sort() : pageValues).join('');
  const hiddenAnswer = document.querySelector(`#answer${cssEscape(qid)}`) as HTMLInputElement | null;
  if (!hiddenAnswer) {
    rememberAppliedAnswer(qid, expected, labels);
    return true;
  }

  if (hiddenAnswer.value !== expected) {
    const previous = hiddenAnswer.value;
    hiddenAnswer.value = expected;
    dispatchInput(hiddenAnswer);
    rememberAppliedAnswer(qid, expected, labels);
    reportWebviewError('webview:apply-answer-correct-hidden-value', {
      level: 'warn',
      message: `Corrected hidden answer value from ${previous || 'empty'} to ${expected}`,
      details: { qid, previous, expected, labels }
    });
  }

  return hiddenAnswer.value === expected;
}

function isSingleOptionElement(element: HTMLElement) {
  if (element.matches('.answerBg, .workTextWrap, input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]')) return true;
  if (element.querySelector('.num_option, .num_option_dx, input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]')) {
    const nestedOptions = element.querySelectorAll('.answerBg, .workTextWrap, input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]');
    return nestedOptions.length <= 1;
  }
  return false;
}

function optionElementsForTarget(target: QuestionOptionTarget) {
  const matched = targetElementsFor(target);
  const candidates = uniqueElements(matched.flatMap((element) => [
    element,
    answerOptionContainer(element),
    nearestClickableOption(element),
    element.closest('label') as HTMLElement | null,
    element.closest('li') as HTMLElement | null
  ]));
  return candidates.filter((element) => isSingleOptionElement(element) && elementMatchesTarget(element, target));
}

function selectedInsideSingleOption(element: HTMLElement) {
  if (element.matches('input[type="radio"], input[type="checkbox"]')) {
    return (element as HTMLInputElement).checked;
  }
  const input = element.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLInputElement | null;
  if (input?.checked) return true;
  if (element.getAttribute('aria-checked') === 'true' || element.getAttribute('aria-pressed') === 'true') return true;
  if (selectedClassHit(element)) return true;
  if (!isSingleOptionElement(element)) return false;
  return Array.from(element.querySelectorAll('.num_option, .num_option_dx, [role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"]'))
    .some((child) => selectedClassHit(child as HTMLElement) ||
      child.getAttribute('aria-checked') === 'true' ||
      child.getAttribute('aria-pressed') === 'true' ||
      ((child as HTMLInputElement).checked === true));
}

function isElementSelected(element: HTMLElement, target: QuestionOptionTarget) {
  const targetOptions = optionElementsForTarget(target);
  const probes = targetOptions.length > 0
    ? targetOptions
    : (isSingleOptionElement(element) && elementMatchesTarget(element, target) ? [element] : []);
  return probes.some(selectedInsideSingleOption);
}

function answerStateSignature(element: HTMLElement) {
  const root = element.closest('[qid], [questionid], .questionLi, .question, .question-item, li') as HTMLElement | null;
  const classState = Array.from((root || element).querySelectorAll('*'))
    .filter((child) => selectedClassHit(child as HTMLElement) || child.getAttribute('aria-checked') === 'true' || child.getAttribute('aria-pressed') === 'true')
    .map((child) => selectorFor(child))
    .slice(0, 10)
    .join('|');
  const checkedState = Array.from((root || element).querySelectorAll('input[type="radio"], input[type="checkbox"]'))
    .map((input) => `${selectorFor(input)}:${(input as HTMLInputElement).checked}`)
    .join('|');
  return `${classState}|${checkedState}`;
}

function optionValueFromElement(element: HTMLElement) {
  const marker = element.matches('.num_option, .num_option_dx, [data], [value]')
    ? element
    : element.querySelector('.num_option, .num_option_dx, [data], [value]');
  const input = element.matches('input[type="radio"], input[type="checkbox"]')
    ? element as HTMLInputElement
    : element.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLInputElement | null;
  return cleanText(
    marker?.getAttribute('data') ||
    marker?.getAttribute('value') ||
    input?.value ||
    element.getAttribute('data') ||
    element.getAttribute('value') ||
    ''
  );
}

function targetMatchScore(element: HTMLElement, target: QuestionOptionTarget) {
  let score = 0;
  const value = optionValueFromElement(element);
  const targetValue = cleanText(target.value || '');
  if (targetValue && value && value.toUpperCase() === targetValue.toUpperCase()) score += 100;

  const text = cleanText(element.textContent || '');
  const targetText = cleanText(target.text || '');
  if (targetText) {
    if (text === targetText) score += 90;
    else if (normalizeText(text) === normalizeText(targetText)) score += 80;
    else if (text.includes(targetText) && text.length <= targetText.length + 30) score += 45;
  }

  const optionCount = element.querySelectorAll('.answerBg, .workTextWrap, input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]').length;
  if (optionCount > 1) score -= 80;
  return score;
}

function targetElementsFor(target: QuestionOptionTarget) {
  const selectors = [target.inputSelector, target.clickSelector, target.selector].filter(Boolean) as string[];
  return uniqueElements(selectors.flatMap((selector) => {
    try {
      return Array.from(document.querySelectorAll(selector)) as HTMLElement[];
    } catch {
      return [];
    }
  }));
}

function elementMatchesTarget(element: HTMLElement, target: QuestionOptionTarget) {
  const targetElements = targetElementsFor(target);
  if (targetElements.some((targetElement) => targetElement === element || targetElement.contains(element) || element.contains(targetElement))) {
    return true;
  }
  const elementText = normalizeText(element.textContent || '');
  const targetText = normalizeText(target.text || '');
  return Boolean(targetText && elementText && (elementText === targetText || elementText.includes(targetText)));
}

function expandOptionLikeElements(element: HTMLElement) {
  const descendants = Array.from(element.querySelectorAll([
    '.answerBg',
    '.workTextWrap',
    'input[type="radio"]',
    'input[type="checkbox"]',
    '[role="radio"]',
    '[role="checkbox"]',
    '[data]'
  ].join(','))) as HTMLElement[];
  return descendants.length > 1 ? descendants : [];
}

function resolveAnswerClickCandidates(target: QuestionOptionTarget) {
  const selectors = [target.inputSelector, target.clickSelector, target.selector].filter(Boolean) as string[];
  const matchedElements = selectors.flatMap((selector) => {
    try {
      return Array.from(document.querySelectorAll(selector)) as HTMLElement[];
    } catch {
      return [];
    }
  });
  const baseElements = uniqueElements([
    ...matchedElements,
    ...matchedElements.flatMap(expandOptionLikeElements)
  ]).sort((left, right) => targetMatchScore(right, target) - targetMatchScore(left, target));
  const candidates: Array<HTMLElement | null | undefined> = [];
  for (const element of baseElements) {
    if (!element) continue;
    candidates.push(answerOptionContainer(element));
    candidates.push(nearestClickableOption(element));
    candidates.push(element);
    candidates.push(element.closest('label') as HTMLElement | null);
    candidates.push(element.closest('[role="radio"], [role="checkbox"]') as HTMLElement | null);
    candidates.push(element.closest('li') as HTMLElement | null);
    candidates.push(element.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLElement | null);
    candidates.push(element.querySelector('.num_option, .num_option_dx, .radio, .radio-box, [role="radio"], [role="checkbox"]') as HTMLElement | null);
    candidates.push(element.parentElement);
    candidates.push(element.parentElement?.parentElement);
  }
  return uniqueElements(candidates).filter(isVisible).slice(0, 12);
}

async function clickAnswerTarget(target: QuestionOptionTarget) {
  const candidates = resolveAnswerClickCandidates(target);
  if (candidates.length === 0) throw new Error(`Option not found: ${target.text}`);

  const pageAny = window as any;
  for (const element of candidates) {
    if (isElementSelected(element, target)) return;
    const before = answerStateSignature(element);
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    await new Promise((resolve) => setTimeout(resolve, 220));
    const qtype = element.getAttribute('qtype') || element.closest('[qtype]')?.getAttribute('qtype') || '';
    const actionElement = answerOptionContainer(element);
    element.focus();
    dispatchUserClick(element);
    if (element instanceof HTMLInputElement) {
      element.checked = true;
      dispatchInput(element);
    }
    const afterClick = answerStateSignature(element);
    if (typeof pageAny.addMultipleChoice === 'function' && (qtype === '1' || qtype === '21') && afterClick === before) {
      pageAny.addMultipleChoice(actionElement);
    } else if (typeof pageAny.addChoice === 'function' && (qtype === '0' || qtype === '3') && afterClick === before) {
      pageAny.addChoice(actionElement);
    }
    await new Promise((resolve) => setTimeout(resolve, 260));
    if (isElementSelected(element, target) || answerStateSignature(element) !== before) return;
  }
  throw new Error(`Option matched but was not selected: ${target.label}. ${target.text}`);
}

async function applyAnswer(payload: AnswerApplyPayload) {
  const targets = pickAnswerTargets(payload);
  if (targets.length === 0) {
    return { success: false, error: '未能在当前页面匹配到答案选项。请检查题目选项是否被正确抓取。' };
  }

  try {
    for (const target of targets) await clickAnswerTarget(target);
    return {
      success: true,
      message: `已命中 ${targets.map((target) => target.label).join('、')} 选项。`,
      labels: targets.map((target) => target.label),
      options: targets.map((target) => target.text)
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function applyAnswerV2(payload: AnswerApplyPayload) {
  console.log('[StudyPilot] applyAnswerV2 开始处理答案');
  console.log('[StudyPilot] payload:', JSON.stringify(payload, null, 2));

  if (isFillQuestion(payload)) {
    console.log('[StudyPilot] 检测到填空题');
    return applyCompletionAnswer(payload);
  }

  const targets = pickAnswerTargets(payload);
  console.log('[StudyPilot] 选择的目标数量:', targets.length);
  console.log('[StudyPilot] 目标详情:', targets.map(t => ({ label: t.label, text: t.text, value: t.value })));

  const isJudgement = isJudgementPayload(payload, targets);
  console.log('[StudyPilot] 是否为判断题:', isJudgement);

  if (targets.length === 0) {
    console.log('[StudyPilot] 没有找到目标，尝试直接应用答案');
    if (applyAnswerDirectly(payload, [])) {
      if (!ensureAppliedAnswerValue(payload, [])) {
        console.log('[StudyPilot] 答案字段校验失败');
        return { success: false, error: '答案字段校验失败，页面提交值与目标答案不一致。' };
      }
      console.log('[StudyPilot] 通过页面答案字段成功填入');
      return { success: true, message: `已通过页面答案字段填入 ${labelsFromPayload(payload).join('、')} 选项。` };
    }
    const candidates = fallbackAnswerTargets(payload).slice(0, 8);
    console.log('[StudyPilot] 备用候选项:', candidates.map(c => ({ label: c.label, text: c.text })));
    return {
      success: false,
      error: `未能匹配答案选项。答案：${payload.answer || '空'}；选项：${candidates.map((item) => `${item.label}.${item.text}`).join(' | ') || '未抓到'}；qid：${qidForPayload(payload) || '无'}`
    };
  }

  try {
    console.log('[StudyPilot] 开始点击目标选项');
    for (const target of targets) {
      console.log('[StudyPilot] 点击目标:', target.label, target.text);
      await clickAnswerTarget(target);
    }
    console.log('[StudyPilot] 点击完成，按需同步页面答案字段');
    applyAnswerDirectly(payload, targets, false);
    if (!ensureAppliedAnswerValue(payload, targets)) {
      console.log('[StudyPilot] 答案字段校验失败');
      return { success: false, error: '答案字段校验失败，页面提交值与目标答案不一致。' };
    }
    console.log('[StudyPilot] 成功应用答案');
    return {
      success: true,
      message: `已命中 ${targets.map((target) => target.label).join('、')} 选项。`,
      labels: targets.map((target) => target.label),
      options: targets.map((target) => target.text)
    };
  } catch (error: any) {
    console.log('[StudyPilot] 点击失败，错误:', error.message);
    if (isJudgementPayload(payload, targets) && applyAnswerDirectly(payload, targets, false)) {
      if (!ensureAppliedAnswerValue(payload, targets)) {
        console.log('[StudyPilot] 答案字段校验失败');
        return { success: false, error: '答案字段校验失败，页面提交值与目标答案不一致。' };
      }
      console.log('[StudyPilot] 判断题通过 applyAnswerDirectly 成功填入');
      return { success: true, message: `已通过页面答案字段填入 ${labelsFromPayload(payload).join('、')} 选项。` };
    }
    console.log('[StudyPilot] 最终失败');
    return { success: false, error: error.message };
  }
}
