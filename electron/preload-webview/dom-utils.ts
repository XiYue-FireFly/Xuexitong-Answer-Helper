export function cssEscape(value: string) {
  if ((window as any).CSS?.escape) return (window as any).CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

export function selectorFor(element: Element): string {
  const el = element as HTMLElement;
  const dataControl = el.getAttribute('data-sp-control');
  if (dataControl) return `[data-sp-control="${cssEscape(dataControl)}"]`;
  if (el.id) return `#${cssEscape(el.id)}`;
  if (el.getAttribute('qid') && el.getAttribute('data')) {
    return `${el.tagName.toLowerCase()}[qid="${cssEscape(el.getAttribute('qid') || '')}"][data="${cssEscape(el.getAttribute('data') || '')}"]`;
  }
  if (el.getAttribute('qid') && el.getAttribute('qtype')) {
    return `${el.tagName.toLowerCase()}[qid="${cssEscape(el.getAttribute('qid') || '')}"][qtype="${cssEscape(el.getAttribute('qtype') || '')}"]`;
  }
  if (el.getAttribute('questionid') && el.getAttribute('qtype')) {
    return `${el.tagName.toLowerCase()}[questionid="${cssEscape(el.getAttribute('questionid') || '')}"][qtype="${cssEscape(el.getAttribute('qtype') || '')}"]`;
  }
  if (el.getAttribute('name')) return `${el.tagName.toLowerCase()}[name="${cssEscape(el.getAttribute('name') || '')}"]`;
  if (el.getAttribute('aria-label')) return `${el.tagName.toLowerCase()}[aria-label="${cssEscape(el.getAttribute('aria-label') || '')}"]`;

  const parent = el.parentElement;
  if (!parent) return el.tagName.toLowerCase();
  const siblings = Array.from(parent.children).filter((child) => child.tagName === el.tagName);
  const index = siblings.indexOf(el) + 1;
  return `${selectorFor(parent)} > ${el.tagName.toLowerCase()}:nth-of-type(${index})`;
}

export function removeNoise(root: ParentNode) {
  root.querySelectorAll('script, style, noscript, template, svg, canvas, iframe, code, pre').forEach((node) => node.remove());
}

export function mojibakeScore(text: string) {
  const value = String(text || '');
  const hits = (value.match(/[\u6D63\u7EFE\u9359\u9428\u95BF\u7039\u6FE1\u93C2\u9411\u93C9\u95B8\u7035\u95AB\u93C1\u95B2\u7A09\u95C1\u7D94\u68F0\u701B\u8133\u9225\u9365\u7EC9\u620D\uE11F\u7EC0\u53E5\u6D93\u8BB3\u7B9F\u934F\u93B5\u7470\u57BD\u9470\u546D\u6093\u9429]/g) || []).length;
  const replacementHits = (value.match(/[\uFFFD?]/g) || []).length;
  return hits * 3 + replacementHits;
}

export function repairMojibakeText(text: string) {
  const value = String(text || '');
  if (!value) return '';
  if (mojibakeScore(value) < 4) return value;
  try {
    const bytes = new Uint8Array(Array.from(value, (char) => char.charCodeAt(0) & 0xff));
    const repaired = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return mojibakeScore(repaired) < mojibakeScore(value) ? repaired : value;
  } catch {
    return value;
  }
}

export function cleanText(text: string) {
  return repairMojibakeText(String(text || ''))
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\s*\d{1,3}\s*[.、．)]\s*/, '')
    .trim();
}

export function visibleText(element: Element) {
  const clone = element.cloneNode(true) as HTMLElement;
  removeNoise(clone);
  return cleanText(clone.textContent || '');
}

export function normalizeText(text: string) {
  return cleanText(text)
    .replace(/^[A-ZＡ-Ｈ][.\s:：、．。)]*/i, '')
    .replace(/[，。,.、；;：:\s"'“”‘’【】\[\]（）()]/g, '')
    .toLowerCase();
}

export function isVisible(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

export function hashText(text: string) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export function uniqueBy<T>(values: T[], key: (item: T) => string) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const itemKey = key(value);
    if (!itemKey || seen.has(itemKey)) return false;
    seen.add(itemKey);
    return true;
  });
}

export function optionLetter(index: number) {
  return String.fromCharCode(65 + index);
}

export function optionIndexFromLabel(label: string) {
  return label.toUpperCase().charCodeAt(0) - 65;
}

export function optionLabel(label: string, text: string) {
  const body = cleanText(text).replace(/^[A-ZＡ-Ｈ][.\s:：、．。)]*/i, '');
  return `${label.toUpperCase()}. ${body || label.toUpperCase()}`;
}

export function isOnlyOptionMarker(text: string) {
  return /^[A-H]$/i.test(cleanText(text));
}

export function optionTextCandidate(element: HTMLElement, label: string) {
  const candidates: string[] = [];
  const add = (value: unknown) => {
    const text = cleanText(String(value || ''));
    if (text && !candidates.includes(text)) candidates.push(text);
  };

  add(visibleText(element));
  add(element.getAttribute('aria-label'));
  add(element.getAttribute('title'));
  let current: HTMLElement | null = element.parentElement;
  for (let depth = 0; current && depth < 4; depth += 1) {
    add(visibleText(current));
    current = current.parentElement;
  }
  add((element.nextElementSibling as HTMLElement | null)?.innerText || element.nextElementSibling?.textContent);
  add((element.previousElementSibling as HTMLElement | null)?.innerText || element.previousElementSibling?.textContent);

  const upper = label.toUpperCase();
  const useful = candidates
    .map((text) => cleanText(text))
    .filter((text) => text && !isOnlyOptionMarker(text))
    .filter((text) => text.length <= 220)
    .sort((left, right) => {
      const leftHasLabel = new RegExp(`^${upper}\\b|^${upper}[.\\s:：、)]`, 'i').test(left);
      const rightHasLabel = new RegExp(`^${upper}\\b|^${upper}[.\\s:：、)]`, 'i').test(right);
      if (leftHasLabel !== rightHasLabel) return leftHasLabel ? -1 : 1;
      return left.length - right.length;
    });
  return useful[0] || label;
}

export function labelFor(element: HTMLElement) {
  const explicitLabel = element.id ? document.querySelector(`label[for="${cssEscape(element.id)}"]`)?.textContent : '';
  const parentLabel = element.closest('label')?.textContent;
  return cleanText(
    element.getAttribute('aria-label') ||
    explicitLabel ||
    parentLabel ||
    element.textContent ||
    element.getAttribute('placeholder') ||
    element.getAttribute('name') ||
    element.tagName.toLowerCase()
  ).slice(0, 120);
}

export function dispatchInput(element: HTMLElement) {
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

export function selectedClassHit(element: HTMLElement) {
  return Array.from(element.classList).some((className) => {
    const token = className.trim().toLowerCase();
    if (!token) return false;
    if ([
      'active',
      'selected',
      'checked',
      'current',
      'on',
      'cur',
      'choose',
      'chosen',
      'check_answer',
      'check_answer_dx'
    ].includes(token)) {
      return true;
    }
    return /(?:^|[-_])(active|selected|checked|current|choose|chosen|check_answer|check_answer_dx|cur|on)(?:[-_]|$)/i.test(token);
  });
}

export function uniqueElements(elements: Array<HTMLElement | null | undefined>) {
  return elements.filter((element, index, all): element is HTMLElement => {
    return Boolean(element) && all.findIndex((item) => item === element) === index;
  });
}
