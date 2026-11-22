import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright-core');
const executable = path.resolve(process.env.RUST_HOST_EXE || 'src-tauri/target/debug/studypilot-rust-host-poc.exe');
const profile = mkdtempSync(path.join(os.tmpdir(), 'studypilot-dock-session-'));
let serverSessionValid = true;
const fixtureRequests = [];
const fixture = createServer((request, response) => {
  fixtureRequests.push(request.method + ' ' + request.url);
  const hasCookie = request.headers.cookie?.split('; ').includes('fixture_session=present');
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/login') {
    serverSessionValid = true;
    response.writeHead(303, { 'Set-Cookie': 'fixture_session=present; HttpOnly; SameSite=Lax; Path=/', Location: '/account' });
    response.end();
    return;
  }
  if (request.url === '/logout') {
    response.writeHead(303, { 'Set-Cookie': 'fixture_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/', Location: '/signedout' });
    response.end();
    return;
  }
  if (['/account', '/second', '/popup', '/signedout'].includes(request.url)) {
    const status = !hasCookie ? 'missing' : serverSessionValid ? 'present' : 'invalidated';
    response.end(`<!doctype html><title>Fixture ${request.url.slice(1)}</title><h1 data-session="${status}">${status}</h1><input id="fixture-input"><form method="POST" action="/popup" target="_blank"><button>Open popup</button></form>`);
    return;
  }
  response.end('<title>Fixture root</title><h1>ROOT</h1>');
});

await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${fixture.address().port}`;

function native(pid, action, args = {}) {
  const payload = Buffer.from(JSON.stringify({ action, processId: pid, ...args })).toString('base64');
  const result = execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/rust-host-native-input.ps1',
    '-PayloadBase64', payload,
  ], { encoding: 'utf8', windowsHide: true });
  if (action !== 'windows') return result;
  const windows = JSON.parse(result);
  return Array.isArray(windows) ? windows : [windows];
}

async function startHost() {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const debugPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const env = { ...process.env };
  delete env.WEBVIEW2_USER_DATA_FOLDER;
  const child = spawn(executable, [], {
    windowsHide: true,
    env: {
      ...env,
      STUDYPILOT_RUST_PREVIEW_DATA: profile,
      STUDYPILOT_RUST_SESSION_FIXTURE_ORIGIN: baseUrl,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  const exited = once(child, 'exit');
  const instance = { child, exited, logs };
  hosts.add(instance);
  child.on('error', error => logs.push(error.message));
  child.stdout.on('data', value => logs.push(value.toString()));
  child.stderr.on('data', value => logs.push(value.toString()));
  const endpoint = `http://127.0.0.1:${debugPort}`;
  let browser;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Rust host exited during startup: ${child.exitCode}`);
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) });
      if (response.ok && (await response.json()).webSocketDebuggerUrl) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 10000 });
  instance.browser = browser;
  let ui;
  for (let attempt = 0; attempt < 120 && !ui; attempt += 1) {
    ui = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('rust-index'));
    if (!ui) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ui, 'Rust UI page did not start');
  ui.setDefaultTimeout(15000);
  await ui.waitForFunction(() => window.__RUST_HOST__?.invoke);
  const state = await ui.evaluate(() => window.__RUST_HOST__.invoke('session:get-webview-state'));
  assert.equal(path.resolve(state.storagePath), path.join(profile, 'sites'), 'Isolated WebView2 sites root required');
  instance.ui = ui;
  await ui.locator('.desktop-shell').waitFor();
  const notice = ui.getByRole('button', { name: '我知道了', exact: true });
  if (await notice.count()) await notice.click();
  const active = ui.locator('webview[data-active-browser="true"]');
  await active.waitFor();
  await ui.waitForFunction(() => {
    try { return document.querySelector('webview[data-active-browser="true"]')?.getWebContentsId() > 0; }
    catch { return false; }
  }).catch(error => {
    throw new Error(`Native guest did not start. Host stderr: ${logs.join('').slice(-1000)}`, { cause: error });
  });
  return Object.assign(instance, { active });
}

async function closeHost(host) {
  await host.ui.evaluate(() => window.electronAPI.close()).catch(() => {});
  const [code] = await withDeadline(host.exited, 'Normal Rust host exit');
  await host.browser.close().catch(() => {});
  hosts.delete(host);
  assert.equal(code, 0, `Rust host exited with ${code}: ${host.logs.join('')}`);
}

function withDeadline(promise, operation) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${operation} timed out`)), 15000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function settled(host, route) {
  await host.ui.waitForFunction(url => {
    const view = document.querySelector('webview[data-active-browser="true"]');
    return view?.getURL() === url && !view.isLoading();
  }, baseUrl + route).catch(error => {
    throw new Error(`Fixture ${route} did not settle. Requests: ${fixtureRequests.join(', ')}`, { cause: error });
  });
}

async function navigate(host, route) {
  await host.active.evaluate((element, url) => element.loadURL(url), baseUrl + route);
  await settled(host, route === '/login' ? '/account' : route === '/logout' ? '/signedout' : route);
}

async function sessionMarker(host) {
  const result = await host.ui.waitForFunction(async () => {
    try {
      return await document.querySelector('webview[data-active-browser="true"]')
        ?.executeJavaScript('document.querySelector("h1")?.dataset.session');
    } catch {
      return false;
    }
  });
  return result.jsonValue();
}

