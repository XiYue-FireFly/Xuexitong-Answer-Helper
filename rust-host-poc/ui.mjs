import { clipRect, sameRect, unionRects } from './geometry.mjs';

const element = id => document.getElementById(id);
const panel = element('panel'), dock = element('dock'), scrim = element('scrim');
const hostInvoke = window.__TAURI__?.core?.invoke;
let panelOpen = false, blocked = false, transitioning = false, geometryVersion = 0, revision = 0;
let layoutQueue = Promise.resolve(), resizeFrame = 0;

function report(value) {
  element('result').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function invoke(command, args = {}) {
  if (!hostInvoke) return Promise.reject(new Error('Rust host unavailable: this is a browser preview only.'));
  return hostInvoke(command, args);
}

function rectOf(node, padding = 0) {
  return clipRect(node.getBoundingClientRect(), innerWidth, innerHeight, padding);
}

function syncLayout() {
  geometryVersion += 1;
  const request = {
    revision: ++revision,
    blocked,
    regions: [element('header'), dock].map(node => rectOf(node, 8)).filter(Boolean),
  };
  if (!hostInvoke) return Promise.resolve(null);
  layoutQueue = layoutQueue.catch(() => {}).then(() => invoke('poc_layout', { request }));
  return layoutQueue;
}

function queueLayout() {
  if (resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    void syncLayout().catch(error => report(String(error)));
  });
}

