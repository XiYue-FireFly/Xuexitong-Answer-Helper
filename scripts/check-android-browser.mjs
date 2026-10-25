// Run against a booted emulator with this debug APK installed. Uses only local fixtures.
// PLAYWRIGHT_MODULE_PATH may point at an existing playwright-core installation.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright-core');
const adb = process.env.ANDROID_ADB || 'D:/Android/Sdk/platform-tools/adb.exe';
const out = path.resolve(process.env.ANDROID_QA_OUT || 'docs/qa/android-browser');
mkdirSync(out, { recursive: true });
const runAdb = (...args) => execFileSync(adb, args, { windowsHide: true });
const previousImeSetting = runAdb('shell', 'settings', 'get', 'secure', 'show_ime_with_hard_keyboard').toString().trim();
const previousRotation = runAdb('shell', 'settings', 'get', 'system', 'user_rotation').toString().trim();
const previousAutoRotation = runAdb('shell', 'settings', 'get', 'system', 'accelerometer_rotation').toString().trim();
const previousFontScale = runAdb('shell', 'settings', 'get', 'system', 'font_scale').toString().trim();
const previousSize = runAdb('shell', 'wm', 'size').toString().match(/Override size: (\d+x\d+)/)?.[1];
const densityState = runAdb('shell', 'wm', 'density').toString();
const previousDensity = densityState.match(/Override density: (\d+)/)?.[1];
runAdb('shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1');
const html = body => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:18px sans-serif;padding:16px;background:#e5f0fc;color:#17344b}button,a,label{display:block;margin:12px 0;padding:12px}textarea{width:90%;min-height:90px}</style>${body}`;
const study = html(`<title>原题目测试页</title><h1>原题目测试页</h1><a id="popup" href="/later" target="_blank">打开新的标签页</a>
  <div class="questionLi" id="q-one" qid="one" qtype="0"><div class="question-title">1 + 1 = ?</div>
  <label><input type="radio" name="answer" value="A">A. 2</label><label><input type="radio" name="answer" value="B">B. 3</label></div>
  <p>底部工具展开后，原网页尺寸保持不变。</p><div style="height:600px;background:linear-gradient(#e5f0fc,#57bfa3)"></div>`);
const composer = html(`<title>AI 输入测试页</title><h2>AI 输入测试页</h2><form><textarea id="chat-input" placeholder="输入消息"></textarea>
  <div role="button">图标发送</div></form><div id="history"></div><script>
  window.sentCount=0; document.querySelector('textarea').addEventListener('keydown', event => {
    if(event.key !== 'Enter' || event.shiftKey) return; event.preventDefault();
    const input=event.target; if(!input.value.trim()) return;
    window.sentCount++; const value=input.value; input.value='';
    const user=document.createElement('div'); user.dataset.messageAuthorRole='user'; user.textContent=value; document.querySelector('#history').append(user);
    const answer=document.createElement('div'); answer.className='ds-markdown'; answer.dataset.messageId='reply-'+window.sentCount; answer.dataset.messageStatus='completed';
    try { const batch=JSON.parse(value.slice(value.lastIndexOf('\\n\\n{')+2));
      answer.textContent=JSON.stringify({requestId:batch.requestId,answers:batch.questions.map(q=>({id:q.id,answer:'2',choiceLabels:['A'],matchedOptions:['2'],confidence:0.99,analysis:'',warnings:[]}))});
    } catch { answer.textContent='已收到提示词'; } document.querySelector('#history').append(answer);
  });</script>`);
