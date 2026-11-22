import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  applyLiquidGlassPreset,
  createDefaultLiquidGlassSettings,
  deleteSavedPreset,
  exportLiquidGlassJson,
  getProgressTier,
  interpolateLiquidGlassFromProgress,
  LIQUID_GLASS_PRESET_ANCHORS,
  LIQUID_GLASS_PRESETS_STORAGE_KEY,
  LIQUID_GLASS_STORAGE_KEY,
  loadLiquidGlassSettings,
  loadSavedPresets,
  parseImportedLiquidGlassJson,
  resetLiquidGlassAdvanced,
  sanitizeLiquidGlassSettings,
  saveLiquidGlassSettings,
  saveNamedPreset,
  updateLiquidGlassAdvanced,
  updateLiquidGlassProgress,
} from '../src/desktop/liquidGlassStore';
import {
  computeLiquidGlassCssVars,
  targetDockGlassQuality,
} from '../src/desktop/liquidGlassRuntime';

function createMemoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get length() { return map.size; },
    clear() { map.clear(); },
    getItem(key: string) { return map.get(key) ?? null; },
    key(index: number) { return [...map.keys()][index] ?? null; },
    removeItem(key: string) { map.delete(key); },
    setItem(key: string, value: string) { map.set(key, String(value)); },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('liquidGlassStore presets, interpolation and persistence', () => {
  it('uses studypilot_ storage keys compatible with Rust profile migration', () => {
    expect(LIQUID_GLASS_STORAGE_KEY).toMatch(/^studypilot[_-]/);
    expect(LIQUID_GLASS_PRESETS_STORAGE_KEY).toMatch(/^studypilot[_-]/);
  });

  it('matches preset anchors and progress tier thresholds', () => {
    const base = createDefaultLiquidGlassSettings();
    expect(base.preset).toBe('balanced');
    expect(base.progress).toBe(0.5);

    const readable = applyLiquidGlassPreset(base, 'readable');
    expect(readable.progress).toBe(0.22);
    expect(readable.advanced).toEqual(LIQUID_GLASS_PRESET_ANCHORS.readable.advanced);
    expect(getProgressTier(readable.progress)).toEqual({ tier: 'clear', label: '通透', percent: 22 });

    const prism = applyLiquidGlassPreset(base, 'prism');
    expect(prism.progress).toBe(0.38);
    expect(prism.advanced.chromaticAberration).toBe(0.92);
    expect(prism.advanced.refractionIntensity).toBe(0.92);
    expect(getProgressTier(prism.progress)).toEqual({ tier: 'balanced', label: '平衡', percent: 38 });

    const frosted = applyLiquidGlassPreset(base, 'classic_frosted');
    expect(frosted.progress).toBe(0.85);
    expect(frosted.advanced.chromaticAberration).toBe(0);
    expect(frosted.advanced.refractionIntensity).toBe(0);
    expect(getProgressTier(frosted.progress)).toEqual({ tier: 'frosted', label: '磨砂', percent: 85 });

    expect(getProgressTier(0.33)).toMatchObject({ tier: 'clear', label: '通透' });
    expect(getProgressTier(0.34)).toMatchObject({ tier: 'balanced', label: '平衡' });
    expect(getProgressTier(0.67)).toMatchObject({ tier: 'balanced', label: '平衡' });
    expect(getProgressTier(0.68)).toMatchObject({ tier: 'frosted', label: '磨砂' });
  });

  it('interpolates smoothly from clear through balanced to frosted and switches to custom on tweaks', () => {
    const clear = interpolateLiquidGlassFromProgress(0);
    const mid = interpolateLiquidGlassFromProgress(0.5);
    const frosted = interpolateLiquidGlassFromProgress(1);

    expect(mid).toEqual(LIQUID_GLASS_PRESET_ANCHORS.balanced.advanced);
    expect(clear.blurStrength).toBeLessThan(mid.blurStrength);
    expect(mid.blurStrength).toBeLessThan(frosted.blurStrength);
    expect(clear.chromaticAberration).toBeGreaterThan(frosted.chromaticAberration);

    const moved = updateLiquidGlassProgress(createDefaultLiquidGlassSettings(), 0.72);
    expect(moved.preset).toBe('custom');
    expect(moved.progress).toBe(0.72);

    const tweaked = updateLiquidGlassAdvanced(applyLiquidGlassPreset(moved, 'prism'), { blurStrength: 0.91 });
    expect(tweaked.preset).toBe('custom');
    expect(tweaked.advanced.blurStrength).toBe(0.91);

    const restored = resetLiquidGlassAdvanced(tweaked);
    expect(restored.preset).toBe('balanced');
    expect(restored.advanced).toEqual(LIQUID_GLASS_PRESET_ANCHORS.balanced.advanced);
  });

  it('persists settings, sanitizes corrupt storage, and supports named preset CRUD', () => {
    const storage = createMemoryStorage();
    const custom = updateLiquidGlassProgress({
      ...createDefaultLiquidGlassSettings(),
      enabled: false,
      readabilityMode: 'stable',
      dockMotionStyle: 'standard',
      popupPalette: 'theme_frosted',
      scenes: { dock: false, topChrome: true, sheetsAndCards: true, popupsAndMenus: false, footerBar: true },
    }, 0.64);
    saveLiquidGlassSettings(custom, storage);
    expect(loadLiquidGlassSettings(storage)).toEqual(custom);

    expect(sanitizeLiquidGlassSettings({ progress: 99, enabled: 'bad', preset: 'unknown' })).toMatchObject({
      version: 1,
      enabled: true,
      progress: 1,
      preset: 'balanced',
    });

    expect(() => saveNamedPreset('   ', custom, storage)).toThrow(/名称/);
    const afterSave = saveNamedPreset('深夜冰透', custom, storage);
    expect(afterSave).toHaveLength(1);
    expect(afterSave[0].name).toBe('深夜冰透');
    expect(loadSavedPresets(storage)[0].settings.popupPalette).toBe('theme_frosted');

    const afterDelete = deleteSavedPreset(afterSave[0].id, storage);
    expect(afterDelete).toHaveLength(0);
  });

  it('exports and strictly validates imported JSON while rejecting malformed payloads', () => {
    const settings = applyLiquidGlassPreset(createDefaultLiquidGlassSettings(), 'prism');
    const presets = [{ id: 'p1', name: '我的棱镜', createdAt: 1700000000000, settings }];
    const json = exportLiquidGlassJson(settings, presets);
    const parsed = parseImportedLiquidGlassJson(json);
    expect(parsed.settings).toEqual(settings);
    expect(parsed.savedPresets).toHaveLength(1);
    expect(parsed.savedPresets![0].name).toBe('我的棱镜');

    for (const bad of [
      '',
      '{not-json',
      '[]',
      '{"schema":"wrong","settings":{}}',
      '{"version":2,"enabled":true,"progress":0.5,"preset":"balanced"}',
      '{"version":1,"enabled":"yes","progress":0.5,"preset":"balanced"}',
      '{"version":1,"enabled":true,"progress":1.5,"preset":"balanced"}',
      '{"version":1,"enabled":true,"progress":0.5,"preset":"nonexistent"}',
      '{"version":1,"enabled":true,"progress":0.5,"preset":"balanced","scenes":{"invalidScene":true}}',
      '{"version":1,"enabled":true,"progress":0.5,"preset":"balanced","advanced":{"blurStrength":2}}',
    ]) {
      expect(() => parseImportedLiquidGlassJson(bad)).toThrow();
    }
  });

  it('maps settings to CSS variables and dock optical quality', () => {
    const balanced = createDefaultLiquidGlassSettings();
    const vars = computeLiquidGlassCssVars(balanced);
    expect(vars['--lg-blur-px']).toMatch(/^\d+px$/);
    expect(vars['--lg-dock-timing']).toContain('1.38');
    expect(targetDockGlassQuality(balanced)).toBe('ultra');

    const frosted = applyLiquidGlassPreset(balanced, 'classic_frosted');
    expect(targetDockGlassQuality(frosted)).toBe('standard');

    const disabled = { ...balanced, enabled: false };
    expect(computeLiquidGlassCssVars(disabled)['--lg-blur-px']).toBe('0px');
    expect(targetDockGlassQuality(disabled)).toBe('standard');

    // Dark sheet and card alphas keep WCAG readability headroom over pure white pages
    for (const preset of ['readable', 'balanced', 'prism', 'classic_frosted'] as const) {
      const presetVars = computeLiquidGlassCssVars(applyLiquidGlassPreset(balanced, preset));
      expect(Number(presetVars['--lg-surface-alpha-dark'])).toBeGreaterThanOrEqual(0.87);
      expect(Number(presetVars['--lg-card-alpha-dark'])).toBeGreaterThanOrEqual(0.73);
    }
  });
});

