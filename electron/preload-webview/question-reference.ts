import type { QuestionMedia, QuestionPayload, WebReference } from './types';
import { cleanText, hashText, isVisible, normalizeText, selectorFor } from './dom-utils';

const QUESTION_SELECTOR = '.questionLi, [data-question], [data-sp-question], [qid][qtype], [questionid][qtype], .question, .question-item, .subject-item, .exam-question, .singleQuestionDiv, .timu, .TiMu, .CeSheng, .questionCard';
const GROUP_SELECTOR = '[data-question-group], [data-question-section], .question-group, .questionGroup, .question-section, .questionSection, .reading-group, .question-set, section, .section, .chapter';
const CHAPTER_SELECTOR = '[data-chapter-title], .chapter-title, .chapterTitle, .chapter_name, .chapter-name';
const SECTION_SELECTOR = '[data-section-title], .section-title, .sectionTitle, .section_name, .part-title, .group-title, .question-group-title, .reading-title';
const MATERIAL_SELECTOR = '[data-question-material], [data-material], .question-material, .shared-material, .reading-material, .material-content, .reading-passage, .passage, .material';
const ENTRY_SELECTOR = 'textarea, input, [contenteditable="true"], iframe';
const PRIVATE_FIELD = /(?:password|passwd|token|csrf|auth|session|secret|credential|username|user-name|login|email|phone|mobile)/i;
export const QUESTION_EDITOR_CHROME_SELECTOR = '.edui-editor-toolbarbox, .edui-toolbar, .edui-dialog, .edui-popup, [role="toolbar"]';
export const QUESTION_EDITOR_UI_SELECTOR = '.edui-editor, .edui-container,' + QUESTION_EDITOR_CHROME_SELECTOR;
const DYNAMIC_SELECTOR = 'script, style, noscript, template, textarea, input, [contenteditable="true"], iframe, [hidden], .student-answer, .studentAnswer, .my-answer, .myAnswer, .answer-status, .upload-status, [data-answer-value], [data-upload-status],' + QUESTION_EDITOR_UI_SELECTOR;

function visuallyHidden(element: Element) {
  const style = window.getComputedStyle(element);
  return element.getAttribute('hidden') !== null || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
}

/** aria-hidden controls screen readers, not whether homework content is drawn. */
export function isQuestionContentHidden(element: Element) {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (visuallyHidden(current)) return true;
  }
  return false;
}

export function cloneVisibleQuestionContent(element: Element) {
  const clone = element.cloneNode(true) as HTMLElement;
  const originals = Array.from(element.querySelectorAll('*'));
  const copies = Array.from(clone.querySelectorAll('*'));
  originals.forEach((node, index) => { if (visuallyHidden(node)) copies[index]?.remove(); });
  return clone;
}

function belongsToQuestion(root: HTMLElement, element: Element) {
  let owner = element.closest(QUESTION_SELECTOR);
  // An editor can reuse "question" for its own layout. It does not create
  // another homework question or hide the genuine editor's existing answer.
  while (owner && owner !== root && root.contains(owner) && owner.closest(QUESTION_EDITOR_UI_SELECTOR) &&
    !owner.matches('[qid], [qtype], [questionid], [data-question], [data-sp-question]')) {
    owner = owner.parentElement?.closest(QUESTION_SELECTOR) || null;
  }
  // TiMu is also used for a stem inside a questionLi on older pages.
  if (owner && owner !== root && owner.matches('.TiMu, .timu') && root.contains(owner) && !owner.matches('[qid], [questionid], [data-question], [data-sp-question]')) return true;
  return !owner || owner === root || !root.contains(owner);
}

/** Text used for identity/context never contains a live editor's answer. */
export function questionReferenceText(element: Element) {
  const clone = cloneVisibleQuestionContent(element);
  clone.querySelectorAll(DYNAMIC_SELECTOR).forEach((node) => node.remove());
  return cleanText(clone.textContent || '');
}

function visibleEntry(element: HTMLElement, root: HTMLElement) {
  if (element.closest(QUESTION_EDITOR_CHROME_SELECTOR)) return false;
  if (!belongsToQuestion(root, element) || isQuestionContentHidden(element)) return false;
  let current: HTMLElement | null = element;
  while (current) {
    if (!isVisible(current)) return false;
    if (current === root) break;
    current = current.parentElement;
  }
  return true;
}

