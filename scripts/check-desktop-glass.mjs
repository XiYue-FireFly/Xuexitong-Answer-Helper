import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { _electron } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright-core');
const root = process.cwd();
const out = path.resolve(process.env.DESKTOP_QA_OUT || '.playwright-mcp/windows-glass');
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(path.join(os.tmpdir(), 'studypilot-glass-'));
const userData = path.join(profile, 'user-data');
mkdirSync(userData, { recursive: true });
const fixture = `<!doctype html><meta charset="utf-8"><title>玻璃验证页面</title>
<style>body{margin:0;font:24px system-ui;color:white}.block{height:150vh;padding:36px;box-sizing:border-box}
.red{background:#ed2626}.blue{background:#2061e8}button,input{font:20px system-ui;padding:12px;margin:12px}</style>
<section class="block red"><h1>网页保持完整宽度</h1><p>下滑后玻璃应变为蓝色，无需点按工具栏。</p><button id="web-button">网页操作</button><input id="web-input" placeholder="网页输入"></section>
<section class="block blue"><h1>长页面蓝色区域</h1></section>
<script>window.clicks=0;window.downs=0;document.addEventListener('click',()=>window.clicks++);document.addEventListener('pointerdown',()=>window.downs++);</script>`;
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
writeFileSync(path.join(userData, 'studypilot_db.json'), JSON.stringify({ settings: { mockModeUrl: fixtureUrl,
  allowRealPageAutomation: true, theme: 'dark' }, history: [], knowledgeBase: [] }));