describe('Liquid Glass runtime, modal semantics and settings UI in browser', () => {
  it('fixes modal role="dialog", dock lens contrast, and drives full liquid glass settings interactions', async () => {
    const { build } = await import('esbuild');
    const { chromium } = await import('playwright-core');
    const desktopCss = readFileSync(path.join(process.cwd(), 'src/desktop/desktop.css'), 'utf8');
    const dockAdaptiveCss = readFileSync(path.join(process.cwd(), 'src/components/dockAdaptive.css'), 'utf8');
    const themeCss = readFileSync(path.join(process.cwd(), 'src/desktop/liquidGlassTheme.css'), 'utf8');

    const bundle = await build({
      entryPoints: ['src/desktop/liquidGlassRuntime.ts'],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: 'LiquidGlassRuntimeFixture',
      platform: 'browser',
      loader: { '.css': 'empty' },
    });

    const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <style>${dockAdaptiveCss}</style>
  <style>${desktopCss}</style>
  <style>${themeCss}</style>
</head>
<body>
  <div class="app-shell desktop-shell" data-theme="dark">
    <header class="app-header">
      <button class="theme-switch-btn" type="button" onclick="
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        document.querySelector('.desktop-shell').dataset.theme = next;
      ">切换主题</button>
    </header>
    <main class="app-workspace">
      <nav class="mobile-tabs adaptive-dock" data-backdrop-tone="dark" data-scene-tone="light" data-vertical="false">
        <button class="mobile-tab is-active" type="button">
          <span class="mobile-tab__content">答题</span>
          <span class="mobile-tab__lens">答题</span>
        </button>
      </nav>
      <div id="settings-host">
        <section class="glass-panel dock-settings"><h5>工具栏与液态玻璃</h5></section>
      </div>
      <div class="workbench-drag-shield" style="position:fixed;inset:0;z-index:10000"></div>
    </main>
  </div>
</body>
</html>`;

    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });

    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
      await page.evaluate(() => {
        localStorage.setItem('studypilot_unrelated_business_key', 'keep-me');
      });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });

      // 1. Verify root attributes and dock contrast override
      const rootState = await page.evaluate(() => {
        const root = document.documentElement;
        const lens = document.querySelector('.mobile-tab__lens')!;
        const dock = document.querySelector('.adaptive-dock')!;
        return {
          ready: root.dataset.lgReady,
          enabled: root.dataset.lgEnabled,
          readability: root.dataset.lgReadability,
          blurPx: root.style.getPropertyValue('--lg-blur-px'),
          lensColor: getComputedStyle(lens).color,
          dockMaxWidth: getComputedStyle(dock).maxWidth,
        };
      });
      expect(rootState.ready).toBe('true');
      expect(rootState.enabled).toBe('true');
      expect(rootState.readability).toBe('adaptive');
      expect(rootState.blurPx).toMatch(/^\d+px$/);
      // Must be Android #075fc9 (rgb(7, 95, 201)), NOT desktop.css white rgb(255, 255, 255)
      expect(rootState.lensColor).toBe('rgb(7, 95, 201)');
      expect(rootState.dockMaxWidth).toBe('none');

      // 2. Verify startup notice modal auto-receives role="dialog", aria-modal, data-native-modal
      await page.evaluate(() => {
        const shell = document.querySelector('.app-shell')!;
        const overlay = document.createElement('div');
        overlay.id = 'startup-notice-fixture';
        overlay.setAttribute('style', 'position: fixed; inset: 0; z-index: 10000; background: rgba(3,2,8,0.72); display: flex; align-items: center; justify-content: center; padding: 20px;');
        overlay.innerHTML = `<div class="glass-panel animate-fade-in"><h2>使用公告</h2><button id="close-notice-btn" type="button" onclick="this.closest('#startup-notice-fixture').remove()">我知道了</button></div>`;
        shell.appendChild(overlay);
      });
      await page.waitForFunction(() => document.getElementById('startup-notice-fixture')?.getAttribute('role') === 'dialog');
      const modalAttrs = await page.evaluate(() => {
        const overlay = document.getElementById('startup-notice-fixture')!;
        const card = overlay.querySelector('.glass-panel') as HTMLElement;
        const shield = document.querySelector('.workbench-drag-shield')!;
        return {
          role: overlay.getAttribute('role'),
          ariaModal: overlay.getAttribute('aria-modal'),
          ariaLabel: overlay.getAttribute('aria-label'),
          nativeModal: overlay.dataset.nativeModal,
          cardEnhanced: card.dataset.lgModalCard,
          shieldRole: shield.getAttribute('role'),
        };
      });
      expect(modalAttrs).toEqual({
        role: 'dialog',
        ariaModal: 'true',
        ariaLabel: '使用公告',
        nativeModal: 'true',
        cardEnhanced: 'true',
        shieldRole: null,
      });

      // Press Escape to dismiss modal cleanly, and remove drag shield fixture before clicking UI controls
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('startup-notice-fixture'));
      await page.evaluate(() => document.querySelector('.workbench-drag-shield')?.remove());

      // 3. Verify liquid glass settings panel mounted once & all controls work
      expect(await page.locator('#studypilot-liquid-glass-settings').count()).toBe(1);

      // Theme toggle (light <-> dark)
      await page.locator('[data-lg-theme-btn="light"]').click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
      expect(await page.evaluate(() => document.documentElement.dataset.lgTheme)).toBe('light');

      // Preset switching (prism -> classic_frosted)
      await page.locator('[data-lg-preset-btn="prism"]').click();
      expect(await page.evaluate(() => document.documentElement.dataset.lgPreset)).toBe('prism');
      expect(await page.locator('[data-lg-preview-badge="true"]').textContent()).toContain('平衡 · 38%');

      await page.locator('[data-lg-preset-btn="classic_frosted"]').click();
      expect(await page.evaluate(() => document.documentElement.dataset.lgPreset)).toBe('classic_frosted');
      expect(await page.locator('[data-lg-preview-badge="true"]').textContent()).toContain('磨砂 · 85%');
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('studypilot_dock_ui_v1') || '{}').glass)).toBe('standard');

      // Progress slider & backdrop switcher
      await page.locator('[data-lg-backdrop-btn="light-grid"]').click();
      expect(await page.locator('[data-lg-preview="true"]').getAttribute('data-backdrop')).toBe('light-grid');

      await page.locator('[data-lg-control="progress"]').fill('18');
      await page.locator('[data-lg-control="progress"]').dispatchEvent('input');
      expect(await page.locator('[data-lg-preview-badge="true"]').textContent()).toContain('通透 · 18%');

      // Readability mode, motion styles, popup palette, scene switch, master switch
      await page.locator('[data-lg-readability-btn="stable"]').click();
      expect(await page.evaluate(() => document.documentElement.dataset.lgReadability)).toBe('stable');

      await page.locator('[data-lg-popup-palette-btn="theme_frosted"]').click();
      expect(await page.evaluate(() => document.documentElement.dataset.lgPopupPalette)).toBe('theme_frosted');

      await page.locator('[data-lg-control="scene-footerBar"]').uncheck();
      expect(await page.evaluate(() => document.documentElement.dataset.lgSceneFooter)).toBe('false');

      await page.locator('[data-lg-control="master-enabled"]').uncheck();
      expect(await page.evaluate(() => document.documentElement.dataset.lgEnabled)).toBe('false');
      // Scene choice preserved when master switch is turned off
      expect(await page.locator('[data-lg-control="scene-footerBar"]').isChecked()).toBe(false);
      await page.locator('[data-lg-control="master-enabled"]').check();

      // Save named preset & apply & delete
      await page.locator('[data-lg-control="preset-name"]').fill('清爽学习模式');
      await page.locator('[data-lg-action="save-preset"]').click();
      expect(await page.locator('[data-lg-saved-list="true"]').textContent()).toContain('清爽学习模式');

      // Invalid JSON import rejected without modifying existing settings or unrelated business keys
      const beforeImport = await page.evaluate(() => localStorage.getItem('studypilot_liquid_glass_v1'));
      await page.locator('[data-lg-control="import-json"]').setInputFiles({
        name: 'broken.json',
        mimeType: 'application/json',
        buffer: Buffer.from('{"broken": true}'),
      });
      await page.waitForFunction(() => document.querySelector('[data-lg-status="true"]')?.getAttribute('data-tone') === 'error');
      expect(await page.evaluate(() => localStorage.getItem('studypilot_liquid_glass_v1'))).toBe(beforeImport);
      expect(await page.evaluate(() => localStorage.getItem('studypilot_unrelated_business_key'))).toBe('keep-me');

      // Valid JSON import succeeds
      const validExport = exportLiquidGlassJson(applyLiquidGlassPreset(createDefaultLiquidGlassSettings(), 'prism'));
      await page.locator('[data-lg-control="import-json"]').setInputFiles({
        name: 'valid.json',
        mimeType: 'application/json',
        buffer: Buffer.from(validExport),
      });
      await page.waitForFunction(() => document.documentElement.dataset.lgPreset === 'prism');
      expect(await page.locator('[data-lg-status="true"]').getAttribute('data-tone')).toBe('success');
      expect(await page.evaluate(() => localStorage.getItem('studypilot_unrelated_business_key'))).toBe('keep-me');

      // Remount resilience when settings panel re-renders
      await page.evaluate(() => {
        document.getElementById('settings-host')!.innerHTML = '<section class="glass-panel dock-settings">Remounted</section>';
      });
      await page.waitForSelector('#studypilot-liquid-glass-settings');
      expect(await page.locator('#studypilot-liquid-glass-settings').count()).toBe(1);
    } finally {
      await browser.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 20000);

  it('lifts Settings API Key modal above AnnouncementBanner and keeps dark KB contrast >= 4.5:1 over pure white', async () => {
    const { build } = await import('esbuild');
    const { chromium } = await import('playwright-core');
    const indexCss = readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8');
    const desktopCss = readFileSync(path.join(process.cwd(), 'src/desktop/desktop.css'), 'utf8');
    const dockAdaptiveCss = readFileSync(path.join(process.cwd(), 'src/components/dockAdaptive.css'), 'utf8');
    const themeCss = readFileSync(path.join(process.cwd(), 'src/desktop/liquidGlassTheme.css'), 'utf8');

    const bundle = await build({
      entryPoints: ['src/desktop/liquidGlassRuntime.ts'],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: 'LiquidGlassRuntimeModalFixture',
      platform: 'browser',
      loader: { '.css': 'empty' },
    });

    const whiteSvgDataUrl = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#ffffff"/></svg>')}`;

    const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <style>${indexCss}</style>
  <style>${dockAdaptiveCss}</style>
  <style>${desktopCss}</style>
  <style>${themeCss}</style>
  <style>
    html, body, #root, .desktop-shell, .app-workspace, .browser-deck { background: #ffffff !important; }
  </style>
</head>
<body>
  <div id="root">
    <div class="app-shell desktop-shell" data-theme="dark">
      <header class="app-shell-bar app-window-titlebar app-header"><span>WISP</span></header>
      <main class="app-workspace">
        <section class="browser-deck"></section>
        <aside id="desktop-tool-panel" class="desktop-sheet is-open" style="width: 540px;">
          <div class="desktop-sheet__material"><img src="${whiteSvgDataUrl}" style="inset:0;width:100%;height:100%;" alt="" /></div>
          <div class="desktop-sheet__heading"><span>本地题库</span><span>再次点击当前工具收起</span></div>
          <div id="announcement-banner" style="background: linear-gradient(135deg, rgba(99,102,241,0.15), rgba(168,85,247,0.15)); border: 1px solid rgba(99,102,241,0.3); border-radius: 8px; padding: 14px; margin: 0 20px 16px 20px; position: relative;">
            <h4>操作公告（最新）</h4>
            <p>推荐流程：设置中启用真实 WebView，配置 AI 或导入本地题库，进入作业/考试页后先抓题，再解析，最后填入。</p>
            <p>网页 AI 使用步骤：抓题 -> 打开网页 AI -> 填入提示词 -> 提取答案 -> 入库 -> 填入原页面。</p>
          </div>
          <div class="desktop-tool-content side-panel-content">
            <div class="side-panel-page" id="kb-page">
              <div class="knowledge-workbench">
                <section class="kb-bento-grid">
                  <div class="kb-bento-card kb-bento-card--hero">
                    <div class="kb-bento-card__topline"><div><span class="kb-kicker">本地题库总览</span></div></div>
                    <p>已建立本地索引，命中时优先返回，不消耗 AI 调用额度。</p>
                    <div class="kb-bento-card__foot"><span>本地检索优先</span><strong>0 / 1000</strong></div>
                  </div>
                </section>
                <section class="kb-filter-area">
                  <label class="kb-search-bar"><input placeholder="搜索题干、选项、答案或解析..." /></label>
                  <div class="kb-type-pills">
                    <button type="button" class="kb-type-pill is-active">全部题目<span>0</span></button>
                    <button type="button" class="kb-type-pill">单选题<span>0</span></button>
                  </div>
                </section>
                <button id="open-key-help" type="button">没有秘钥，前往</button>
                <div id="modal-slot"></div>
              </div>
            </div>
          </div>
        </aside>
        <nav class="mobile-tabs adaptive-dock" data-backdrop-tone="dark" data-scene-tone="light" data-vertical="false" style="left: 400px; top: 760px; width: 480px; height: 60px;">
          <button id="dock-settings-btn" class="mobile-tab is-active" type="button" onclick="window.__dockClicks = (window.__dockClicks || 0) + 1">
            <span class="mobile-tab__content">设置</span>
          </button>
        </nav>
      </main>
      <footer class="app-shell-bar app-footer"><div class="app-footer__inner"><span>空闲</span></div></footer>
    </div>
  </div>
  <script>
    window.__dockClicks = 0;
    function openModal() {
      const slot = document.getElementById('modal-slot');
      slot.innerHTML = \`
        <div role="dialog" aria-modal="true" aria-label="获取 API Key" id="api-key-dialog"
             onclick="if (event.target === this) this.remove()"
             style="position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(2,6,23,0.68);backdrop-filter:blur(10px);">
          <div class="glass-panel" onclick="event.stopPropagation()"
               style="width:min(760px,100%);max-height:88vh;overflow-y:auto;border-radius:8px;padding:18px;display:flex;flex-direction:column;gap:16px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;">
              <div><div>获取 API Key</div><div>选择服务商后打开对应控制台，复制 Key 后回到设置页粘贴。</div></div>
              <button type="button" class="btn btn-icon btn-ghost" title="关闭" onclick="document.getElementById('api-key-dialog').remove()"><svg aria-hidden="true" width="17" height="17"></svg></button>
            </div>
            <div style="min-height:760px;">服务商列表内容</div>
          </div>
        </div>\`;
    }
    document.getElementById('open-key-help').addEventListener('click', openModal);
  </script>
</body>
</html>`;

    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });

    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
      page.setDefaultTimeout(4000);
      await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.waitForFunction(() => document.documentElement.dataset.lgReady === 'true');

      // Open API Key help modal inside .desktop-sheet and verify real pointer click on close button
      await page.locator('#open-key-help').click();
      const dialog = page.getByRole('dialog', { name: '获取 API Key' });
      await dialog.waitFor({ state: 'visible' });

      const modalGeometry = await page.evaluate(() => {
        const el = document.getElementById('api-key-dialog')!;
        const sheet = document.querySelector('.desktop-sheet') as HTMLElement;
        const closeBtn = el.querySelector('button[title="关闭"]')!;
        const dr = el.getBoundingClientRect();
        const br = closeBtn.getBoundingClientRect();
        const hit = document.elementFromPoint(br.x + br.width / 2, br.y + br.height / 2);
        return {
          dialogWidth: Math.round(dr.width),
          dialogHeight: Math.round(dr.height),
          sheetHasModal: sheet.dataset.lgHasModal,
          hitIsCloseBtn: hit === closeBtn || closeBtn.contains(hit),
        };
      });
      expect(modalGeometry.dialogWidth).toBe(1280);
      expect(modalGeometry.dialogHeight).toBe(850);
      expect(modalGeometry.sheetHasModal).toBe('true');
      expect(modalGeometry.hitIsCloseBtn).toBe(true);

      // Normal Playwright pointer click on close button must succeed immediately
      await dialog.getByRole('button', { name: /关闭/ }).click({ timeout: 2000 });
      expect(await page.locator('#api-key-dialog').count()).toBe(0);
      await page.waitForFunction(() => !(document.querySelector('.desktop-sheet') as HTMLElement)?.dataset.lgHasModal);

      // Scrim click closes modal cleanly and Dock interaction stays restored
      await page.locator('#open-key-help').click();
      await dialog.waitFor({ state: 'visible' });
      await page.mouse.click(40, 40);
      expect(await page.locator('#api-key-dialog').count()).toBe(0);

      await page.locator('#dock-settings-btn').click({ timeout: 2000 });
      expect(await page.evaluate(() => (window as any).__dockClicks)).toBe(1);

      // Verify dark theme ink tokens & composited contrast over pure white (#ffffff)
      const contrastCheck = await page.evaluate(() => {
        const rootStyle = getComputedStyle(document.documentElement);
        const surfaceAlpha = parseFloat(rootStyle.getPropertyValue('--lg-surface-alpha-dark'));
        const cardAlpha = parseFloat(rootStyle.getPropertyValue('--lg-card-alpha-dark'));
        const matOpacity = parseFloat(getComputedStyle(document.querySelector('.desktop-sheet__material img')!).opacity);

        const parseRgb = (cssColor: string) => cssColor.match(/[\d.]+/g)!.slice(0, 3).map(Number);
        const blend = (fg: number[], a: number, bg: number[]) => fg.map((v, i) => v * a + bg[i] * (1 - a));
        const lum = (rgb: number[]) => rgb.map(v => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        const ratio = (a: number[], b: number[]) => {
          const la = lum(a), lb = lum(b);
          return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
        };

        const white = [255, 255, 255];
        const sheetOverWhite = blend(white, matOpacity, blend([14, 25, 45], surfaceAlpha, white));
        const cardOverSheet = blend([24, 41, 70], cardAlpha * 0.9, sheetOverWhite);
        const controlOverSheet = blend([32, 54, 90], 0.72, sheetOverWhite);

        const probes: Array<[string, number[], boolean]> = [
          ['.desktop-sheet__heading > span:first-child', sheetOverWhite, false],
          ['.kb-kicker', cardOverSheet, false],
          ['.kb-bento-card p', cardOverSheet, false],
          ['.kb-bento-card__foot > span:first-child', cardOverSheet, false],
          ['.kb-search-bar input', cardOverSheet, true],
          ['.kb-type-pill:not(.is-active)', controlOverSheet, false],
        ];
        return probes.map(([selector, bg, placeholder]) => {
          const el = document.querySelector(`.desktop-sheet ${selector}`)!;
          const fg = parseRgb(getComputedStyle(el, placeholder ? '::placeholder' : null).color);
          return { selector, fg, contrast: ratio(fg, bg) };
        });
      });
      for (const item of contrastCheck) {
        expect(item.contrast, `${item.selector} contrast ${item.contrast.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      await browser.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 20000);
});