export function readFilledValues(root: HTMLElement): string[] {
  const values: string[] = [];
  for (const element of Array.from(root.querySelectorAll<HTMLElement>(ENTRY_SELECTOR))) {
    if (!visibleEntry(element, root)) continue;
    const metadata = ['name', 'id', 'autocomplete', 'data-type'].map((key) => element.getAttribute(key) || '').join(' ');
    if (PRIVATE_FIELD.test(metadata)) continue;
    const tag = element.tagName.toLowerCase();
    let value = '';
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type !== 'text') continue;
      value = (element as HTMLInputElement).value;
    } else if (tag === 'textarea') {
      value = (element as HTMLTextAreaElement).value;
    } else if (tag === 'iframe') {
      // Reading contentDocument is same-origin only. Restrict it to an actual
      // rich-text editor, rather than arbitrary embedded pages in a question.
      try {
        const frameDocument = (element as HTMLIFrameElement).contentDocument;
        const body = frameDocument?.body;
        if (body && (frameDocument.designMode === 'on' || body.isContentEditable || body.getAttribute('contenteditable') === 'true')) {
          value = questionReferenceText(body);
        }
      } catch { /* Cross-origin editors are intentionally inaccessible. */ }
    } else if (element.getAttribute('contenteditable') === 'true') {
      if (element.parentElement?.closest('[contenteditable="true"]')) continue;
      value = questionReferenceText(element);
    }
    const cleaned = cleanText(value || '');
    if (cleaned) values.push(cleaned);
  }
  return values;
}

function scopedNodes(scope: HTMLElement, selector: string, root: HTMLElement) {
  return Array.from(scope.querySelectorAll<HTMLElement>(selector)).filter((node) => {
    const owner = node.closest(QUESTION_SELECTOR);
    const group = node.parentElement?.closest(GROUP_SELECTOR);
    return (!owner || owner === root) && (!group || group === scope || group.contains(root)) && !isQuestionContentHidden(node);
  });
}

function headingIn(scope: HTMLElement, selector: string, root: HTMLElement, attribute: string) {
  const direct = cleanText(scope.getAttribute(attribute) || '');
  if (direct) return direct;
  const heading = scopedNodes(scope, selector, root).find((node) => {
    // A sibling section's heading must not become this question's title.
    const group = node.parentElement?.closest(GROUP_SELECTOR);
    return !group || group === scope || group.contains(root);
  });
  return heading ? cleanText(heading.getAttribute(attribute) || questionReferenceText(heading)) : '';
}

export function questionReferenceScope(root: HTMLElement) {
  let chapterTitle = '';
  let sectionTitle = '';
  let group: HTMLElement | undefined = root.matches(GROUP_SELECTOR) ? root : undefined;
  for (let ancestor = root.parentElement; ancestor && !/^(?:BODY|HTML)$/i.test(ancestor.tagName); ancestor = ancestor.parentElement) {
    if (ancestor.matches(GROUP_SELECTOR)) { group ||= ancestor; break; }
  }
  let materialRoots = scopedNodes(root, MATERIAL_SELECTOR, root);
  for (let scope: HTMLElement | null = root; scope; scope = scope.parentElement) {
    chapterTitle ||= headingIn(scope, CHAPTER_SELECTOR, root, 'data-chapter-title');
    sectionTitle ||= headingIn(scope, SECTION_SELECTOR, root, 'data-section-title');
    const scopedMaterial = scopedNodes(scope, MATERIAL_SELECTOR, root);
    if (!materialRoots.length && scopedMaterial.length) materialRoots = scopedMaterial;
    if (!group || scope === group) break;
  }
  // Only the nearest explicit material scope is used; page text is never read.
  materialRoots = materialRoots.filter((node, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.contains(node)));
  return { chapterTitle, sectionTitle, group, materialRoots };
}

export function buildWebReference(root: HTMLElement, index: number, sourceQuestionId = ''): WebReference {
  const scope = questionReferenceScope(root);
  const material = scope.materialRoots.map(questionReferenceText).filter(Boolean).join('\n');
  const staticGroup = (group: HTMLElement) => JSON.stringify([
    group.getAttribute('data-question-group') || group.getAttribute('data-question-section') || group.id || '',
    headingIn(group, CHAPTER_SELECTOR, root, 'data-chapter-title'),
    headingIn(group, SECTION_SELECTOR, root, 'data-section-title'),
    scopedNodes(group, MATERIAL_SELECTOR, root).filter((node) => !node.closest(QUESTION_SELECTOR)).map(questionReferenceText).join('\n')
  ]);
  const groupIdentity = scope.group ? staticGroup(scope.group) : 'page';
  const groups = Array.from(document.querySelectorAll<HTMLElement>(GROUP_SELECTOR)).filter((group) => staticGroup(group) === groupIdentity);
  const groupOccurrence = scope.group ? Math.max(0, groups.indexOf(scope.group)) : 0;
  let questionId = sourceQuestionId || root.getAttribute('qid') || root.getAttribute('questionid') || root.getAttribute('data-question-id') || root.id;
  if (!questionId) {
    const localScope = scope.group || root.ownerDocument?.body || document.body;
    const localRoots = Array.from(localScope?.querySelectorAll<HTMLElement>(QUESTION_SELECTOR) || []).filter((candidate) =>
      !candidate.parentElement?.closest(QUESTION_SELECTOR) || !localScope.contains(candidate.parentElement.closest(QUESTION_SELECTOR)));
    const localIndex = localRoots.indexOf(root);
    // Detached editors need a local fallback only when no real ID exists.
    const localFields = localIndex < 0 ? [...new Set(Array.from(localScope?.querySelectorAll<HTMLElement>('textarea, input[type="text"], input:not([type]), [contenteditable="true"]') || []).map((field) => field.parentElement).filter(Boolean))] : [];
    const fieldIndex = localFields.findIndex((candidate) => candidate === root || Boolean(candidate && root.contains(candidate)));
    questionId = `index:${localIndex >= 0 ? localIndex + 1 : fieldIndex >= 0 ? fieldIndex + 1 : index}`;
  }
  return {
    pageTitle: cleanText(root.ownerDocument?.title || document.title),
    ...(scope.chapterTitle ? { chapterTitle: scope.chapterTitle } : {}),
    ...(scope.sectionTitle ? { sectionTitle: scope.sectionTitle } : {}),
    groupKey: `group_${hashText(JSON.stringify([groupIdentity, groupOccurrence]))}`,
    sourceQuestionId: questionId,
    ...(material ? { material } : {}),
    filledValues: readFilledValues(root)
  };
}