function trackAnimation() {
  const until = performance.now() + 260;
  function frame() {
    queueLayout();
    if (performance.now() < until) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

async function setPanelOpen(next) {
  if (transitioning || next === panelOpen) return;
  transitioning = true;
  blocked = true;
  document.body.dataset.blocked = 'true';
  try {
    // Native interception covers the entire guest BEFORE the opening animation.
    await syncLayout();
    panelOpen = next;
    panel.dataset.open = String(next);
    panel.setAttribute('aria-hidden', String(!next));
    panel.inert = !next;
    element('toggle-panel').setAttribute('aria-expanded', String(next));
    await new Promise(resolve => setTimeout(resolve, 240));
  } catch (error) {
    report(String(error));
    panelOpen = false;
    panel.dataset.open = 'false';
    panel.setAttribute('aria-hidden', 'true');
    panel.inert = true;
  } finally {
    // Closing pointerup and its capture have already completed by this point.
    blocked = panelOpen;
    document.body.dataset.blocked = String(blocked);
    transitioning = false;
    void syncLayout().catch(error => report(String(error)));
  }
}

element('toggle-panel').addEventListener('click', () => { void setPanelOpen(!panelOpen); });
element('close-panel').addEventListener('click', () => { void setPanelOpen(false); });
let dismissPointer = null;
scrim.addEventListener('pointerdown', event => {
  event.preventDefault();
  dismissPointer = event.pointerId;
  scrim.setPointerCapture(event.pointerId);
});
scrim.addEventListener('pointerup', event => {
  event.preventDefault();
  if (dismissPointer !== event.pointerId) return;
  dismissPointer = null;
  if (scrim.hasPointerCapture(event.pointerId)) scrim.releasePointerCapture(event.pointerId);
  void setPanelOpen(false);
});
scrim.addEventListener('pointercancel', () => { dismissPointer = null; });
scrim.addEventListener('click', event => event.preventDefault());
scrim.addEventListener('wheel', event => { event.preventDefault(); event.stopPropagation(); }, { passive: false });

for (const button of document.querySelectorAll('button[data-edge]')) {
  button.addEventListener('click', () => {
    if (transitioning) return;
    panel.dataset.edge = button.dataset.edge;
    for (const other of document.querySelectorAll('button[data-edge]')) {
      other.setAttribute('aria-pressed', String(other === button));
    }
    trackAnimation();
  });
}

element('collapse-dock').addEventListener('click', () => {
  const collapsed = dock.dataset.collapsed !== 'true';
  dock.dataset.collapsed = String(collapsed);
  element('collapse-dock').textContent = collapsed ? '›' : '‹';
  element('collapse-dock').setAttribute('aria-expanded', String(!collapsed));
  element('collapse-dock').setAttribute('aria-label', collapsed ? '展开工具栏' : '折叠工具栏');
  trackAnimation();
});

async function buttonAction(id, task) {
  const button = element(id);
  button.disabled = true;
  try { report(await task()); }
  catch (error) { report({ error: String(error) }); }
  finally { button.disabled = false; }
}

element('probe-guest').addEventListener('click', () => {
  void buttonAction('probe-guest', () => invoke('poc_probe', { target: 'guest' }));
});
element('probe-background').addEventListener('click', () => {
  void buttonAction('probe-background', async () => {
    const result = await invoke('poc_probe', { target: 'background' });
    await setPanelOpen(true);
    return { background: result };
  });
});
element('native-enter').addEventListener('click', () => {
  void buttonAction('native-enter', async () => {
    const result = await invoke('poc_enter');
    await setPanelOpen(true);
    return result;
  });
});
element('focus-guest').addEventListener('click', () => {
  void buttonAction('focus-guest', async () => {
    await setPanelOpen(false);
    await invoke('poc_focus');
    return { focusRequested: true, next: '在网页输入框手动输入中文，观察 IME 候选框及焦点。' };
  });
});

function clearMaterials() {
  element('panel-material').removeAttribute('src');
  element('dock-material').removeAttribute('src');
}

async function capture(fullViewport = false) {
  const version = geometryVersion;
  const targets = [dock, ...(panelOpen ? [panel] : [])];
  const rectangles = targets.map(node => node.getBoundingClientRect());
  const viewport = { x: 0, y: 0, width: innerWidth, height: innerHeight };
  const region = fullViewport ? viewport : unionRects(rectangles.map(rect => clipRect(rect, innerWidth, innerHeight)).filter(Boolean));
  if (!region) return null;
  const result = await invoke('poc_capture', { request: { region, viewport } });
  if (version !== geometryVersion || rectangles.some((rect, i) => !sameRect(rect, targets[i].getBoundingClientRect()))) return null;
  const decoded = new Image();
  decoded.src = result.dataUrl;
  await decoded.decode();
  if (version !== geometryVersion) return null;
  for (const [node, image] of [[dock, element('dock-material')], [panel, element('panel-material')]]) {
    const current = node.getBoundingClientRect();
    Object.assign(image.style, {
      left: `${result.bounds.x - current.x}px`, top: `${result.bounds.y - current.y}px`,
      width: `${result.bounds.width}px`, height: `${result.bounds.height}px`,
    });
    image.src = result.dataUrl;
  }
  element('capture-preview').src = result.dataUrl;
  element('capture-status').textContent = `${result.elapsedMs} ms · ${result.sampledSize.join('×')}`;
  return { ...result, dataUrl: `[PNG data URL, ${result.dataUrl.length} characters]` };
}

element('capture-once').addEventListener('click', () => { void buttonAction('capture-once', () => capture(true)); });

async function captureLoop() {
  if (hostInvoke && !document.hidden && !transitioning && !window.__POC_PAUSE_CAPTURE) {
    try { await capture(); }
    catch (error) {
      clearMaterials();
      element('capture-status').textContent = `截图暂停：${String(error)}`;
    }
  }
  setTimeout(() => { void captureLoop(); }, 200);
}

addEventListener('resize', queueLayout);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearMaterials();
  else queueLayout();
});
const observer = new ResizeObserver(queueLayout);
observer.observe(element('header'));
observer.observe(dock);

if (hostInvoke) {
  void syncLayout().then(() => invoke('poc_info')).then(info => {
    element('host-status').textContent = 'Rust / WebView2 原型已连接 · 待运行验收';
    report(info);
  }).catch(error => {
    element('host-status').textContent = '宿主初始化失败';
    report(String(error));
  });
} else {
  element('host-status').textContent = '浏览器预览 · 未连接 Rust 宿主';
  report('浏览器预览只能检查布局；原生层叠、命中、IME、Enter 和截图均未验证。');
}
void captureLoop();
