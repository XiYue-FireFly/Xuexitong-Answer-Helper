import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); });

describe('read-only Electron profile export', () => {
  it('preserves database, renderer data, credentials and UI preferences without mutation', async () => {
    const { createProfileEnvelope, verifyProfileEnvelope } = await import('../../scripts/export-electron-profile.mjs');
    const database = { settings: { providers: [{ apiKey: 'fixture-not-real' }] }, history: [{ id: 'old' }], knowledgeBase: [{ hash: 'question' }] };
    const localStorage = { studypilot_settings_v3: '{"theme":"dark"}', studypilot_question_bank_v1: '[{"id":"q1"}]', studypilot_token_usage_v1: '[{"totalTokens":8}]', studypilot_dock_ui_v1: '{"edge":"left"}', 'studypilot-browser-session-v1': '{"tabs":[]}', unrelated_site_cookie: 'exclude' };
    const before = JSON.stringify({ database, localStorage });
    const envelope = createProfileEnvelope({ database, localStorage, sourceVersion: '1.5.1' });
    const restored = verifyProfileEnvelope(JSON.parse(JSON.stringify(envelope)));
    expect(restored.database).toEqual(database);
    expect(restored.localStorage.studypilot_dock_ui_v1).toBe(localStorage.studypilot_dock_ui_v1);
    expect(restored.localStorage.studypilot_token_usage_v1).toBe(localStorage.studypilot_token_usage_v1);
    expect(restored.localStorage).not.toHaveProperty('unrelated_site_cookie');
    expect(restored.guestLogin).toBe('reauthentication-required');
    expect(JSON.stringify({ database, localStorage })).toBe(before);
  });

  it('rejects tampering and incomplete renderer sources and never overwrites an export', async () => {
    const { createProfileEnvelope, verifyProfileEnvelope, writeProfileExport } = await import('../../scripts/export-electron-profile.mjs');
    expect(() => createProfileEnvelope({ database: {}, sourceVersion: '1.5.1' })).toThrow(/renderer|localStorage/i);
    const envelope = createProfileEnvelope({ database: { settings: null }, localStorage: {}, sourceVersion: '1.5.1' });
    expect(() => verifyProfileEnvelope({ ...envelope, payloadJson: envelope.payloadJson + ' ' })).toThrow(/checksum/i);
    const directory = mkdtempSync(path.join(os.tmpdir(), 'studypilot-export-test-')); directories.push(directory);
    const output = path.join(directory, 'profile.json');
    await writeProfileExport(output, envelope);
    const original = readFileSync(output, 'utf8');
    await expect(writeProfileExport(output, envelope)).rejects.toThrow(/exist/i);
    expect(readFileSync(output, 'utf8')).toBe(original);
  });

  it('exports only the explicitly supplied database and never lets a renderer snapshot replace it', async () => {
    const { verifyProfileEnvelope } = await import('../../scripts/export-electron-profile.mjs');
    const directory = mkdtempSync(path.join(os.tmpdir(), 'studypilot-export-cli-test-')); directories.push(directory);
    const database = path.join(directory, 'database.json'), renderer = path.join(directory, 'renderer.json'), output = path.join(directory, 'export.json');
    const original = JSON.stringify({ settings: { marker: 'original-fixture-only' }, history: ['retain'] });
    writeFileSync(database, original);
    writeFileSync(renderer, JSON.stringify({ database: { settings: 'must not replace the selected source' }, localStorage: { studypilot_dock_ui_v1: '{}' }, indexedDBDatabases: [] }));
    const result = execFileSync(process.execPath, ['scripts/export-electron-profile.mjs', '--database', database, '--renderer-json', renderer, '--output', output, '--source-version', '1.5.1'], { encoding: 'utf8' });
    expect(result).not.toContain('original-fixture-only');
    expect(verifyProfileEnvelope(JSON.parse(readFileSync(output, 'utf8'))).database).toEqual(JSON.parse(original));
    expect(readFileSync(database, 'utf8')).toBe(original);
  });

  it('refuses debugger discovery redirects before making a request outside the selected endpoint', async () => {
    let otherRequests = 0;
    const other = createServer((_request, response) => { otherRequests++; response.writeHead(200).end('[]'); });
    await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
    const otherPort = (other.address() as { port: number }).port;
    const source = createServer((_request, response) => { response.writeHead(302, { location: `http://127.0.0.1:${otherPort}/json/list` }).end(); });
    await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
    const directory = mkdtempSync(path.join(os.tmpdir(), 'studypilot-export-redirect-test-')); directories.push(directory);
    writeFileSync(path.join(directory, 'database.json'), '{}');
    try {
      await expect(promisify(execFile)(process.execPath, ['scripts/export-electron-profile.mjs', '--database', path.join(directory, 'database.json'), '--cdp', `http://127.0.0.1:${(source.address() as { port: number }).port}`, '--ui-url', 'file:///explicit-ui.html', '--output', path.join(directory, 'export.json'), '--source-version', '1.5.1'])).rejects.toThrow();
      expect(otherRequests).toBe(0);
    } finally {
      await Promise.all([new Promise<void>(resolve => source.close(() => resolve())), new Promise<void>(resolve => other.close(() => resolve()))]);
    }
  });
});