const reports = [], errors = [];
let app, shell;
const report = (name, detail = {}) => { reports.push({ name, passed: true, ...detail }); console.log(`PASS ${name}`); };
try {
  const env = { ...process.env, NODE_ENV: 'production', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', APPDATA: path.join(profile, 'Roaming'), LOCALAPPDATA: path.join(profile, 'Local') };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ executablePath: process.env.DESKTOP_QA_EXE || require('electron'),
    args: [...(process.env.DESKTOP_QA_EXE ? [] : [root]), `--user-data-dir=${userData}`], env, timeout: 60000 });
  assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))).toLowerCase(), userData.toLowerCase(), 'QA must use an isolated profile');
  shell = await app.firstWindow(); shell.setDefaultTimeout(15000);
  shell.on('pageerror', error => errors.push(error.stack || error.message));
  await shell.locator('.desktop-shell').waitFor();
  await shell.evaluate(url => {
    localStorage.clear();
    localStorage.setItem('studypilot_start_notice_v2', '1');
    localStorage.setItem('studypilot_settings_v3', JSON.stringify({ mockModeUrl: url, allowRealPageAutomation: true, theme: 'dark' }));
  }, fixtureUrl);
  errors.length = 0;
  await shell.reload(); await shell.locator('.desktop-shell').waitFor();
  await shell.locator('webview[data-active-browser="true"]').waitFor();
  await shell.locator('.browser-address input').fill(fixtureUrl);
  await shell.locator('.browser-address input').press('Enter');
  await shell.waitForFunction(url => {
    try { return document.querySelector('webview[data-active-browser="true"]')?.getURL() === url; } catch { return false; }
  }, fixtureUrl);
  const guestId = await shell.locator('webview[data-active-browser="true"]').evaluate(guest => guest.getWebContentsId());
  // Guest WebContents are not BrowserWindows. Read only this fixture's guest;
  // all interaction still uses real mouse events in the app window.
  const source = { evaluate: (fn, arg) => app.evaluate(async ({ webContents }, payload) => {
    return webContents.fromId(payload.id).executeJavaScript(`(${payload.fn})(${JSON.stringify(payload.arg) ?? ''})`);
  }, { id: guestId, fn: fn.toString(), arg }) };
  assert.match(await source.evaluate(() => document.body.innerText), /网页保持完整宽度/);
  const dock = shell.locator('.mobile-tabs');
  assert.equal(await dock.locator('.mobile-tab').count(), 7);
  const open = async name => {
    if (await dock.evaluate(element => element.classList.contains('is-collapsed'))) await dock.locator('.dock-answer').click();
    const tab = dock.getByRole('button', { name, exact: true });
    if (await tab.getAttribute('aria-expanded') !== 'true') await tab.click();
    await shell.waitForFunction(label => document.querySelector('.mobile-tab.is-active')?.getAttribute('aria-label') === label, name);
    await shell.waitForFunction(() => document.querySelector('.desktop-sheet.is-open'));
    await shell.waitForFunction(() => document.querySelector('.desktop-dissolve').width === 0 || !document.querySelector('.desktop-dissolve').style.width);
    await shell.locator('.desktop-sheet').evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))); });
  };
  const close = async () => {
    if (await shell.locator('.desktop-sheet.is-open').count()) {
      await dock.locator('.is-active').click();
      await shell.waitForFunction(() => !document.querySelector('.desktop-sheet.is-open') && !document.querySelector('.desktop-dismiss'));
    }
  };
  const sourceBounds = await shell.locator('webview[data-active-browser="true"]').boundingBox();
  await open('设置');
  const after = await shell.locator('webview[data-active-browser="true"]').boundingBox();
  assert.deepEqual(after, sourceBounds, 'Opening tools must not shrink the guest');
  report('floating tools preserve the full browser viewport');
  await shell.waitForFunction(() => document.querySelector('.desktop-sheet__material img')?.getAttribute('src')?.startsWith('data:image/'));
  await shell.screenshot({ path: path.join(out, 'dark-tools.png') });
  await close();

  const mainId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.id);
  const rejected = await shell.evaluate(async id => window.electronAPI.captureGlass({ guestId: id,
    region: { x: 0, y: 0, width: 100, height: 100 }, viewport: { x: 0, y: 0, width: 100, height: 100 } }), mainId);
  assert.ok(!rejected.dataUrl, 'Capture must reject the shell as a guest source');
  report('capture accepts only the owned guest surface');
  const inputBounds = await source.evaluate(() => { const r = document.querySelector('#web-input').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  await shell.mouse.click(sourceBounds.x + inputBounds.x + 25, sourceBounds.y + inputBounds.y + inputBounds.height / 2);
  await shell.keyboard.insertText('网页输入保持正常');
  assert.equal(await source.evaluate(() => document.querySelector('#web-input').value), '网页输入保持正常');
  report('floating tools preserve guest keyboard input');

  await shell.waitForFunction(() => document.querySelector('.mobile-tabs__track').dataset.optics === 'gpu');
  const pixel = () => shell.evaluate(() => {
    const canvas = document.querySelector('.mobile-tabs__optics'), gl = canvas.getContext('webgl');
    const pixel = new Uint8Array(4); gl.readPixels(Math.floor(canvas.width * .18), Math.floor(canvas.height * .5), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return [...pixel];
  });
  const red = await pixel(); assert.ok(red[0] > red[2] * 1.5, `Initial glass must sample red: ${red}`);
  await source.evaluate(() => scrollTo(0, document.querySelector('.red').offsetHeight + 10));
  await shell.waitForFunction(() => {
    const c = document.querySelector('.mobile-tabs__optics'), gl = c.getContext('webgl'), p = new Uint8Array(4);
    gl.readPixels(Math.floor(c.width * .18), Math.floor(c.height * .5), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p); return p[2] > p[0] * 1.5;
  });
  const blue = await pixel();
  await shell.screenshot({ path: path.join(out, 'long-scroll-glass.png') });
  report('long-page glass updates without pressing a button', { red, blue });
  await source.evaluate(() => { document.querySelector('.blue').style.background = 'white'; });
  await shell.waitForFunction(() => document.querySelector('.mobile-tabs').dataset.backdropTone === 'dark');
  await shell.screenshot({ path: path.join(out, 'bright-page-contrast.png') });
  report('bright source pixels keep readable labels on the dark glass material');
  await source.evaluate(() => scrollTo(0, 0));

  await open('答题');
  const before = await source.evaluate(() => ({ clicks, downs }));
  const guestRect = await shell.locator('webview[data-active-browser="true"]').boundingBox();
  const outside = { x: guestRect.x + 60, y: guestRect.y + 200 };
  await shell.mouse.click(outside.x, outside.y);
  await shell.waitForFunction(() => !document.querySelector('.desktop-dismiss'));
  assert.deepEqual(await source.evaluate(() => ({ clicks, downs })), before, 'Dismissal must consume the entire gesture');
  await shell.mouse.click(outside.x, outside.y);
  assert.equal(await source.evaluate(() => clicks), before.clicks + 1);
  report('outside click dismisses without passing the gesture into the guest');

  // Real pointer events and rAF samples verify intermediate lens positions.
  await open('答题');
  const target = await dock.getByRole('button', { name: '设置', exact: true }).boundingBox();
  await shell.evaluate(() => {
    window.__lensFrames = []; let remaining = 45;
    const tick = () => { const track = document.querySelector('.mobile-tabs__track');
      window.__lensFrames.push(parseFloat(track.style.getPropertyValue('--dock-active-x'))); if (--remaining) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await shell.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
  await shell.waitForTimeout(850);
  const motion = await shell.evaluate(() => ({ frames: window.__lensFrames,
    width: parseFloat(document.querySelector('.mobile-tabs__track').style.getPropertyValue('--dock-active-width')),
    button: document.querySelector('.mobile-tab.is-active').offsetWidth }));
  assert.ok(new Set(motion.frames.filter(Number.isFinite).map(x => Math.round(x))).size > 4, 'Tap must travel through intermediate positions');
  assert.ok(motion.width <= motion.button + 1, 'Lens must remain within one button slot');
  report('tap glides through intermediate positions within one button width', motion);
  const first = await dock.getByRole('button', { name: '答题', exact: true }).boundingBox();
  await shell.mouse.move(first.x + first.width / 2, first.y + first.height / 2); await shell.mouse.down();
  await shell.waitForFunction(() => parseFloat(document.querySelector('.mobile-tabs__track').style.getPropertyValue('--dock-active-height'))
    > document.querySelector('.mobile-tabs').clientHeight, undefined, { timeout: 2500 });
  const held = await shell.evaluate(() => ({ height: parseFloat(document.querySelector('.mobile-tabs__track').style.getPropertyValue('--dock-active-height')),
    bar: document.querySelector('.mobile-tabs').clientHeight }));
  assert.ok(held.height > held.bar, 'Long hold must lift the lens');
  await shell.mouse.move(target.x + target.width / 2, target.y - 50, { steps: 16 }); await shell.mouse.up();
  assert.equal(await dock.locator('.is-active').getAttribute('data-tool'), 'settings');
  report('held lens lifts and dragging outside the bar still selects the release destination', held);
  await close();

  for (const name of ['答题','题库','Token','记录','错误','教程','设置']) {
    await open(name);
    assert.ok(await shell.locator('.side-panel-page:not([hidden])').isVisible());
  }
  report('all seven pages remain usable');
  const draft = shell.getByPlaceholder('输入任意测试消息，例如：请回复一句中文，确认配置可用。');
  await draft.click();
  await shell.waitForFunction(() => document.activeElement?.getAttribute('placeholder') === '输入任意测试消息，例如：请回复一句中文，确认配置可用。');
  await draft.fill('Windows 玻璃草稿保留验证');
  await shell.waitForFunction(() => !document.querySelector('button[title="发送测试消息"]').disabled);
  await draft.evaluate(element => { window.__draftElement = element; });
  assert.equal(await draft.inputValue(), 'Windows 玻璃草稿保留验证');
  await open('教程'); await open('设置');
  assert.equal(await draft.evaluate(element => element === window.__draftElement), true, 'Editor must stay mounted');
  assert.equal(await draft.inputValue(), 'Windows 玻璃草稿保留验证');
  report('switching pages preserves mounted editor state');

  await source.evaluate(() => document.querySelectorAll('.block').forEach(element => element.style.background = '#fff'));
  await open('题库');
  await shell.waitForTimeout(500);
  const contrastProbes = await shell.evaluate(() => {
    const selectors = ['.desktop-sheet__heading > span:first-child', '.kb-kicker', '.kb-bento-card p', '.kb-bento-card__foot > span:first-child', '.kb-search-bar input', '.kb-type-pill:not(.is-active)'];
    const probes = [];
    for (const selector of selectors) {
      const element = document.querySelector(`.desktop-sheet ${selector}`);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const color = getComputedStyle(element, element.matches('input') ? '::placeholder' : null).color;
      element.dataset.contrastProbe = 'true';
      probes.push({ selector, foreground: color.match(/[\d.]+/g).slice(0, 3).map(Number),
        x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
    const style = document.createElement('style'); style.id = 'contrast-measurement';
    style.textContent = '[data-contrast-probe], [data-contrast-probe] *, [data-contrast-probe]::placeholder { transition: none !important; color: transparent !important; text-shadow: none !important; }';
    document.head.append(style);
    return { probes, viewportWidth: innerWidth };
  });
  assert.equal(contrastProbes.probes.length, 6, 'Probe headings, labels, descriptions, hints, placeholders and inactive filters');
  const contrastImage = await shell.screenshot();
  await shell.evaluate(() => { document.querySelector('#contrast-measurement').remove(); document.querySelectorAll('[data-contrast-probe]').forEach(element => delete element.dataset.contrastProbe); });
  const contrasts = await app.evaluate(({ nativeImage }, payload) => {
    const image = nativeImage.createFromBuffer(Buffer.from(payload.png, 'base64'));
    const size = image.getSize(), pixels = image.toBitmap(), ratio = size.width / payload.viewportWidth;
    const luminance = rgb => rgb.map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; })
      .reduce((sum, value, index) => sum + value * [.2126,.7152,.0722][index], 0);
    return payload.probes.map(probe => {
      const foreground = luminance(probe.foreground); let minimum = 100, background = [];
      for (const x of [.15,.35,.55,.75,.85]) for (const y of [.3,.5,.7]) {
        const offset = (Math.min(size.height - 1, Math.floor((probe.y + probe.height * y) * ratio)) * size.width
          + Math.min(size.width - 1, Math.floor((probe.x + probe.width * x) * ratio))) * 4;
        const rgb = [pixels[offset + 2], pixels[offset + 1], pixels[offset]];
        const back = luminance(rgb), contrast = (Math.max(foreground, back) + .05) / (Math.min(foreground, back) + .05);
        if (contrast < minimum) { minimum = contrast; background = rgb; }
      }
      return { selector: probe.selector, foreground: probe.foreground, background, minimum };
    });
  }, { ...contrastProbes, png: contrastImage.toString('base64') });
  console.log('Text contrast:', JSON.stringify(contrasts));
  for (const probe of contrasts) assert.ok(probe.minimum >= 4.5, `${probe.selector} text contrast ${probe.minimum.toFixed(2)} must reach 4.5:1`);
  await shell.screenshot({ path: path.join(out, 'dark-white-page-readable.png') });
  report('dark panel text stays readable over a white webpage', { contrasts });
  await open('设置');
  await shell.getByRole('button', { name: '浅色模式', exact: true }).click();
  assert.equal(await shell.locator('.desktop-shell').getAttribute('data-theme'), 'light');
  await shell.screenshot({ path: path.join(out, 'light-tools.png') });
  await close();

  for (const [width, height] of [[960,640],[700,540],[1400,900]]) {
    await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win.isMaximized()) await new Promise(resolve => { win.once('unmaximize', resolve); win.unmaximize(); });
    });
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width,height]);
    await shell.waitForFunction(size => Math.abs(innerWidth - size[0]) <= 2 && Math.abs(innerHeight - size[1]) <= 2, [width,height]);
    await shell.waitForTimeout(400); await open('设置');
    const geometry = await shell.evaluate(() => {
      const panel = document.querySelector('.desktop-sheet').getBoundingClientRect(), dock = document.querySelector('.mobile-tabs').getBoundingClientRect();
      return { right: panel.right, bottom: panel.bottom, dockTop: dock.top, dockBottom: dock.bottom, width: innerWidth, height: innerHeight };
    });
    assert.ok(geometry.right <= geometry.width && geometry.bottom <= geometry.dockTop, JSON.stringify(geometry));
    assert.ok(geometry.dockBottom <= geometry.height);
    await close();
    report(`window resize ${width}x${height}`, geometry);
  }
  // A lost context must leave usable CSS glass and recover its live source.
  await shell.waitForFunction(() => document.querySelector('.mobile-tabs__track').dataset.optics === 'gpu');
  await shell.evaluate(() => { const gl = document.querySelector('.mobile-tabs__optics').getContext('webgl'); window.__lose = gl.getExtension('WEBGL_lose_context'); window.__lose.loseContext(); });
  await shell.waitForFunction(() => document.querySelector('.mobile-tabs__track').dataset.optics === 'css');
  await open('教程'); await close();
  await shell.evaluate(() => window.__lose.restoreContext());
  await shell.waitForFunction(() => document.querySelector('.mobile-tabs__track').dataset.optics === 'gpu');
  report('GPU loss falls back to CSS and restores live refraction');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await shell.waitForTimeout(300);
  const hiddenCapture = await shell.evaluate(async id => window.electronAPI.captureGlass({ guestId: id,
    region: { x: 0, y: 100, width: 100, height: 100 }, viewport: { x: 0, y: 100, width: 800, height: 600 } }), guestId);
  assert.ok(!hiddenCapture.dataUrl, 'Minimized app must stop capturing');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
  await shell.waitForFunction(() => !document.hidden);
  await shell.waitForFunction(() => document.querySelector('.mobile-tabs__track').dataset.optics === 'gpu');
  report('minimized window stops capture and restores its live material');
  await shell.emulateMedia({ reducedMotion: 'reduce' });
  await open('设置'); await close(); report('reduced motion expands and collapses without particles');
  assert.deepEqual(errors, [], 'No renderer errors');
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ passed: true, platform: process.platform, version: await app.evaluate(({ app }) => app.getVersion()), reports, errors }, null, 2));
} catch (error) {
  if (shell) console.error('Glass state:', await shell.evaluate(() => ({ hidden: document.hidden,
    viewport: [innerWidth, innerHeight], optics: document.querySelector('.mobile-tabs__track')?.dataset.optics,
    source: document.querySelector('webview[data-active-browser="true"]')?.getBoundingClientRect().toJSON() })).catch(() => null));
  if (shell) await shell.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ passed: false, reports, errors, error: error.stack }, null, 2));
  throw error;
} finally {
  if (app) await app.close();
  await new Promise(resolve => server.close(resolve));
}
