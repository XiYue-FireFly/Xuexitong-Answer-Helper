// Static browser fixture checks only. This cannot verify native HWND composition.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    const data = await readFile(path);
    response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
    response.end(data);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base + '/ui.html');
  await page.waitForFunction(() => document.querySelector('#host-status').textContent.includes('浏览器预览'));
  assert.equal(await page.locator('button[data-edge]').count(), 4);
  for (const edge of ['left', 'top', 'right', 'bottom']) {
    await page.locator(`button[data-edge="${edge}"]`).click();
    assert.equal(await page.locator('#panel').getAttribute('data-edge'), edge);
  }
  await page.locator('#toggle-panel').click();
  await page.waitForFunction(() => document.querySelector('#panel').dataset.open === 'true');
  await page.locator('#ui-ime').fill('中文输入夹具');
  await page.waitForTimeout(280);
  await page.mouse.click(30, 150);
  await page.waitForFunction(() => document.body.dataset.blocked === 'false');
  assert.equal(await page.locator('#panel').getAttribute('aria-hidden'), 'true');
  await page.locator('#collapse-dock').click();
  await page.waitForTimeout(280);
  assert.ok((await page.locator('#dock').boundingBox()).width <= 57);
  await page.locator('#collapse-dock').click();
  await page.waitForTimeout(280);
  assert.ok((await page.locator('#dock').boundingBox()).width >= 640);
  await page.goto(base + '/guest.html');
  await page.locator('#guest-click').click();
  await page.locator('#guest-editor').fill('中文 Enter 夹具');
  await page.locator('#guest-editor').press('Enter');
  const first = await page.evaluate(() => ({ ...window.pocFixtureState }));
  assert.equal(first.clicks, 1);
  assert.equal(first.submissions, 1);
  assert.equal(first.lastEvent.trusted, true);
  await page.evaluate(() => document.querySelector('#guest-editor').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }),
  ));
  const second = await page.evaluate(() => ({ ...window.pocFixtureState }));
  assert.equal(second.submissions, 1);
  assert.equal(second.untrustedEnters, 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    browserPreview: 'passed', edges: 4, collapse: 'passed', scrimDom: 'passed',
    fixtureTrustedEnter: 'passed', fixtureRejectsSyntheticEnter: 'passed', nativeG1: 'NOT RUN',
  }));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