describe('Rust profile startup restore', () => {
  function startup(profile: unknown, initial: Record<string, string> = {}) {
    const entries = new Map(Object.entries(initial));
    const storage = {
      get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null,
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => { entries.set(key, value); }),
      removeItem: (key: string) => { entries.delete(key); },
    };
    const invoke = vi.fn(async () => profile);
    vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: storage, __RUST_HOST__: { identity: 'rust', invoke, listen: vi.fn() } }));
    return { entries, invoke, storage };
  }

  it('restores settings, history and preferences before the core and skips already applied profiles', async () => {
    const token = 'a'.repeat(64);
    const host = startup({ token, localStorage: { studypilot_settings_v3: '{"theme":"light"}', studypilot_dock_ui_v1: '{"edge":"left"}' } }, { studypilot_old_preview_key: 'remove', unrelated: 'retain' });
    const { restoreImportedProfile } = await import('../../src/desktop-rust/migrationUI');
    await restoreImportedProfile();
    expect(host.invoke).toHaveBeenCalledWith('profile:startup', undefined);
    expect(host.entries.get('studypilot_dock_ui_v1')).toBe('{"edge":"left"}');
    expect(host.entries.has('studypilot_old_preview_key')).toBe(false);
    expect(host.entries.get('unrelated')).toBe('retain');
    expect(host.entries.get('rust-profile-applied')).toBe(token);
    host.entries.set('studypilot_dock_ui_v1', '{"edge":"right"}');
    await restoreImportedProfile();
    expect(host.entries.get('studypilot_dock_ui_v1')).toBe('{"edge":"right"}');
  });

  it('rolls back local storage after a failed write and never marks a partial import applied', async () => {
    const host = startup({ token: 'b'.repeat(64), localStorage: { studypilot_settings_v3: 'new', studypilot_dock_ui_v1: 'reject' } }, { studypilot_settings_v3: 'old' });
    const write = host.storage.setItem.getMockImplementation()!;
    host.storage.setItem.mockImplementation((key, value) => { if (key === 'studypilot_dock_ui_v1') throw new Error('quota'); write(key, value); });
    const { restoreImportedProfile } = await import('../../src/desktop-rust/migrationUI');
    await expect(restoreImportedProfile()).rejects.toThrow(/存储|storage/i);
    expect(host.entries.get('studypilot_settings_v3')).toBe('old');
    expect(host.entries.has('rust-profile-applied')).toBe(false);
  });

  it('rejects malformed native import data without touching renderer storage', async () => {
    const host = startup({ token: 'c'.repeat(64), localStorage: { 'unrelated-token': 'reject' } }, { studypilot_settings_v3: 'old' });
    const { restoreImportedProfile } = await import('../../src/desktop-rust/migrationUI');
    await expect(restoreImportedProfile()).rejects.toThrow(/迁移|profile/i);
    expect(host.storage.setItem).not.toHaveBeenCalled();
  });
});

it('mounts migration settings once, stages the user-selected file and requires an explicit commit click', async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const bundle = await build({ entryPoints: ['src/desktop-rust/migrationUI.ts'], bundle: true, write: false, format: 'iife', globalName: 'MigrationFixture', platform: 'browser' });
  const server = createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<html><body><main id="settings"><section class="dock-settings">Original settings</section></main></body></html>'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await page.evaluate(() => {
      (window as any).__migrationCalls = [];
      (window as any).__RUST_HOST__ = { identity: 'rust', listen: async () => () => {}, invoke: async (command: string, payload: unknown) => {
        (window as any).__migrationCalls.push({ command, payload });
        if (command === 'profile:stage') return { token: 'd'.repeat(64), sourceVersion: '1.5.1', localStorageKeys: 5 };
        throw new Error('fixture refuses commit');
      } };
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => { (window as any).MigrationFixture.installMigrationUI(); (window as any).MigrationFixture.installMigrationUI(); });
    expect(await page.locator('#rust-profile-migration').count()).toBe(1);
    const confirm = page.getByRole('button', { name: '确认导入并重新加载' });
    expect(await confirm.isDisabled()).toBe(true);
    const input = page.getByLabel('选择 Electron 迁移包');
    await input.setInputFiles({ name: 'fixture.json', mimeType: 'application/json', buffer: Buffer.from('{"fixture":"user-selected"}') });
    await page.waitForFunction(() => !(document.querySelector('#rust-profile-migration button') as HTMLButtonElement).disabled);
    expect(await page.evaluate(() => (window as any).__migrationCalls.map((entry: any) => entry.command))).toEqual(['profile:stage']);
    expect(await page.locator('#rust-profile-migration [role="status"]').textContent()).toContain('5 项');
    await confirm.click();
    await page.waitForFunction(() => document.querySelector('#rust-profile-migration [role="status"]')?.textContent?.includes('导入未完成'));
    expect(await page.evaluate(() => (window as any).__migrationCalls.map((entry: any) => entry.command))).toEqual(['profile:stage', 'profile:commit']);
    expect(await page.evaluate(() => localStorage.getItem('rust-profile-applied'))).toBeNull();
    await page.evaluate(() => { document.getElementById('settings')!.innerHTML = '<section class="dock-settings">Remounted settings</section>'; });
    await page.waitForSelector('#rust-profile-migration');
    expect(await page.locator('#rust-profile-migration').count()).toBe(1);
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 15000);