const mobileComposer = html(`<title>DeepSeek 手机图文发送测试</title><style>
  body{padding:8px}#composer{padding:12px;background:white;border-radius:24px}
  #images{display:flex;gap:8px}#images img{width:48px;height:48px}#editor textarea{height:45vh;min-height:60px;width:100%}
  footer{display:flex;justify-content:flex-end;padding:8px}footer button{border:0;border-radius:50%;background:#4263ff;color:white;width:48px;height:48px}
  </style><h2>带图片的长提示词</h2><div id="composer"><div id="editor"><div id="images"></div>
  <input id="upload" type="file" accept="image/*" multiple hidden><textarea id="chat-input" placeholder="输入消息"></textarea></div>
  <footer><button id="send" class="ds-button ds-button--primary ds-button--circle"><svg width="20" height="20"><path d="M8.3125 0.980206L9 3.95579V15.0417H7V3.95579Z" fill="currentColor"/></svg></button></footer></div><div id="history"></div>
  <script>window.sentCount=0;document.querySelector('#upload').onchange=event=>{
    for(const file of event.target.files){const card=document.createElement('div');card.dataset.fileName=file.name;card.dataset.status='ready';
      const image=document.createElement('img');image.alt=file.name;image.src=URL.createObjectURL(file);card.append(image);
      const remove=document.createElement('button');remove.textContent='×';remove.onclick=()=>{window.removedCount=(window.removedCount||0)+1;card.remove()};card.append(remove);document.querySelector('#images').append(card);}}
  document.querySelector('textarea').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();event.target.value+='\\n'}};
  document.querySelector('#send').onclick=()=>{const input=document.querySelector('textarea');if(!input.value.trim())return;
    const message=document.createElement('div');message.dataset.messageAuthorRole='user';message.textContent=input.value;
    document.querySelectorAll('#images img').forEach(image=>message.append(image.cloneNode()));document.querySelector('#history').append(message);
    input.value='';document.querySelector('#images').replaceChildren();window.sentCount++;
    const answer=document.createElement('div');answer.className='ds-markdown';answer.dataset.messageId='image-reply-'+window.sentCount;answer.dataset.messageStatus='completed';answer.textContent='图文提示词已收到';document.querySelector('#history').append(answer);};</script>`);