async function dockChecks(host) {
  const { child, ui, active } = host;
  const owner = () => native(child.pid, 'windows').find(window => window.title === 'WISP RS' && window.owner === 0);
  const ownerWindow = owner();
  assert(ownerWindow, 'Rust owner window is missing');
  native(child.pid, 'move', { x: 16, y: 16, width: Math.ceil(900 * ownerWindow.dpi / 96), height: Math.ceil(590 * ownerWindow.dpi / 96) });
  await ui.waitForFunction(() => innerWidth < 1100 && innerHeight < 700);
  native(child.pid, 'focus');

  const nativeClick = async (x, y) => {
    const root = owner();
    const ratio = root.width / await ui.evaluate(() => innerWidth);
    native(child.pid, 'click', { x: Math.round(root.x + x * ratio), y: Math.round(root.y + y * ratio) });
  };
  const hitRegion = (x, y) => JSON.parse(native(child.pid, 'overlay', { x, y }));
  const clickDock = async () => {
    const dock = ui.locator('.adaptive-dock');
    await dock.waitFor();
    await ui.waitForFunction(() => !document.querySelector('.adaptive-dock')?.classList.contains('is-collapsed'));
    await dock.evaluate(element => {
      element.addEventListener('click', event => {
        if (event.isTrusted && event.target.closest('.mobile-tab')) element.dataset.fixtureDockHit = 'yes';
      }, { once: true, capture: true });
      delete element.dataset.fixtureDockHit;
    });
    const button = dock.locator('.mobile-tab:not(.is-active)').first();
    await button.scrollIntoViewIfNeeded();
    const rect = await button.boundingBox();
    assert(rect, 'Dock button is not visible');
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    assert.deepEqual(hitRegion(x, y), { aboveGuests: true, includesPoint: true });
    if (process.env.RUST_DOCK_NATIVE_INPUT === '1') {
      native(child.pid, 'focus');
      await nativeClick(x, y);
      await ui.waitForFunction(() => document.querySelector('.adaptive-dock')?.dataset.fixtureDockHit === 'yes');
    }
  };
  const openTab = url => ui.evaluate(url => window.electronAPI.openInternalBrowserTab(url), url);
  await openTab(baseUrl + '/second');
  await settled(host, '/second');
  await clickDock();
  console.log('PASS normal tab stays below native dock region');
  await ui.locator(`.browser-tab[title="${baseUrl}/account"]`).click();
  await settled(host, '/account');
  await clickDock();
  await active.evaluate(element => element.executeJavaScript('(()=>{setTimeout(()=>document.forms[0].submit(),0);return true})()'));
  await settled(host, '/popup');
  assert.equal(await sessionMarker(host), 'present', 'Adopted popup and its opener share the site profile');
  await clickDock();
  console.log('PASS adopted popup shares the site profile and stays below native dock region');

  const guestRect = await active.boundingBox();
  const readPopup = code => active.evaluate((view, expression) => view.executeJavaScript(expression), code);
  const inputRect = await readPopup('document.querySelector("#fixture-input")?.getBoundingClientRect().toJSON()');
  assert(guestRect && inputRect, 'Guest editor must be visible');
  const x = guestRect.x + inputRect.x + inputRect.width / 2;
  const y = guestRect.y + inputRect.y + inputRect.height / 2;
  assert.deepEqual(hitRegion(x, y), { aboveGuests: true, includesPoint: false });
  if (process.env.RUST_DOCK_NATIVE_INPUT === '1') {
    await nativeClick(x, y);
    native(child.pid, 'type', { text: 'before' });
    assert.equal(await readPopup('document.querySelector("#fixture-input").value'), 'before');
  }
  await ui.evaluate(() => {
    const modal = document.createElement('dialog');
    modal.id = 'fixture-modal';
    modal.textContent = 'Native modal fixture';
    document.body.append(modal);
    modal.showModal();
  });
  await ui.waitForFunction(() => document.querySelector('#fixture-modal')?.open);
  assert.deepEqual(hitRegion(x, y), { aboveGuests: true, includesPoint: true });
  await ui.evaluate(() => document.querySelector('#fixture-modal').remove());
  assert.deepEqual(hitRegion(x, y), { aboveGuests: true, includesPoint: false });
  if (process.env.RUST_DOCK_NATIVE_INPUT === '1') {
    await nativeClick(x, y);
    native(child.pid, 'type', { text: 'after' });
    assert.equal(await readPopup('document.querySelector("#fixture-input").value'), 'beforeafter');
  }
  console.log('PASS native modal region covers and restores the guest input point');
}

const hosts = new Set();
try {
  const first = await startHost();
  await navigate(first, '/login');
  assert.equal(await sessionMarker(first), 'present');
  if (process.env.RUST_DOCK_SESSION_SKIP_NATIVE !== '1') await dockChecks(first);
  await closeHost(first);

  const second = await startHost();
  await navigate(second, '/account');
  assert.equal(await sessionMarker(second), 'present', 'Cookie without expiration should survive normal restart');
  console.log('PASS session survives a normal restart');
  serverSessionValid = false;
  await navigate(second, '/second');
  assert.equal(await sessionMarker(second), 'invalidated');
  console.log('PASS server invalidation still rejects the persisted session');
  await navigate(second, '/login');
  assert.equal(await sessionMarker(second), 'present');
  await navigate(second, '/logout');
  assert.equal(await sessionMarker(second), 'missing');
  await closeHost(second);

  const third = await startHost();
  await navigate(third, '/account');
  assert.equal(await sessionMarker(third), 'missing');
  await closeHost(third);
  console.log('PASS explicit logout survives a normal restart');
} finally {
  for (const host of hosts) {
    if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill();
    await host.browser?.close().catch(() => {});
    await withDeadline(host.exited, 'Fixture host cleanup').catch(() => {});
  }
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  catch (error) { console.warn(`isolated profile cleanup deferred: ${error.code || error.message}`); }
}
