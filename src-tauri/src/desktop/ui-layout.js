(() => {
  const selectors = ['.app-header', '.app-footer', '.browser-tabs-bar', '.browser-toolbar', '.adaptive-dock', '.browser-tab-context-menu'];
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

  function corners(element, rect, style) {
    const width = element.offsetWidth || rect.width, height = element.offsetHeight || rect.height;
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
    const elements = [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))];
    for (const element of [...watched]) if (!elements.includes(element)) { resize.unobserve(element); watched.delete(element); }
    for (const element of elements) if (!watched.has(element)) { watched.add(element); resize.observe(element); }
    const blocked = !!document.querySelector('.desktop-dismiss,dialog[open],[role=dialog]');
    const regions = elements.flatMap(element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      if (!(rect.width > 0 && rect.height > 0) || style.display === 'none' || style.visibility === 'hidden') return [];
      return [{ x: rect.x, y: rect.y, width: rect.width, height: rect.height, radii: corners(element, rect, style) }];
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
      attributeFilter: ['class', 'open', 'style', 'hidden', 'aria-hidden', 'aria-expanded', 'data-collapsed', 'data-dock-edge', 'data-edge', 'data-compact'],
    });
    for (const event of events) addEventListener(event, queue, true);
    addEventListener('pagehide', dispose, { once: true });
    queue();
  }
  if (document.documentElement) begin();
  else addEventListener('DOMContentLoaded', begin, { once: true });
})()
