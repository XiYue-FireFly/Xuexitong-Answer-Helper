// Real Android touches: a CDP click alone cannot exercise the native overlay router.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright-core');
const adb = process.env.ANDROID_ADB || 'D:/Android/Sdk/platform-tools/adb.exe';
const out = path.resolve(process.env.ANDROID_QA_OUT || 'docs/qa/android-browser/liquid-glass');
mkdirSync(out, { recursive: true });
const runAdb = (...args) => execFileSync(adb, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
const originalRotation = runAdb('shell', 'settings', 'get', 'system', 'user_rotation').toString().trim();
const originalAutoRotation = runAdb('shell', 'settings', 'get', 'system', 'accelerometer_rotation').toString().trim();
const originalSize = runAdb('shell', 'wm', 'size').toString().match(/Override size: (\d+x\d+)/)?.[1];
const originalDensity = runAdb('shell', 'wm', 'density').toString().match(/Override density: (\d+)/)?.[1];
const fixture = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>玻璃交互测试</title><style>body{margin:0;font:20px sans-serif;color:#fff;min-height:180vh;
background:repeating-linear-gradient(155deg,#247d90 0px,#247d90 100px,#315dcc 200px,#83d3b6 300px)}
h1,p{padding:20px;margin:0}button{padding:16px;margin:20px}</style>
<h1>原网页 · 保持完整视口</h1><p>第一次点击空白只收起工具，第二次点击到达网页。</p>
<button>网页按钮</button><script>window.clicks=0;window.downs=0;
document.addEventListener('click',()=>window.clicks++);document.addEventListener('pointerdown',()=>window.downs++);</script>`;
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(fixture);
});
await new Promise(resolve => server.listen(8911, '0.0.0.0', resolve));
let browser, shell, source;
const reports = [];
try {
  runAdb('shell', 'am', 'force-stop', 'com.studypilot.android');
  runAdb('shell', 'am', 'start', '-n', 'com.studypilot.android/.MainActivity');
  let socket;
  for (let attempt = 0; attempt < 30 && !socket; attempt++) {
    let pid = '';
    try { pid = runAdb('shell', 'pidof', 'com.studypilot.android').toString().trim(); } catch (error) { if (error.status !== 1) throw error; }
    const name = `webview_devtools_remote_${pid}`;
    if (pid && runAdb('shell', 'cat', '/proc/net/unix').toString().includes(`@${name}`)) socket = name;
    else await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(socket, 'No Android WebView debug socket');
  runAdb('forward', 'tcp:9222', `localabstract:${socket}`);
  browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { noDefaults: true });
  const context = browser.contexts()[0];
  for (let attempt = 0; attempt < 30 && !shell; attempt++) {
    shell = context.pages().find(page => page.url().startsWith('https://localhost'));
    if (!shell) await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(shell);
  shell.setDefaultTimeout(10000);
  await shell.locator('.mobile-shell').waitFor();
  assert.equal(await shell.locator('.mobile-tabs button').count(), 7, 'Only seven tool tabs; no separate collapse button');
  const openTools = async label => {
    const button = shell.getByRole('button', { name: label, exact: true });
    if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
    await shell.waitForFunction(label => document.querySelector('.mobile-tab.is-active')?.getAttribute('aria-label') === label
      && document.querySelector('.mobile-sheet.is-open'), label);
    await shell.waitForTimeout(450);
  };
  const native = (method, args = {}) => shell.evaluate(({ method, args }) =>
    window.Capacitor.nativePromise('NativeWebView', method, args), { method, args });
  await native('loadUrl', { url: 'http://10.0.2.2:8911/' });
  for (let attempt = 0; attempt < 30 && !source; attempt++) {
    source = context.pages().find(page => page.url().includes('10.0.2.2:8911'));
    if (!source) await shell.waitForTimeout(300);
  }
  assert.ok(source);
  await source.getByRole('heading').waitFor();
  const screenPoint = async point => {
    const entries = await (await fetch('http://127.0.0.1:9222/json/list')).json();
    const dimensions = JSON.parse(entries.find(entry => entry.url.startsWith('https://localhost')).description);
    const scale = dimensions.width / await shell.evaluate(() => innerWidth);
    return { x: Math.round(dimensions.screenX + point.x * scale), y: Math.round(dimensions.screenY + point.y * scale) };
  };
  const tap = async point => {
    const screen = await screenPoint(point);
    runAdb('shell', 'input', 'tap', String(screen.x), String(screen.y));
  };
  const outside = () => shell.evaluate(() => {
    const header = document.querySelector('.mobile-header').getBoundingClientRect();
    const sheet = document.querySelector('.mobile-sheet').getBoundingClientRect();
    if (sheet.top <= header.bottom + 4) throw new Error('No outside region to test');
    return { x: innerWidth / 2, y: (header.bottom + sheet.top) / 2 };
  });
  const count = () => source.evaluate(() => ({ clicks: window.clicks, downs: window.downs, scrollY }));
  for (const [rotation, label] of [[0, 'portrait'], [1, 'landscape']]) {
    runAdb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
    runAdb('shell', 'settings', 'put', 'system', 'user_rotation', String(rotation));
    await shell.waitForFunction(rotation => screen.orientation.type.startsWith(rotation === 0 ? 'portrait' : 'landscape'), rotation);
    await shell.waitForTimeout(500);
    const viewport = await source.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await openTools('设置');
    await shell.waitForTimeout(450);
    const point = await outside();
    const before = await count();
    await tap(point);
    await shell.waitForFunction(() => !document.querySelector('.mobile-sheet.is-open'), null, { timeout: 3000 });
    await shell.waitForTimeout(400);
    assert.deepEqual(await count(), before, 'Dismiss gesture must never reach or scroll the webpage');
    await tap(point);
    await source.waitForFunction(before => window.clicks === before.clicks + 1 && window.downs === before.downs + 1, before);
    assert.deepEqual(await source.evaluate(() => ({ width: innerWidth, height: innerHeight })), viewport);
    reports.push(`${label}: outside tap dismisses, zero webpage events; next tap reaches the source; browser viewport unchanged.`);

    await openTools('设置');
    await shell.waitForTimeout(450);
    const dragBefore = await count();
    const start = await screenPoint({ ...point, x: point.x - 60 });
    const end = await screenPoint({ ...point, x: point.x + 60 });
    runAdb('shell', 'input', 'swipe', String(start.x), String(start.y), String(end.x), String(end.y), '500');
    assert.equal(await shell.locator('.mobile-sheet.is-open').count(), 1, 'Dragging the outside surface must not dismiss');
    assert.deepEqual(await count(), dragBefore, 'Outside drag must not reach webpage');
    // Long holds must not leak an up event after the panel state changes.
    const held = await screenPoint(point);
    runAdb('shell', 'input', 'swipe', String(held.x), String(held.y), String(held.x), String(held.y), '700');
    assert.deepEqual(await count(), dragBefore);
    if (await shell.locator('.mobile-sheet.is-open').count()) await tap(point);
    await shell.waitForFunction(() => !document.querySelector('.mobile-sheet.is-open'));
    await shell.waitForTimeout(400);
    reports.push(`${label}: outside drag and long hold are consumed as whole gestures.`);

    // Interrupt transitions rather than waiting for each one to finish.
    for (let index = 0; index < 6; index++) {
      await shell.locator('.mobile-tab.is-active').dispatchEvent('click');
      await shell.waitForTimeout(40);
    }
    await shell.waitForTimeout(1400);
    assert.equal(await shell.locator('.mobile-sheet.is-open').count(), 0);
    const afterMotion = await count();
    await tap(point);
    await source.waitForFunction(before => window.clicks === before.clicks + 1, afterMotion);
    reports.push(`${label}: rapid reversal settles closed and restores webpage touch.`);
    await openTools('设置');
    await shell.waitForTimeout(450);
    const closingBefore = await count();
    const closingHold = await screenPoint(point);
    await shell.evaluate(() => {
      window.glassQaHeld = false;
      document.addEventListener('pointerdown', () => { window.glassQaHeld = true; }, { once: true, capture: true });
    });
    // Older Android takes longer than a close animation to start `input`. Wait
    // for its actual down, then close while the real finger is still held.
    const hold = new Promise((resolve, reject) => execFile(adb, ['shell', 'input', 'swipe',
      String(closingHold.x), String(closingHold.y), String(closingHold.x), String(closingHold.y), '1200'],
    { windowsHide: true }, error => error ? reject(error) : resolve()));
    await shell.waitForFunction(() => window.glassQaHeld);
    await shell.locator('.mobile-tab.is-active').dispatchEvent('click');
    await hold;
    assert.deepEqual(await count(), closingBefore, 'A gesture held while closing must not leak to the page');
    reports.push(`${label}: a held gesture across the closing transition never leaks to the source.`);
    await shell.waitForFunction(() => !document.querySelector('.mobile-sheet.is-open'));
    await shell.waitForTimeout(400);
    await openTools('设置');
    await shell.waitForTimeout(450);
    writeFileSync(path.join(out, `${label}-glass.png`), runAdb('exec-out', 'screencap', '-p'));
    await shell.locator('.mobile-tab.is-active').click();
    await shell.waitForFunction(() => !document.querySelector('.mobile-sheet.is-open'));
    await shell.waitForTimeout(400);
  }
  runAdb('shell', 'settings', 'put', 'system', 'user_rotation', '0');
  await shell.waitForFunction(() => screen.orientation.type.startsWith('portrait'));
  await shell.waitForTimeout(500);
  // Real native long-hold/drag input, including movement before release.
  const motion = (action, point) => runAdb('shell', 'input', 'motionevent', action, String(point.x), String(point.y));
  const firstTab = shell.getByRole('button', { name: '答题', exact: true });
  const finalTab = shell.getByRole('button', { name: '设置', exact: true });
  await firstTab.scrollIntoViewIfNeeded();
  const firstBounds = await firstTab.boundingBox();
  const finalBounds = await finalTab.boundingBox();
  const startFinger = await screenPoint({ x: firstBounds.x + firstBounds.width / 2, y: firstBounds.y + firstBounds.height / 2 });
  const endFinger = await screenPoint({ x: Math.min(await shell.evaluate(() => innerWidth) - 15, finalBounds.x + finalBounds.width / 2), y: firstBounds.y + firstBounds.height / 2 });
  const dragCounts = await count();
  motion('DOWN', startFinger);
  try {
    await shell.waitForFunction(() => document.querySelector('.mobile-tabs__track[data-dragging]'));
    const mid = { x: Math.round((startFinger.x + endFinger.x) / 2), y: startFinger.y };
    motion('MOVE', mid);
    await shell.waitForTimeout(100);
    writeFileSync(path.join(out, 'dock-drag-mid.png'), runAdb('exec-out', 'screencap', '-p'));
    motion('MOVE', endFinger);
    await shell.waitForTimeout(400);
    assert.equal(await shell.locator('.mobile-tabs__track').getAttribute('data-preview'), 'settings');
  } finally { motion('UP', endFinger); }
  await shell.waitForFunction(() => document.querySelector('.mobile-tab.is-active')?.getAttribute('aria-label') === '设置');
  await shell.waitForTimeout(500);
  assert.equal(await finalTab.getAttribute('aria-expanded'), 'true', 'Release must open target exactly once');
  assert.deepEqual(await count(), dragCounts, 'Dock drag must never reach the webpage');
  await shell.evaluate(() => {
    window.glassQaParticleFrame = null;
    const observer = new MutationObserver(() => {
      if (!document.querySelector('.mobile-sheet.is-dissolving')) return;
      observer.disconnect();
      setTimeout(() => {
        const canvas = document.querySelector('.mobile-dissolve');
        if (!canvas.width) { window.glassQaParticleFrame = { visible: 0, empty: 0 }; return; }
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let visible = 0, empty = 0;
        for (let index = 3; index < pixels.length; index += 16) { if (pixels[index]) visible++; else empty++; }
        window.glassQaParticleFrame = { visible, empty, image: canvas.toDataURL('image/png') };
      }, 220);
    });
    observer.observe(document.querySelector('.mobile-sheet'), { attributes: true, attributeFilter: ['class'] });
    setTimeout(() => observer.disconnect(), 5000);
  });
  await finalTab.click();
  await shell.waitForFunction(() => window.glassQaParticleFrame);
  const particlePixels = await shell.evaluate(() => window.glassQaParticleFrame);
  assert.ok(particlePixels.visible > 50 && particlePixels.empty > 50, 'Dissolve must render actual pixels with a disappearing region');
  writeFileSync(path.join(out, 'panel-particles.png'), Buffer.from(particlePixels.image.split(',')[1], 'base64'));
  await shell.waitForFunction(() => !document.querySelector('.mobile-sheet.is-open'));
  await shell.waitForTimeout(400);
  await finalTab.click();
  await shell.locator('.mobile-sheet.is-open').waitFor();
  await shell.waitForTimeout(450);
  await finalTab.click();
  await shell.waitForFunction(() => !document.querySelector('.mobile-sheet.is-open'));
  await shell.waitForTimeout(400);
  reports.push('Native long hold follows the finger across the dock, release opens the target exactly once; tapping that tab again dissolves and closes, without a separate collapse button.');

  await openTools('设置');
  const draft = shell.getByPlaceholder('输入任意测试消息，例如：请回复一句中文，确认配置可用。');
  const fullHeight = await shell.evaluate(() => innerHeight);
  const hideEditorKeyboard = async () => {
    // Programmatic focus does not always summon the IME on older Android.
    // Back without a visible keyboard would correctly close the tools instead.
    await shell.waitForTimeout(450);
    if (await shell.evaluate(() => innerHeight) < fullHeight - 100) runAdb('shell', 'input', 'keyevent', '4');
    await draft.evaluate(element => element.blur());
    await shell.waitForFunction(height => innerHeight >= height - 2, fullHeight);
    assert.equal(await shell.locator('.mobile-sheet.is-open').count(), 1, 'Keyboard cleanup must preserve the open panel');
  };
  await draft.fill('保留这段尚未发送的草稿 · glass QA');
  await hideEditorKeyboard();
  for (const label of ['答题', 'Token', '记录', '题库', '教程', '设置']) {
    await shell.getByRole('button', { name: label, exact: true }).dispatchEvent('click');
    await shell.waitForTimeout(45);
  }
  await shell.waitForTimeout(1200);
  assert.equal(await draft.inputValue(), '保留这段尚未发送的草稿 · glass QA');
  const selected = await shell.locator('.mobile-tab.is-active').boundingBox();
  const capsule = await shell.locator('.mobile-tabs__selection').boundingBox();
  assert.ok(Math.abs(capsule.x - selected.x) < 1 && Math.abs(capsule.width - selected.width) < 1,
    `Sliding capsule did not settle over the selected tab: ${JSON.stringify({ selected, capsule })}`);
  await tap(await outside());
  await shell.waitForFunction(() => !document.querySelector('.mobile-sheet.is-open'));
  await shell.waitForTimeout(400);
  await openTools('设置');
  assert.equal(await draft.inputValue(), '保留这段尚未发送的草稿 · glass QA');
  await draft.fill('');
  await hideEditorKeyboard();
  // A top-layer modal owns its backdrop; the dismiss surface underneath must not act.
  await shell.evaluate(() => {
    const dialog = document.createElement('dialog');
    dialog.id = 'glass-qa-dialog';
    dialog.style.cssText = 'margin:auto;padding:24px';
    const button = document.createElement('button');
    button.textContent = '关闭测试弹窗';
    button.onclick = () => dialog.remove();
    dialog.append(button);
    document.body.append(dialog);
    dialog.showModal();
  });
  await shell.waitForTimeout(150);
  const modalBefore = await count();
  await tap(await outside());
  assert.equal(await shell.locator('dialog[open]').count(), 1);
  assert.equal(await shell.locator('.mobile-sheet.is-open').count(), 1);
  assert.deepEqual(await count(), modalBefore);
  await shell.getByRole('button', { name: '关闭测试弹窗' }).click();
  await tap(await outside());
  await shell.waitForFunction(() => !document.querySelector('.mobile-sheet.is-open'));
  await shell.waitForTimeout(400);
  reports.push('Rapid tab selection settles the shared capsule correctly; unsent draft survives tab changes and close/reopen; modal backdrop takes priority.');

  const initialTheme = await shell.evaluate(() => document.documentElement.dataset.theme);
  for (const theme of ['dark', 'light']) {
    if (await shell.evaluate(() => document.documentElement.dataset.theme) !== theme) {
      await shell.getByRole('button', { name: '切换明暗主题', exact: true }).click();
    }
    await openTools('Token');
    await shell.waitForTimeout(450);
    writeFileSync(path.join(out, `portrait-glass-${theme}.png`), runAdb('exec-out', 'screencap', '-p'));
    await tap(await outside());
    await shell.waitForFunction(() => !document.querySelector('.mobile-sheet.is-open'));
    await shell.waitForTimeout(400);
  }
  if (await shell.evaluate(() => document.documentElement.dataset.theme) !== initialTheme) {
    await shell.getByRole('button', { name: '切换明暗主题', exact: true }).click();
  }
  runAdb('shell', 'wm', 'size', '840x1470');
  runAdb('shell', 'wm', 'density', '420');
  await shell.waitForFunction(() => innerWidth === 320 && Math.abs(devicePixelRatio - 2.625) < 0.01);
  await shell.waitForTimeout(600);
  await shell.locator('.mobile-tabs__scroll').evaluate(element => { element.scrollLeft = 0; });
  const narrowFirst = await firstTab.boundingBox();
  const narrowStart = await screenPoint({ x: narrowFirst.x + narrowFirst.width / 2, y: narrowFirst.y + narrowFirst.height / 2 });
  const narrowEdge = await screenPoint({ x: 310, y: narrowFirst.y + narrowFirst.height / 2 });
  motion('DOWN', narrowStart);
  try {
    await shell.waitForFunction(() => document.querySelector('.mobile-tabs__track[data-dragging]'));
    motion('MOVE', narrowEdge);
    await shell.waitForTimeout(550);
    assert.equal(await shell.locator('.mobile-tabs__track').getAttribute('data-preview'), 'settings');
    assert.ok(await shell.locator('.mobile-tabs__scroll').evaluate(element => element.scrollLeft) > 0,
      'Holding near the edge must reveal the offscreen tab');
  } finally { motion('UP', narrowEdge); }
  await shell.waitForFunction(() => document.querySelector('.mobile-tab.is-active')?.getAttribute('aria-label') === '设置');
  await shell.waitForTimeout(500);
  assert.equal(await finalTab.getAttribute('aria-expanded'), 'true');
  await finalTab.click();
  await shell.waitForFunction(() => !document.querySelector('.mobile-sheet.is-open'));
  await shell.waitForTimeout(400);
  // A short swipe scrolls the row without selecting a new tab.
  const swipeFrom = await screenPoint({ x: 90, y: narrowFirst.y + narrowFirst.height / 2 });
  const swipeTo = await screenPoint({ x: 240, y: narrowFirst.y + narrowFirst.height / 2 });
  runAdb('shell', 'input', 'swipe', String(swipeFrom.x), String(swipeFrom.y), String(swipeTo.x), String(swipeTo.y), '180');
  assert.equal(await shell.locator('.mobile-tab.is-active').getAttribute('aria-label'), '设置');
  assert.equal(await shell.locator('.mobile-sheet.is-open').count(), 0);
  reports.push('320px dock: long-drag auto-scrolls to the edge tab; short swipe scrolls without selecting or opening a panel.');
  runAdb('shell', 'wm', 'size', originalSize || 'reset');
  runAdb('shell', 'wm', 'density', originalDensity || 'reset');
  await shell.waitForTimeout(900);
  await shell.emulateMedia({ reducedMotion: 'reduce' });
  await shell.getByRole('button', { name: '教程', exact: true }).click();
  assert.ok(await shell.locator('.mobile-sheet').evaluate(element =>
    getComputedStyle(element).transitionDuration.split(',').every(value => parseFloat(value) <= 0.00001)));
  await tap(await outside());
  await shell.waitForFunction(() => !document.querySelector('.mobile-sheet.is-open'));
  reports.push('Reduced motion opens and closes without transitions.');
  writeFileSync(path.join(out, 'glass-results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), reports }, null, 2));
  console.log(reports.join('\n'));
} catch (error) {
  try { writeFileSync(path.join(out, 'glass-failure.png'), runAdb('exec-out', 'screencap', '-p')); } catch {}
  console.error({ error: error.message, reports });
  throw error;
} finally {
  runAdb('shell', 'wm', 'size', originalSize || 'reset');
  runAdb('shell', 'wm', 'density', originalDensity || 'reset');
  for (const [key, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAutoRotation]]) {
    if (value === 'null') runAdb('shell', 'settings', 'delete', 'system', key);
    else runAdb('shell', 'settings', 'put', 'system', key, value);
  }
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
