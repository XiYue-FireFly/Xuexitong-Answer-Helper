(() => {
  const selectors = ['.app-header', '.app-footer', '.browser-tabs-bar', '.browser-toolbar', '.adaptive-dock', '.browser-tab-context-menu'];
  const modalSelector = '.desktop-dismiss,dialog[open],[role=dialog],[aria-modal="true"],[data-native-modal="true"]';
  // A modal may get position:fixed from a stylesheet at any nesting depth.
  const overlaySelector = 'body *';
  const excludedOverlayClasses = ['workbench-drag-shield', 'mock-page-container', 'desktop-dissolve', 'answer-activity-effects'];
  const DOCK_OPTICAL_BLEED = 12;
  const geometryProperty = /^(?:width|height|minWidth|maxWidth|minHeight|maxHeight|top|right|bottom|left|inset.*|transform|translate|scale|rotate|offset.*|margin.*|padding.*|border.*(?:Width|Radius)|gap|rowGap|columnGap|fontSize)$/;
  const watched = new Set();
  let frame = 0, version = 0, disposed = false, active = false;
  let acknowledged = '', sending = '', pending = null;
  let documentGeneration = null;
  // Capture this document's native generation before accepting any layout.
  // A new document starts revision 1; old queued documents retain the old epoch.
  let context = null;
  function nativeContext() {
    if (!context) context = Promise.resolve().then(() => window.__TAURI__.core.invoke('desktop_host', { command: 'ui:layout-context', payload: null }))
      .then(value => {
        if (!Number.isSafeInteger(value?.documentGeneration) || value.documentGeneration < 0) throw new Error('Invalid native UI document generation');
        documentGeneration = value.documentGeneration;
      }).catch(error => { context = null; throw error; });
    return context;
  }

  function length(value, extent) {
    const match = /^([+]?(?:\d+(?:\.\d*)?|\.\d+))(px|%)?$/.exec(value);
    if (!match) return 0;
    return Number(match[1]) * (match[2] === '%' ? extent / 100 : 1);
  }

  function corners(element, rect, style, useRectExtent = false) {
    const width = useRectExtent ? rect.width : (element.offsetWidth || rect.width);
    const height = useRectExtent ? rect.height : (element.offsetHeight || rect.height);
    const values = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius];
    const radii = values.map(value => {
      const parts = String(value || '0').trim().split(/\s+/);
      const pair = [length(parts[0], width), length(parts[1] || parts[0], height)];
      return pair.every(radius => radius > 0) ? pair : [0, 0];
    });
    let factor = 1;
    for (const [extent, sum] of [
      [width, radii[0][0] + radii[1][0]], [width, radii[3][0] + radii[2][0]],
      [height, radii[0][1] + radii[3][1]], [height, radii[1][1] + radii[2][1]],
    ]) if (sum > extent) factor = Math.min(factor, extent / sum);
    return radii.map(([x, y]) => [x * factor * rect.width / width, y * factor * rect.height / height]);
  }

  function viewportSize() {
    const width = Number(window.innerWidth || document.documentElement?.clientWidth || 0);
    const height = Number(window.innerHeight || document.documentElement?.clientHeight || 0);
    return {
      width: Number.isFinite(width) && width > 0 ? width : 0,
      height: Number.isFinite(height) && height > 0 ? height : 0,
    };
  }

  function isVisibleModal(element) {
    if (!element) return false;
    if (element.hidden || element.getAttribute?.('aria-hidden') === 'true') return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
    const opacity = style?.opacity === undefined || style.opacity === '' ? 1 : Number(style.opacity);
    if (!Number.isFinite(opacity) || opacity <= 0) return false;
    // Legacy VM fixtures supply semantic sentinels without a DOM rectangle.
    if (typeof element.getBoundingClientRect !== 'function') return true;
    const rect = element.getBoundingClientRect();
    return !!rect && rect.width > 0 && rect.height > 0;
  }

  function isVisibleFixedOverlay(element, viewport) {
    if (!element || typeof element.getBoundingClientRect !== 'function') return false;
    for (const name of excludedOverlayClasses) {
      if (element.classList?.contains?.(name)) return false;
    }
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
    if (!style || style.position !== 'fixed' || style.pointerEvents === 'none' || !isVisibleModal(element)) return false;
    const zIndex = Number(style.zIndex);
    if (!Number.isFinite(zIndex) || zIndex < 100) return false;
    const rect = element.getBoundingClientRect();
    if (!(rect && rect.width > 0 && rect.height > 0)) return false;
    if (!(viewport.width > 0 && viewport.height > 0)) return false;
    const visibleWidth = Math.min(viewport.width, rect.x + rect.width) - Math.max(0, rect.x);
    const visibleHeight = Math.min(viewport.height, rect.y + rect.height) - Math.max(0, rect.y);
    return visibleWidth >= viewport.width * 0.7 && visibleHeight >= viewport.height * 0.7;
  }

  function hasBlockingModal() {
    const explicit = document.querySelectorAll?.(modalSelector);
    if (explicit?.length) {
      if ([...explicit].some(isVisibleModal)) return true;
    } else if (isVisibleModal(document.querySelector?.(modalSelector))) return true;
    if (typeof document.querySelectorAll !== 'function') return false;
    const viewport = viewportSize();
    if (!(viewport.width > 0 && viewport.height > 0)) return false;
    const seen = new Set();
    for (const element of document.querySelectorAll(overlaySelector) || []) {
      if (!element || seen.has(element)) continue;
      seen.add(element);
      if (isVisibleFixedOverlay(element, viewport)) return true;
    }
    return false;
  }

  function hasTruthyDataFlag(element, attrName) {
    if (!element) return false;
    const attrVal = typeof element.getAttribute === 'function' ? element.getAttribute(attrName) : undefined;
    if (attrVal !== null && attrVal !== undefined) return attrVal !== 'false';
    const dataKey = attrName.replace(/^data-/, '');
    const dataVal = element.dataset?.[dataKey];
    return dataVal !== undefined && dataVal !== 'false';
  }

  function isDockOpticalActive(element) {
    if (!element || element.classList?.contains?.('is-collapsed')) return false;
    if (hasTruthyDataFlag(element, 'data-dragging') || hasTruthyDataFlag(element, 'data-pressed')) return true;
    const track = typeof element.querySelector === 'function'
      ? element.querySelector('.mobile-tabs__track[data-dragging],.mobile-tabs__track[data-pressed]')
      : null;
    if (!track) return false;
    return hasTruthyDataFlag(track, 'data-dragging') || hasTruthyDataFlag(track, 'data-pressed');
  }

  function isVerticalDock(element, rect) {
    const verticalAttr = element.getAttribute?.('data-vertical') ?? element.dataset?.vertical;
    if (verticalAttr === 'true') return true;
    if (verticalAttr === 'false') return false;
    const edge = element.getAttribute?.('data-edge') ?? element.dataset?.edge;
    if (edge === 'left' || edge === 'right') return true;
    if (edge === 'top' || edge === 'bottom') return false;
    return rect.height > rect.width;
  }

  function expandDockOpticalRect(element, rect, viewport) {
    const vertical = isVerticalDock(element, rect);
    let left = vertical ? rect.x - DOCK_OPTICAL_BLEED : rect.x;
    let right = vertical ? rect.x + rect.width + DOCK_OPTICAL_BLEED : rect.x + rect.width;
    let top = vertical ? rect.y : rect.y - DOCK_OPTICAL_BLEED;
    let bottom = vertical ? rect.y + rect.height : rect.y + rect.height + DOCK_OPTICAL_BLEED;
    left = Math.max(0, left);
    top = Math.max(0, top);
    if (viewport.width > 0) right = Math.min(viewport.width, right);
    if (viewport.height > 0) bottom = Math.min(viewport.height, bottom);
    if (right <= left || bottom <= top) return null;
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    };
  }

  function moving(element) {
    for (let target = element; target; target = target.parentElement) {
      for (const animation of target.getAnimations?.() || []) {
        if (animation.playState !== 'running' && !animation.pending) continue;
        if (animation.effect?.getKeyframes?.().some(keyframe => Object.keys(keyframe).some(key => geometryProperty.test(key)))) return true;
      }
    }
    return false;
  }

  const resize = new ResizeObserver(() => queue());

  function flush() {
    if (active || !pending || disposed) return;
    const next = pending;
    pending = null;
    if (next.key === acknowledged) return;
    active = true;
    sending = next.key;
    nativeContext().then(() => {
      if (disposed) return;
      return window.__TAURI__.core.invoke('desktop_host', {
      command: 'ui:layout', payload: { revision: ++version, documentGeneration, blocked: next.blocked, regions: next.regions },
      });
    }).then(() => { if (!disposed) acknowledged = next.key; }).catch(() => {
      acknowledged = '';
      // Retry failed host delivery without making the normal animation path a
      // polling loop. No queued payload may become a permanently stale shape.
      if (!disposed) setTimeout(queue, 100);
    }).finally(() => {
      active = false;
      sending = '';
      if (pending) queue();
    });
  }

  function update() {
    frame = 0;
    if (disposed) return;
    const dockElements = new Set(document.querySelectorAll('.adaptive-dock') || []);
    const elements = [...new Set(selectors.flatMap(selector => [...(document.querySelectorAll(selector) || [])]))];
    for (const element of [...watched]) if (!elements.includes(element)) { resize.unobserve(element); watched.delete(element); }
    for (const element of elements) if (!watched.has(element)) { watched.add(element); resize.observe(element); }
    const blocked = hasBlockingModal();
    const viewport = viewportSize();
    const regions = elements.flatMap(element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      if (!(rect.width > 0 && rect.height > 0) || style.display === 'none' || style.visibility === 'hidden') return [];
      const expanded = dockElements.has(element) && isDockOpticalActive(element);
      const effectiveRect = expanded ? expandDockOpticalRect(element, rect, viewport) : rect;
      if (!effectiveRect) return [];
      return [{ x: effectiveRect.x, y: effectiveRect.y, width: effectiveRect.width, height: effectiveRect.height, radii: corners(element, effectiveRect, style, expanded) }];
    });
    const key = JSON.stringify({ blocked, regions });
    if (key === (active ? sending : acknowledged)) pending = null;
    else pending = { key, blocked, regions };
    flush();
    // Width, transform and corner transitions need their ACTUAL intermediate
    // geometry each frame; ResizeObserver also catches layout-driven changes.
    if (elements.some(moving)) queue();
  }

  function queue() { if (!frame && !disposed) frame = requestAnimationFrame(update); }
  const mutations = new MutationObserver(queue);
  const events = ['resize', 'scroll', 'transitionrun', 'transitionstart', 'transitionend', 'transitioncancel', 'animationstart', 'animationend', 'animationcancel'];
  function dispose() {
    disposed = true;
    if (frame) cancelAnimationFrame(frame);
    resize.disconnect(); mutations.disconnect();
    for (const event of events) removeEventListener(event, queue, true);
    removeEventListener('pagehide', dispose);
  }
  function begin() {
    if (disposed) return;
    mutations.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'open', 'style', 'hidden', 'aria-hidden', 'aria-expanded', 'aria-modal', 'role', 'data-collapsed', 'data-dock-edge', 'data-edge', 'data-compact', 'data-vertical', 'data-dragging', 'data-pressed', 'data-native-modal'],
    });
    for (const event of events) addEventListener(event, queue, true);
    addEventListener('pagehide', dispose, { once: true });
    queue();
  }
  if (document.documentElement) begin();
  else addEventListener('DOMContentLoaded', begin, { once: true });
})()
