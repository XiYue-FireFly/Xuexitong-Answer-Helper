// Idle permissions and cold task entry; live service checks use real work in check-android-browser.mjs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright-core');
const adb = process.env.ANDROID_ADB || 'D:/Android/Sdk/platform-tools/adb.exe';
const out = path.resolve(process.env.ANDROID_QA_OUT || 'docs/qa/android-browser/task-status');
mkdirSync(out, { recursive: true });
const run = (...args) => execFileSync(adb, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
const text = (...args) => run(...args).toString();
const rotation = text('shell', 'settings', 'get', 'system', 'user_rotation').trim();
const autoRotation = text('shell', 'settings', 'get', 'system', 'accelerometer_rotation').trim();
const overlayMode = text('shell', 'appops', 'get', 'com.studypilot.android', 'SYSTEM_ALERT_WINDOW').match(/SYSTEM_ALERT_WINDOW: (\w+)/)?.[1] || 'default';
const notificationMode = text('shell', 'appops', 'get', 'com.studypilot.android', 'POST_NOTIFICATION').match(/POST_NOTIFICATION: (\w+)/)?.[1] || 'default';
let browser, shell, previousMediaCard = false, legacyNotifications;
const reports = [];
const connect = async () => {
  for (let i = 0; i < 40; i++) {
    let pid = ''; try { pid = text('shell', 'pidof', 'com.studypilot.android').trim(); } catch {}
    if (pid && text('shell', 'cat', '/proc/net/unix').includes(`@webview_devtools_remote_${pid}`)) {
      run('forward', 'tcp:9222', `localabstract:webview_devtools_remote_${pid}`);
      browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { noDefaults: true });
      shell = browser.contexts()[0].pages().find(page => page.url().startsWith('https://localhost'));
      if (shell) { shell.setDefaultTimeout(10000); await shell.locator('.mobile-shell').waitFor(); return; }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('No app WebView');
};
const native = (method, args = {}) => shell.evaluate(({ method, args }) => window.Capacitor.nativePromise('TaskStatus', method, args), { method, args });
const hasOverlay = () => text('shell', 'dumpsys', 'window', 'windows').includes('StudyPilot task status');
const hasService = () => text('shell', 'dumpsys', 'activity', 'services', 'com.studypilot.android').includes('isForeground=true');
const setLegacyNotifications = enabled => {
  run('shell', 'am', 'start', '-a', 'android.settings.APP_NOTIFICATION_SETTINGS', '--es', 'android.provider.extra.APP_PACKAGE', 'com.studypilot.android');
  run('shell', 'uiautomator', 'dump', '/sdcard/studypilot-notification-qa.xml');
  const xml = text('shell', 'cat', '/sdcard/studypilot-notification-qa.xml');
  const toggle = xml.match(/<node[^>]*resource-id="com.android.settings:id\/switch_widget"[^>]*>/)?.[0];
  assert.ok(toggle, 'Legacy system notification switch missing');
  if (toggle.includes('checked="true"') !== enabled) {
    const bounds = toggle.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).slice(1).map(Number);
    run('shell', 'input', 'tap', String(Math.round((bounds[0] + bounds[2]) / 2)), String(Math.round((bounds[1] + bounds[3]) / 2)));
  }
};
try {
  run('shell', 'am', 'force-stop', 'com.studypilot.android');
  run('shell', 'am', 'start', '-n', 'com.studypilot.android/.MainActivity');
  // Let the legacy WebView complete its first hardware-rendered frame before
  // attaching a debugger and exercising Activity visibility.
  await new Promise(resolve => setTimeout(resolve, 2500));
  await connect();
  const capabilities = await native('getCapabilities'); previousMediaCard = capabilities.mediaCard;
  assert.equal(capabilities.overlay, false);
  assert.equal(capabilities.overlayEnabled, false);
  run('shell', 'appops', 'set', 'com.studypilot.android', 'POST_NOTIFICATION', 'allow');
  run('shell', 'appops', 'set', 'com.studypilot.android', 'SYSTEM_ALERT_WINDOW', 'allow');
  await native('setOverlay', { enabled: true });
  await native('setMediaCard', { enabled: true });
  assert.equal((await native('getCapabilities')).mediaCard, true);
  assert.ok(!text('shell', 'dumpsys', 'media_session').includes('StudyPilotTaskProgress'), 'An idle media preference must not start playback');
  assert.ok(!hasService() && !hasOverlay(), 'Idle app must not create a service or window');
  run('shell', 'input', 'keyevent', '3'); await shell.waitForTimeout(700);
  assert.ok(!hasService() && !hasOverlay(), 'Idle background app must not show stale progress');
  // Older WebViews suspend the idle shell in background. Return to the app
  // before invoking UI settings; active jobs are tested separately.
  run('shell', 'am', 'start', '-n', 'com.studypilot.android/.MainActivity');
  await shell.waitForTimeout(500);
  await native('setMediaCard', { enabled: false });
  await native('openLiveUpdateSettings');
  assert.ok(!hasService() && !hasOverlay());
  run('shell', 'am', 'start', '-n', 'com.studypilot.android/.MainActivity');
  await shell.waitForTimeout(400);
  await native('setOverlay', { enabled: false }); await shell.waitForTimeout(200);
  assert.ok(!hasOverlay() && !hasService());
  run('shell', 'appops', 'set', 'com.studypilot.android', 'POST_NOTIFICATION', 'ignore');
  if (capabilities.api >= 33) {
    run('shell', 'pm', 'revoke', 'com.studypilot.android', 'android.permission.POST_NOTIFICATIONS');
  } else {
    legacyNotifications = capabilities.notifications;
    setLegacyNotifications(false);
  }
  // Android 10 caches the app-op result in-process, while Android 13+ permission
  // revocation can kill it. Reconnect a fresh app in either case.
  run('shell', 'am', 'force-stop', 'com.studypilot.android');
  await browser.close(); browser = null;
  run('shell', 'am', 'start', '-n', 'com.studypilot.android/.MainActivity');
  await connect();
  assert.equal((await native('getCapabilities')).notifications, false);
  reports.push('Notification permission detection, native settings entry and idle media opt-in work; an idle foreground or background app never shows a stale job.');
  run('shell', 'am', 'force-stop', 'com.studypilot.android'); await browser.close(); browser = null;
  run('shell', 'am', 'start', '-n', 'com.studypilot.android/.MainActivity', '-a', 'studypilot.SHOW_TASK');
  await connect(); await shell.locator('.mobile-sheet.is-open').waitFor();
  assert.equal(await shell.getByRole('button', { name: '答题', exact: true }).getAttribute('aria-expanded'), 'true');
  assert.ok(!hasService() && !hasOverlay(), 'Cold task return must not restart an old job');
  reports.push('Cold task intent opens answer tools without restarting an old job; the app remains idle.');
  writeFileSync(path.join(out, 'task-status-results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), capabilities, reports }, null, 2));
  console.log(reports.join('\n'));
} finally {
  if (shell && !shell.isClosed()) await native('setMediaCard', { enabled: previousMediaCard }).catch(() => {});
  if (legacyNotifications !== undefined) setLegacyNotifications(legacyNotifications);
  run('shell', 'appops', 'set', 'com.studypilot.android', 'SYSTEM_ALERT_WINDOW', overlayMode);
  run('shell', 'appops', 'set', 'com.studypilot.android', 'POST_NOTIFICATION', notificationMode);
  const api = Number(text('shell', 'getprop', 'ro.build.version.sdk').trim());
  if (api >= 33 && notificationMode !== 'deny') run('shell', 'pm', 'grant', 'com.studypilot.android', 'android.permission.POST_NOTIFICATIONS');
  for (const [key, value] of [['user_rotation', rotation], ['accelerometer_rotation', autoRotation]]) {
    if (value === 'null') run('shell', 'settings', 'delete', 'system', key); else run('shell', 'settings', 'put', 'system', key, value);
  }
  await browser?.close();
}