// A centered, scrollable mobile login form exercises focus while the IME changes
// the viewport, unlike the AI fixture whose editor starts near the page top.
const login = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>手机登录输入测试</title><style>
  *{box-sizing:border-box}body{margin:0;font:18px sans-serif;background:#fff;color:#17344b}
  main{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  form{width:100%;max-width:360px}label{display:block;margin:20px 0}
  input,button{font:inherit;width:100%;padding:14px;border:1px solid #ccc;border-radius:8px}
  </style><main><form onsubmit="event.preventDefault()"><h1>账号密码登录</h1>
  <label>账号<input id="account" autocomplete="username" enterkeyhint="next" placeholder="手机号 / 学号"></label>
  <label>密码<input id="password" type="password" autocomplete="current-password" enterkeyhint="done" placeholder="请输入密码"></label>
  <button>登录（本地测试）</button></form></main>`;
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(request.url === '/login' ? login : request.url === '/study' ? study : html('<title>新标签测试页</title><h1>新标签测试页</h1><a href="/third">同一标签下一页</a>'));
});
await new Promise(resolve => server.listen(8910, '0.0.0.0', resolve));
let browser;
let shell;
let previousTheme;
const reports = [];
try {
  // Start a fresh test session so an interrupted earlier run cannot leave its
  // editor/IME open and make the initial full-height measurement meaningless.
  runAdb('shell', 'am', 'force-stop', 'com.studypilot.android');
  runAdb('shell', 'am', 'start', '-n', 'com.studypilot.android/.MainActivity');
  let socket;
  for (let attempt = 0; attempt < 30 && !socket; attempt++) {
    let pid = '';
    try { pid = runAdb('shell', 'pidof', 'com.studypilot.android').toString().trim(); }
    catch (error) {
      // pidof exits 1 while the freshly started Activity is still spawning.
      if (error.status !== 1 || error.stderr?.length) throw error;
    }
    const name = `webview_devtools_remote_${pid}`;
    if (pid && runAdb('shell', 'cat', '/proc/net/unix').toString().includes(`@${name}`)) socket = name;
    else await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(socket, 'No debuggable Android WebView found');
  runAdb('forward', 'tcp:9222', `localabstract:${socket}`);
  browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { noDefaults: true });
  const context = browser.contexts()[0];
  for (let attempt = 0; attempt < 30 && !shell; attempt++) {
    shell = context.pages().find(page => page.url().startsWith('https://localhost'));
    if (!shell) await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(shell, 'Capacitor shell missing');
  shell.setDefaultTimeout(15000);
  await shell.locator('.mobile-shell').waitFor();
  const native = (method, args = {}) => shell.evaluate(({ method, args }) => Promise.race([
    window.Capacitor.nativePromise('NativeWebView', method, args),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Native ${method} timed out`)), 15000))
  ]), { method, args });
  const request = (channel, detail) => shell.evaluate(({ channel, detail }) => new Promise(resolve => window.dispatchEvent(new CustomEvent(channel, { detail: { ...detail, onComplete: resolve } }))), { channel, detail });
  const tapWebView = async (page, selector) => {
    await page.locator(selector).scrollIntoViewIfNeeded();
    // Native IME resizing and WebView's focused-element scroll finish after the
    // CDP scroll command returns. Read coordinates after that animation settles.
    await page.waitForTimeout(350);
    const rect = await page.locator(selector).boundingBox();
    const views = await (await fetch('http://127.0.0.1:9222/json/list')).json();
    const entry = views.find(view => view.url === page.url());
    const dimensions = JSON.parse(entry.description);
    const scale = dimensions.width / await page.evaluate(() => innerWidth);
    // Older Android can open the IME during programmatic focus. An editor taller
    // than that viewport has its center behind the keyboard, so tap its visible
    // intersection instead of accidentally typing a key on the software IME.
    const left = Math.max(0, rect.x), right = Math.min(dimensions.width / scale, rect.x + rect.width);
    const top = Math.max(0, rect.y), bottom = Math.min(dimensions.height / scale, rect.y + rect.height);
    assert.ok(right > left && bottom > top, `No visible tap area for ${selector}: ${JSON.stringify({ rect, dimensions })}`);
    runAdb('shell', 'input', 'tap', String(Math.round(dimensions.screenX + (left + right) / 2 * scale)),
      String(Math.round(dimensions.screenY + (top + bottom) / 2 * scale)));
  };
  const tabs = await native('listTabs');
  assert.ok(Array.isArray(tabs.tabs), 'Native tab inventory unavailable');
  await shell.locator('.mobile-browser-tabs').waitFor();
  await native('focusTab', { tabId: tabs.tabs[0].tabId });
  for (const tab of tabs.tabs.slice(1)) await native('closeTab', { tabId: tab.tabId });
  const findPage = async url => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const found = context.pages().find(page => !page.isClosed() && page.url().includes(url));
      if (found) return found;
      await shell.waitForTimeout(500);
    }
    throw new Error(`Missing WebView ${url}: ${context.pages().map(page => page.url()).join(', ')}`);
  };
  await native('loadUrl', { url: 'http://10.0.2.2:8910/login' });
  const loginPage = await findPage('/login');
  await loginPage.locator('#account').waitFor();
  runAdb('shell', 'input', 'keyevent', '111');
  await shell.waitForTimeout(500);
  for (const [rotation, name] of [[0, 'portrait'], [1, 'landscape']]) {
    runAdb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
    runAdb('shell', 'settings', 'put', 'system', 'user_rotation', String(rotation));
    await shell.waitForFunction(rotation => rotation === 0 ? screen.orientation.type.startsWith('portrait') : screen.orientation.type.startsWith('landscape'), rotation);
    await shell.waitForTimeout(500);
    const fullHeight = await shell.evaluate(() => innerHeight);
    const padding = await shell.evaluate(() => ({ top: parseFloat(getComputedStyle(document.querySelector('.mobile-header')).paddingTop),
      bottom: parseFloat(getComputedStyle(document.querySelector('.mobile-tabs')).paddingBottom) }));
    assert.ok(padding.top <= 10 && padding.bottom === 0,
      `${name}: native safe-area margins must not also become tool padding: ${JSON.stringify(padding)}`);
    await loginPage.locator('#account').evaluate(input => { input.value = ''; input.scrollIntoView({ block: 'center' }); });
    await tapWebView(loginPage, '#account');
    await shell.waitForFunction(height => innerHeight < height - 100, fullHeight);
    await shell.waitForTimeout(700);
    // Compare the actual native shell bounds with the system IME frame. Merely
    // checking that the keyboard opened misses double subtraction of its height.
    let ime;
    for (let attempt = 0; attempt < 12 && !ime; attempt++) {
      const windowState = runAdb('shell', 'dumpsys', 'window', 'displays').toString();
      // Cold-starting the API 29 keyboard can take longer than the WebView's
      // resize. Wait for its actual frame instead of accepting a transient flag.
      ime = windowState.match(/type=ime frame=\[\d+,(\d+)\]\[\d+,\d+\][^\r\n]*visible=true/)
        || (windowState.includes('mIsImeShowing=true')
          && windowState.match(/type=TYPE_UNKNOWN_10 frame=\[\d+,(\d+)\]\[\d+,\d+\]/));
      if (!ime) await shell.waitForTimeout(400);
    }
    assert.ok(ime, 'Visible IME frame missing');
    const views = await (await fetch('http://127.0.0.1:9222/json/list')).json();
    const shellBounds = JSON.parse(views.find(view => view.url.startsWith('https://localhost')).description);
    const actualBottom = shellBounds.screenY + shellBounds.height;
    writeFileSync(path.join(out, `${name}-login-keyboard.png`), runAdb('exec-out', 'screencap', '-p'));
    assert.ok(Math.abs(actualBottom - Number(ime[1])) <= 8,
      `${name}: shell bottom ${actualBottom} must meet IME top ${ime[1]} (keyboard space must be removed once)`);
    const tools = await shell.evaluate(() => ({ header: document.querySelector('.mobile-header').getBoundingClientRect().bottom,
      tabs: document.querySelector('.mobile-tabs').getBoundingClientRect().top }));
    assert.ok(tools.tabs > tools.header + 40, `${name}: browser touch area collapsed: ${JSON.stringify(tools)}`);
    runAdb('shell', 'input', 'text', '13800138000');
    await loginPage.waitForFunction(() => document.querySelector('#account').value === '13800138000');
    // Move to the password with the real keyboard, then tap it to verify touch
    // routing also follows the resized viewport. Only fake credentials are used.
    runAdb('shell', 'input', 'keyevent', '61');
    await loginPage.waitForFunction(() => document.activeElement.id === 'password');
    await tapWebView(loginPage, '#password');
    runAdb('shell', 'input', 'text', 'demo-pass-42');
    await loginPage.waitForFunction(() => document.querySelector('#password').value === 'demo-pass-42');
    const field = await loginPage.locator('#password').boundingBox();
    assert.ok(field.y >= -2 && field.y + field.height <= await loginPage.evaluate(() => innerHeight) + 2,
      `${name}: focused password must stay visible`);
    writeFileSync(path.join(out, `${name}-login-password.png`), runAdb('exec-out', 'screencap', '-p'));
    runAdb('shell', 'input', 'keyevent', '4');
    await shell.waitForFunction(height => innerHeight >= height - 2, fullHeight);
    assert.equal(await loginPage.locator('#account').inputValue(), '13800138000');
    assert.equal(await loginPage.locator('#password').inputValue(), 'demo-pass-42');
    await loginPage.locator('#password').evaluate(input => { input.value = ''; input.blur(); });
    reports.push(`${name}: login account/password accept real keyboard input; focus and touch survive IME resize; shell meets IME exactly once and recovers full height.`);
  }
  await native('loadUrl', { url: 'http://10.0.2.2:8910/study' });
  const source = await findPage('/study');
  await source.getByRole('heading', { name: '原题目测试页' }).waitFor();
  const original = await native('getState');
  // Real target=_blank navigation must preserve the opener and its history.
  await source.locator('#popup').click();
  const popup = await findPage('/later');
  await popup.getByRole('heading', { name: '新标签测试页' }).waitFor();
  assert.equal((await native('getState', { tabId: original.tabId })).url, original.url);
  const opened = await native('getState');
  assert.notEqual(opened.tabId, original.tabId);
  await popup.getByRole('link').click();
  await popup.waitForURL('**/third');
  runAdb('shell', 'input', 'keyevent', '4');
  await popup.waitForURL('**/later');
  await native('clearSession');
  assert.equal((await native('getState', { tabId: opened.tabId })).canGoForward, false);
  await native('focusTab', { tabId: original.tabId });
  assert.equal((await native('getState')).url, original.url);
  reports.push('New-window tabs preserve the source; independent history and switching pass.');
  // Browser bounds must stay fixed when the glass tools open.
  const fullHeights = {};
  for (const [rotation, name] of [[0, 'portrait'], [1, 'landscape']]) {
    runAdb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
    runAdb('shell', 'settings', 'put', 'system', 'user_rotation', String(rotation));
    await shell.waitForFunction(rotation => rotation === 0 ? screen.orientation.type.startsWith('portrait') : screen.orientation.type.startsWith('landscape'), rotation);
    await shell.waitForTimeout(500);
    fullHeights[name] = await shell.evaluate(() => innerHeight);
    const before = await source.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await shell.getByRole('button', { name: '设置', exact: true }).click();
    await shell.locator('.mobile-sheet.is-open').waitFor();
    await shell.waitForTimeout(350);
    assert.deepEqual(await source.evaluate(() => ({ width: innerWidth, height: innerHeight })), before);
    assert.equal(await shell.evaluate(() => getComputedStyle(document.querySelector('.mobile-main')).backgroundColor), 'rgba(0, 0, 0, 0)');
    writeFileSync(path.join(out, `${name}-tools.png`), runAdb('exec-out', 'screencap', '-p'));
    runAdb('shell', 'input', 'keyevent', '4');
    await shell.locator('.mobile-sheet.is-open').waitFor({ state: 'detached' });
    assert.equal((await native('getState')).url, original.url, 'System Back must dismiss tools before navigating the source');
    reports.push(`${name}: overlay retains the browser viewport ${before.width} x ${before.height}.`);
  }
  let aiHtml = composer;
  await context.route('https://chat.deepseek.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: aiHtml }));
  const aiState = await native('createTab', { url: 'https://chat.deepseek.com/' });
  const ai = await findPage('https://chat.deepseek.com/');
  await ai.locator('textarea').waitFor();
  for (const rotation of [0, 1]) {
    const detail = { provider: 'deepseek', tabId: aiState.tabId, prompt: `提示词测试 ${rotation}` };
    const prepared = await request('studypilot:web-ai-browser', { ...detail, action: 'prepare' });
    assert.equal(prepared.promptReady, true, JSON.stringify(prepared));
    await tapWebView(ai, 'textarea');
    await shell.waitForFunction(heights => innerHeight < heights[screen.orientation.type.startsWith('portrait') ? 'portrait' : 'landscape'] - 100, fullHeights);
    runAdb('shell', 'settings', 'put', 'system', 'user_rotation', String(rotation));
    await shell.waitForFunction(rotation => rotation === 0 ? screen.orientation.type.startsWith('portrait') : screen.orientation.type.startsWith('landscape'), rotation);
    assert.equal(await ai.locator('textarea').inputValue(), detail.prompt);
    const sent = await request('studypilot:web-ai-browser', { ...detail, action: 'send' });
    assert.equal(sent.attempted, true, JSON.stringify(sent));
    await ai.waitForFunction(count => window.sentCount === count && document.querySelector('textarea').value === '', rotation + 1);
    reports.push(`Rotation ${rotation}: a draft survives native input focus and rotation, then submits exactly once using real Enter.`);
  }
  await native('focusTab', { tabId: original.tabId });
  // Android's dumpsys IME flags can remain true after the IME is hidden. Check
  // the restored application viewport, which determines what the user sees.
  await shell.waitForFunction(height => innerHeight >= height - 2, fullHeights.landscape);
  const extracted = await request('studypilot:extract-question-request', { targetTabId: original.tabId, expectedUrl: original.url });
  assert.equal(extracted.success, true, JSON.stringify(extracted));
  assert.equal(extracted.questions.length, 1);
  await native('focusTab', { tabId: aiState.tabId });
  const applied = await request('studypilot:apply-answers', { targetTabId: original.tabId, expectedUrl: original.url,
    items: [{ question: extracted.questions[0], answer: { answer: '2', choiceLabels: ['A'], matchedOptions: ['2'] } }] });
  assert.equal(applied.success, true, JSON.stringify(applied));
  assert.equal((await native('getState')).tabId, original.tabId);
  assert.equal(await source.locator('input[value="A"]').isChecked(), true);
  assert.equal(await shell.locator('.mobile-sheet.is-open').count(), 0);
  // Exercise the actual automatic controller through the shipped React UI.
  await source.evaluate(() => document.querySelectorAll('input').forEach(input => { input.checked = false; }));
  await shell.getByRole('button', { name: '答题', exact: true }).click();
  await shell.getByRole('tab', { name: /网页 AI/ }).click();
  await shell.getByRole('button', { name: '开始自动答题', exact: true }).click();
  await source.waitForFunction(() => document.querySelector('input[value="A"]').checked, null, { timeout: 45000 });
  assert.equal((await native('getState')).tabId, original.tabId);
  assert.equal(await shell.locator('.mobile-sheet.is-open').count(), 0);
  reports.push('Shipped automatic UI completes extract -> prompt -> real Enter -> response -> import -> visible source fill.');
  aiHtml = mobileComposer;
  const mobileAiState = await native('createTab', { url: 'https://chat.deepseek.com/?fixture=mobile' });
  const mobileAi = await findPage('?fixture=mobile');
  await mobileAi.locator('textarea').waitFor();
  const pixel = Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMQAAAABJRU5ErkJggg==', 'base64'));
  const attachments = ['flow.png', 'network.png', 'error.png'].map(name => ({ name, mime: 'image/png', bytes: pixel }));
  for (const rotation of [0, 1]) {
    runAdb('shell', 'settings', 'put', 'system', 'user_rotation', String(rotation));
    await shell.waitForFunction(rotation => rotation === 0 ? screen.orientation.type.startsWith('portrait') : screen.orientation.type.startsWith('landscape'), rotation);
    const detail = { provider: 'deepseek', tabId: mobileAiState.tabId, prompt: '请按 JSON 返回。'.repeat(1000) + `{"requestId":"mobile-${rotation}"}`, attachments };
    const prepared = await request('studypilot:web-ai-browser', { ...detail, action: 'prepare' });
    assert.equal(prepared.promptReady, true, JSON.stringify(prepared));
    assert.equal(prepared.attachmentState, 'ready', JSON.stringify(prepared));
    assert.equal(await mobileAi.locator('#images img').count(), 3);
    const sent = await request('studypilot:web-ai-browser', { ...detail, action: 'send' });
    assert.equal(sent.attempted, true, JSON.stringify(sent));
    await mobileAi.waitForFunction(count => window.sentCount === count && document.querySelector('textarea').value === '', rotation + 1, { timeout: 7000 });
    const receipt = await request('studypilot:web-ai-browser', { ...detail, action: 'inspect' });
    assert.equal(receipt.sentReceipt, true, JSON.stringify(receipt));
    assert.equal(await mobileAi.evaluate(() => window.removedCount || 0), 0);
    reports.push(`Rotation ${rotation}: mobile image composer sends a long prompt and all three images exactly once using its icon-only arrow, without removing attachments or inserting an Enter newline.`);
  }
  await native('focusTab', { tabId: original.tabId });
  await context.route('https://i.chaoxing.com/**', route => route.fulfill({ contentType: 'text/html', body: html('<title>新建测试页</title><h1>新建测试页</h1>') }));
  const count = (await native('listTabs')).tabs.length;
  await shell.getByRole('button', { name: '新建浏览器标签页', exact: true }).click();
  await shell.waitForFunction(count => document.querySelectorAll('.mobile-browser-tab').length === count + 1, count);
  await shell.locator('.mobile-browser-tab.is-active .mobile-browser-tab__close').click();
  await shell.waitForFunction(count => document.querySelectorAll('.mobile-browser-tab').length === count, count);
  reports.push('Visible new-tab and close controls operate correctly.');
  await native('closeTab', { tabId: opened.tabId });
  assert.equal((await native('listTabs')).tabs.some(tab => tab.tabId === opened.tabId), false);
  reports.push('Extraction, source-visible answer filling and tab closing pass.');
  await native('focusTab', { tabId: original.tabId });
  runAdb('shell', 'settings', 'put', 'system', 'user_rotation', '0');
  await shell.waitForFunction(() => screen.orientation.type.startsWith('portrait'));
  await source.evaluate(() => scrollTo(0, 0));
  await shell.waitForTimeout(500);
  writeFileSync(path.join(out, 'portrait-source.png'), runAdb('exec-out', 'screencap', '-p'));

  // Learning pages may put questions two cross-origin frames below the course
  // shell. All domains below are intercepted with local HTML, including reloads.
  await context.route(/^https:\/\/(?:i|mooc1|mooc2)\.chaoxing\.com\/qa-/, route => {
    const url = route.request().url();
    const body = url.includes('/qa-nested') ? html('<title>嵌套课程页面</title><iframe style="width:100%;height:500px" src="https://mooc1.chaoxing.com/qa-frame"></iframe>')
      : url.includes('/qa-frame') ? html('<iframe style="width:100%;height:420px" src="https://mooc2.chaoxing.com/qa-question"></iframe>')
        : url.includes('/qa-question') ? study : html('<h1>题目子页已跳转</h1>');
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  const nestedState = await native('createTab', { url: 'https://i.chaoxing.com/qa-nested' });
  const nested = await findPage('/qa-nested');
  await nested.frameLocator('iframe').frameLocator('iframe').locator('#q-one').waitFor();
  const nestedExtracted = await request('studypilot:extract-question-request', { targetTabId: nestedState.tabId, expectedUrl: 'https://i.chaoxing.com/qa-nested' });
  assert.equal(nestedExtracted.success, true, JSON.stringify(nestedExtracted));
  assert.equal(nestedExtracted.questions.length, 1);
  assert.deepEqual(nestedExtracted.questions[0].androidFramePath, [0, 0]);
  const nestedAnswer = { targetTabId: nestedState.tabId, expectedUrl: 'https://i.chaoxing.com/qa-nested',
    items: [{ question: nestedExtracted.questions[0], answer: { answer: '2', choiceLabels: ['A'], matchedOptions: ['2'] } }] };
  assert.equal((await request('studypilot:apply-answers', nestedAnswer)).success, true);
  assert.equal(await nested.frameLocator('iframe').frameLocator('iframe').locator('input[value="A"]').isChecked(), true);
  await nested.frames().find(frame => frame.url().includes('/qa-question')).goto('https://mooc2.chaoxing.com/qa-changed');
  const stale = await request('studypilot:apply-answers', nestedAnswer);
  assert.equal(stale.success, false, JSON.stringify(stale));
  assert.match(stale.error, /子页面已跳转/);
  reports.push('Two cross-origin nested frames extract and fill the correct question; a changed child URL rejects stale answers.');
  await native('closeTab', { tabId: nestedState.tabId });
  await native('focusTab', { tabId: original.tabId });

  previousTheme = await shell.evaluate(() => document.documentElement.dataset.theme);
  for (const profile of [
    { name: 'narrow-320', size: '840x1470', density: 420, font: '1.0' },
    { name: 'large-display-font', size: '1080x2400', density: 540, font: '1.3' },
  ]) {
    runAdb('shell', 'wm', 'size', profile.size);
    runAdb('shell', 'wm', 'density', String(profile.density));
    // Android 15 applies display configuration asynchronously. Wait for the
    // new density before changing fontScale, rather than racing two updates.
    await shell.waitForFunction(density => innerWidth === 320 && Math.abs(devicePixelRatio - density / 160) < 0.01, profile.density);
    runAdb('shell', 'settings', 'put', 'system', 'font_scale', profile.font);
    await shell.waitForFunction(density => innerWidth === 320 && Math.abs(devicePixelRatio - density / 160) < 0.01, profile.density);
    await shell.waitForTimeout(700);
    assert.equal(await shell.evaluate(() => innerWidth), 320, 'Compatibility profile must exercise an actual 320 CSS-pixel viewport');
    for (const theme of ['dark', 'light']) {
      if (await shell.evaluate(() => document.documentElement.dataset.theme) !== theme) {
        await shell.getByRole('button', { name: '切换明暗主题', exact: true }).click();
        await shell.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
      }
      const before = await source.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      for (const label of ['答题', '题库', 'Token', '记录', '错误', '教程', '设置']) {
        const tab = shell.getByRole('button', { name: label, exact: true });
        await tab.scrollIntoViewIfNeeded();
        await tab.click();
        await shell.waitForFunction(label => document.querySelector('.mobile-tab.is-active')?.getAttribute('aria-label') === label, label);
        assert.equal(await tab.getAttribute('aria-expanded'), 'true');
        // Ignore translation from the shared hover style, but wait until the
        // press scale has recovered before measuring the normal touch target.
        await shell.waitForFunction(label => {
          const element = Array.from(document.querySelectorAll('.mobile-tab')).find(el => el.getAttribute('aria-label') === label);
          return element && !element.matches(':active') && element.getBoundingClientRect().width >= element.offsetWidth - 0.5;
        }, label);
        const rect = await tab.boundingBox();
        assert.ok(rect.width >= 43.5 && rect.height >= 43.5, `${profile.name}: ${label} touch target is too small: ${JSON.stringify(rect)}`);
      }
      assert.deepEqual(await source.evaluate(() => ({ width: innerWidth, height: innerHeight })), before);
      const toggle = shell.locator('.mobile-tab--toggle');
      const bounds = await toggle.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320, 'Collapse control must remain visible while tabs scroll');
      writeFileSync(path.join(out, `${profile.name}-${theme}.png`), runAdb('exec-out', 'screencap', '-p'));
      await toggle.click();
      await shell.locator('.mobile-sheet.is-open').waitFor({ state: 'detached' });
    }
    reports.push(`${profile.name}: all seven glass tabs switch, retain 44px touch targets, preserve browser size and keep collapse accessible in both themes.`);
  }
  runAdb('shell', 'wm', 'size', previousSize || 'reset');
  runAdb('shell', 'wm', 'density', previousDensity || 'reset');
  runAdb('shell', 'settings', 'put', 'system', 'font_scale', previousFontScale === 'null' ? '1.0' : previousFontScale);
  await shell.waitForTimeout(1500);
  if (await shell.evaluate(() => document.documentElement.dataset.theme) !== previousTheme) {
    await shell.getByRole('button', { name: '切换明暗主题', exact: true }).click();
  }
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), reports }, null, 2));
  console.log(reports.join('\n'));
} catch (error) {
  const messages = await shell?.evaluate(() => Array.from(document.querySelectorAll('.web-ai-message')).map(node => node.textContent)).catch(() => []);
  try { writeFileSync(path.join(out, 'failure.png'), runAdb('exec-out', 'screencap', '-p')); } catch {}
  console.error({ error: error.message, messages, reports });
  throw error;
} finally {
  runAdb('shell', 'wm', 'size', previousSize || 'reset');
  runAdb('shell', 'wm', 'density', previousDensity || 'reset');
  for (const [key, value] of [['font_scale', previousFontScale], ['user_rotation', previousRotation], ['accelerometer_rotation', previousAutoRotation]]) {
    if (value === 'null') runAdb('shell', 'settings', 'delete', 'system', key);
    else runAdb('shell', 'settings', 'put', 'system', key, value);
  }
  if (previousTheme && shell && !shell.isClosed()) {
    if (await shell.evaluate(() => document.documentElement.dataset.theme).catch(() => previousTheme) !== previousTheme) {
      await shell.getByRole('button', { name: '切换明暗主题', exact: true }).click().catch(() => {});
    }
  }
  if (previousImeSetting === 'null') runAdb('shell', 'settings', 'delete', 'secure', 'show_ime_with_hard_keyboard');
  else runAdb('shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', previousImeSetting);
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
