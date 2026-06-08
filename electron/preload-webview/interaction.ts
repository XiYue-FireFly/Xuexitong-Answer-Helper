export function dispatchUserClick(element: HTMLElement) {
  const pageAny = window as any;
  pageAny.__studyPilotApplyingAnswerUntil = Math.max(
    Number(pageAny.__studyPilotApplyingAnswerUntil || 0),
    Date.now() + 800
  );
  try {
    const rect = element.getBoundingClientRect();
    const clientX = Math.max(0, rect.left + rect.width / 2);
    const clientY = Math.max(0, rect.top + rect.height / 2);
    const base = { bubbles: true, cancelable: true, view: window, clientX, clientY };
    const pointerBase = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    if (typeof PointerEvent !== 'undefined') {
      element.dispatchEvent(new PointerEvent('pointerover', pointerBase));
      element.dispatchEvent(new PointerEvent('pointerenter', pointerBase));
    }
    element.dispatchEvent(new MouseEvent('mouseover', base));
    element.dispatchEvent(new MouseEvent('mouseenter', base));
    if (typeof PointerEvent !== 'undefined') element.dispatchEvent(new PointerEvent('pointerdown', pointerBase));
    element.dispatchEvent(new MouseEvent('mousedown', base));
    if (typeof PointerEvent !== 'undefined') element.dispatchEvent(new PointerEvent('pointerup', pointerBase));
    element.dispatchEvent(new MouseEvent('mouseup', base));
    element.dispatchEvent(new MouseEvent('click', base));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } finally {
    pageAny.__studyPilotApplyingAnswerUntil = Math.max(
      Number(pageAny.__studyPilotApplyingAnswerUntil || 0),
      Date.now() + 500
    );
  }
}
