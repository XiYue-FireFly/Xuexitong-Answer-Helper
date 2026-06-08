import { isVisible, labelFor, selectorFor } from './dom-utils';

export function captureSnapshot() {
  const selector = 'button, input, textarea, select, [role="button"], a[href]';
  const controls = Array.from(document.querySelectorAll(selector))
    .map((element) => element as HTMLElement)
    .filter(isVisible)
    .slice(0, 80)
    .map((element) => ({
      selector: selectorFor(element),
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute('type') || undefined,
      text: labelFor(element),
      value: (element as HTMLInputElement).value || undefined,
      placeholder: element.getAttribute('placeholder') || undefined
    }));

  return {
    success: true,
    data: {
      url: window.location.href,
      title: document.title || window.location.href,
      controls,
      capturedAt: Date.now()
    }
  };
}