export function resolveQuestionMediaUrl(element: Element): string | undefined {
  const image = element as HTMLImageElement;
  const lazy = element.getAttribute('data-original') || element.getAttribute('data-src') || element.getAttribute('data-lazy-src') || element.getAttribute('data-url');
  // A lazy image's currentSrc can still be its loading placeholder. Picture
  // selection has precedence once the browser selected a distinct source.
  const pictureSource = image.currentSrc && image.currentSrc !== image.src && element.closest('picture') ? image.currentSrc : '';
  const raw = pictureSource || lazy || image.currentSrc || element.getAttribute('src') || image.src;
  if (!raw || !raw.trim()) return undefined;
  try {
    const url = new URL(raw, element.baseURI || element.ownerDocument?.baseURI || document.baseURI);
    return /^(https?:|data:|blob:|file:)$/.test(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

export function collectQuestionMedia(root: HTMLElement, options: Array<{ element: HTMLElement; label: string }> = []): QuestionMedia[] {
  const { materialRoots } = questionReferenceScope(root);
  const candidates = new Set<Element>();
  for (const scope of [root, ...materialRoots]) {
    for (const element of Array.from(scope.querySelectorAll('img, svg, canvas'))) {
      if (!belongsToQuestion(root, element)) continue;
      if (isQuestionContentHidden(element) || element.closest('nav, header, footer, .toolbar, .avatar, .site-logo, [role="navigation"], [hidden], [contenteditable="true"], .student-answer, .studentAnswer, .my-answer, .myAnswer, [data-answer-value],' + QUESTION_EDITOR_UI_SELECTOR)) continue;
      candidates.add(element);
    }
  }
  return Array.from(candidates).map((element, index) => {
    const option = options.find((item) => item.element === element || item.element.contains(element));
    const role = option ? 'option' as const : materialRoots.some((scope) => scope === element || scope.contains(element)) ? 'material' as const : 'stem' as const;
    const tag = element.tagName.toLowerCase();
    const sourceUrl = tag === 'img' ? resolveQuestionMediaUrl(element) : undefined;
    const image = element as HTMLImageElement;
    const width = Number(image.naturalWidth || element.getAttribute('width')) || undefined;
    const height = Number(image.naturalHeight || element.getAttribute('height')) || undefined;
    const alt = cleanText(element.getAttribute('alt') || element.getAttribute('aria-label') || (tag === 'svg' ? element.querySelector('title')?.textContent : '') || '');
    const caption = cleanText(element.closest('figure')?.querySelector('figcaption')?.textContent || element.getAttribute('title') || '');
    return {
      id: `media_${hashText(JSON.stringify([role, option?.label, sourceUrl || tag, alt, index]))}`,
      role, ...(option ? { optionLabel: option.label } : {}), ...(sourceUrl ? { sourceUrl } : {}), alt,
      ...(caption ? { caption } : {}), ...(width ? { width } : {}), ...(height ? { height } : {}),
      status: 'discovered' as const,
      ...(!sourceUrl ? { reason: tag === 'img' ? '图片源地址不可用，等待页面截图' : `${tag.toUpperCase()} 内容需要页面截图` } : {}),
      selector: selectorFor(element)
    };
  });
}

/** Upload progress, editor answers and timestamps must never change a key. */
export function webEnhancedQuestionHash(question: QuestionPayload): string {
  const reference = question.webReference;
  return `web_${hashText(JSON.stringify([
    reference?.groupKey || '', reference?.sourceQuestionId || '', reference ? '' : question.index || 0,
    normalizeText(question.question), question.options.map(normalizeText),
    normalizeText(reference?.material || question.context || ''),
    (question.media || []).map((media) => [media.role, media.optionLabel || '', media.sourceUrl || '', media.alt, media.caption || ''])
  ]))}`;
}
