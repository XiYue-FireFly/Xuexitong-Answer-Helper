import {
  applyLiquidGlassPreset,
  deleteSavedPreset,
  exportLiquidGlassJson,
  getProgressTier,
  LIQUID_GLASS_PRESET_ANCHORS,
  liquidGlassStore,
  loadSavedPresets,
  mergeImportedSavedPresets,
  parseImportedLiquidGlassJson,
  resetLiquidGlassAdvanced,
  saveNamedPreset,
  updateLiquidGlassAdvanced,
  updateLiquidGlassProgress,
  type GlassMotionStyle,
  type GlassPopupPalette,
  type LiquidGlassAdvanced,
  type LiquidGlassPreset,
  type LiquidGlassReadabilityMode,
  type LiquidGlassSceneKey,
  type LiquidGlassSettings,
  type PreviewBackdropId,
} from './liquidGlassStore';

export const LIQUID_GLASS_SETTINGS_SECTION_ID = 'studypilot-liquid-glass-settings';

const installations = new WeakMap<Document, () => void>();

const BACKDROP_OPTIONS: readonly { id: PreviewBackdropId; label: string }[] = [
  { id: 'aurora', label: '极光蓝' },
  { id: 'light-grid', label: '冰瓷亮格' },
  { id: 'dark-nebula', label: '深海星云' },
  { id: 'warm-sunset', label: '暖阳霞光' },
];

const PRESET_ORDER: readonly Exclude<LiquidGlassPreset, 'custom'>[] = [
  'readable',
  'balanced',
  'prism',
  'classic_frosted',
];

const SCENE_ITEMS: readonly { key: LiquidGlassSceneKey; label: string; desc: string }[] = [
  { key: 'dock', label: '悬浮工具栏', desc: '底部/侧边胶囊与实时折射透镜' },
  { key: 'topChrome', label: '顶部标题与标签栏', desc: '窗口顶栏、浏览器胶囊标签与地址栏' },
  { key: 'sheetsAndCards', label: '工具抽屉与卡片', desc: '工作台抽屉、题库与设置卡片' },
  { key: 'popupsAndMenus', label: '弹窗与右键菜单', desc: '公告弹窗、API Key 帮助与右键菜单' },
  { key: 'footerBar', label: '底部状态栏', desc: '状态条与日志抽屉' },
];

const ADVANCED_SLIDERS: readonly { key: keyof LiquidGlassAdvanced; label: string }[] = [
  { key: 'blurStrength', label: '背景模糊强度' },
  { key: 'headerBlurExtent', label: '顶栏渐进模糊范围' },
  { key: 'contentReadability', label: '内容可读性护眼层' },
  { key: 'chromaticAberration', label: '边缘棱镜彩光（色散）' },
  { key: 'refractionIntensity', label: '边缘折射高光强度' },
  { key: 'saturationBoost', label: '色彩饱和度增强' },
];

function currentTheme(doc: Document): 'light' | 'dark' {
  const rootTheme = doc.documentElement?.dataset?.theme || doc.querySelector<HTMLElement>('.desktop-shell')?.dataset?.theme;
  return rootTheme === 'light' ? 'light' : 'dark';
}

async function applyAppTheme(doc: Document, nextTheme: 'light' | 'dark'): Promise<void> {
  if (currentTheme(doc) === nextTheme) return;
  try {
    const { appStore } = await import('../store/appStore');
    appStore.updateSettings({ theme: nextTheme });
    const api = (window as any).electronAPI;
    if (api?.setSettings) {
      void Promise.resolve(api.setSettings(appStore.getState().settings)).catch(() => undefined);
    }
    api?.setTitlebarTheme?.(nextTheme);
  } catch {
    // Fallback for standalone DOM environments without appStore.
  }
  doc.documentElement.dataset.theme = nextTheme;
  doc.documentElement.dataset.lgTheme = nextTheme;
  if (doc.body) doc.body.dataset.theme = nextTheme;
  const shell = doc.querySelector<HTMLElement>('.desktop-shell');
  if (shell) shell.dataset.theme = nextTheme;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createLiquidGlassSettingsSection(doc: Document): {
  section: HTMLElement;
  dispose: () => void;
} {
  const section = el(doc, 'section', 'glass-panel lg-settings');
  section.id = LIQUID_GLASS_SETTINGS_SECTION_ID;
  section.setAttribute('aria-label', '动效与反馈 · 液态玻璃与主题');

  // Header
  const header = el(doc, 'div', 'lg-settings__header');
  const titleWrap = el(doc, 'div', 'lg-settings__title-wrap');
  titleWrap.append(
    el(doc, 'h5', 'lg-settings__title', '动效与反馈 · 液态玻璃与主题'),
    el(doc, 'p', 'lg-settings__subtitle', '重新设计浅色「清透冰瓷」与暗色「深海曜石」主题，实时调节通透、折射、场景开关与个人预设。')
  );
  header.append(titleWrap);
  section.append(header);

  // 1. Theme quick switch
  const themeGroup = el(doc, 'div', 'lg-settings__group');
  const themeLabelRow = el(doc, 'div', 'lg-settings__label-row');
  const themeLabel = el(doc, 'span', undefined, '全局主题外观');
  const themeBadge = el(doc, 'span', 'lg-settings__value-pill');
  themeLabelRow.append(themeLabel, themeBadge);
  const themeButtons = el(doc, 'div', 'lg-settings__segmented');
  themeButtons.setAttribute('role', 'group');
  themeButtons.setAttribute('aria-label', '选择全局主题');
  const lightBtn = el(doc, 'button', undefined, '浅色 · 清透冰瓷');
  lightBtn.type = 'button';
  lightBtn.dataset.lgThemeBtn = 'light';
  const darkBtn = el(doc, 'button', undefined, '暗色 · 深海曜石');
  darkBtn.type = 'button';
  darkBtn.dataset.lgThemeBtn = 'dark';
  lightBtn.addEventListener('click', () => { void applyAppTheme(doc, 'light'); });
  darkBtn.addEventListener('click', () => { void applyAppTheme(doc, 'dark'); });
  themeButtons.append(lightBtn, darkBtn);
  themeGroup.append(themeLabelRow, themeButtons);
  section.append(themeGroup);

  // 2. Master liquid glass toggle
  const masterLabel = el(doc, 'label', 'lg-settings__switch-row');
  const masterText = el(doc, 'span');
  masterText.append(
    doc.createTextNode('启用液态玻璃效果'),
    el(doc, 'small', undefined, '关闭后仅停用液态玻璃效果，保留以下所有参数与场景设置')
  );
  const masterToggle = el(doc, 'input');
  masterToggle.type = 'checkbox';
  masterToggle.setAttribute('aria-label', '启用液态玻璃效果');
  masterToggle.dataset.lgControl = 'master-enabled';
  masterToggle.addEventListener('change', () => {
    liquidGlassStore.update(cur => ({ ...cur, enabled: masterToggle.checked }));
    setStatus(masterToggle.checked ? '已开启液态玻璃效果。' : '已关闭液态玻璃，参数与场景选择已保留。', 'info');
  });
  masterLabel.append(masterText, masterToggle);
  section.append(masterLabel);

  // Subcontrols container
  const subcontrols = el(doc, 'div', 'lg-settings__group lg-settings__subcontrols');

  // 3. Live Preview Card
  const preview = el(doc, 'div', 'lg-preview');
  preview.dataset.lgPreview = 'true';
  const previewTopbar = el(doc, 'div', 'lg-preview__topbar');
  const previewTitle = el(doc, 'span', undefined, '实时液态玻璃预览');
  const previewBadge = el(doc, 'span', 'lg-preview__badge');
  previewBadge.dataset.lgPreviewBadge = 'true';
  previewTopbar.append(previewTitle, previewBadge);

  const previewDock = el(doc, 'div', 'lg-preview__dock');
  const dockTabs = ['答题', '题库', '设置'].map((name, idx) => {
    const item = el(doc, 'span', `lg-preview__dock-item${idx === 0 ? ' is-active' : ''}`, name);
    return item;
  });
  previewDock.append(...dockTabs);

  const backdropBar = el(doc, 'div', 'lg-preview__backdrops');
  backdropBar.setAttribute('role', 'group');
  backdropBar.setAttribute('aria-label', '切换预览背景');
  const backdropBtns = new Map<PreviewBackdropId, HTMLButtonElement>();
  for (const bg of BACKDROP_OPTIONS) {
    const btn = el(doc, 'button', undefined, bg.label);
    btn.type = 'button';
    btn.dataset.lgBackdropBtn = bg.id;
    btn.addEventListener('click', () => {
      liquidGlassStore.update(cur => ({ ...cur, previewBackdrop: bg.id }));
    });
    backdropBtns.set(bg.id, btn);
    backdropBar.append(btn);
  }

  preview.append(previewTopbar, previewDock, backdropBar);
  subcontrols.append(preview);

  // 4. Main Progress Slider (通透 <-> 磨砂)
  const progressGroup = el(doc, 'div', 'lg-slider-wrap');
  const progressRow = el(doc, 'div', 'lg-settings__label-row');
  const progressLabel = el(doc, 'label', undefined, '材质通透与磨砂度');
  progressLabel.htmlFor = 'lg-progress-slider';
  const progressPill = el(doc, 'span', 'lg-settings__value-pill');
  progressPill.dataset.lgProgressPill = 'true';
  progressRow.append(progressLabel, progressPill);

  const progressSlider = el(doc, 'input');
  progressSlider.id = 'lg-progress-slider';
  progressSlider.type = 'range';
  progressSlider.min = '0';
  progressSlider.max = '100';
  progressSlider.step = '1';
  progressSlider.dataset.lgControl = 'progress';
  progressSlider.addEventListener('input', () => {
    const nextProgress = Number(progressSlider.value) / 100;
    liquidGlassStore.update(cur => updateLiquidGlassProgress(cur, nextProgress));
  });

  const progressScale = el(doc, 'div', 'lg-slider-scale');
  progressScale.append(
    el(doc, 'span', undefined, '通透 (0%)'),
    el(doc, 'span', undefined, '平衡 (50%)'),
    el(doc, 'span', undefined, '磨砂 (100%)')
  );
  progressGroup.append(progressRow, progressSlider, progressScale);
  subcontrols.append(progressGroup);

  // 5. Effect Presets (4 + custom indicator)
  const presetGroup = el(doc, 'div', 'lg-settings__group');
  const presetRow = el(doc, 'div', 'lg-settings__label-row');
  presetRow.append(el(doc, 'span', undefined, '效果预设'));
  const presetStatusPill = el(doc, 'span', 'lg-settings__value-pill');
  presetStatusPill.dataset.lgPresetPill = 'true';
  presetRow.append(presetStatusPill);

  const presetBtnsWrap = el(doc, 'div', 'lg-settings__segmented lg-settings__segmented--presets');
  presetBtnsWrap.setAttribute('role', 'group');
  presetBtnsWrap.setAttribute('aria-label', '选择液态玻璃效果预设');
  const presetButtons = new Map<LiquidGlassPreset, HTMLButtonElement>();
  for (const key of PRESET_ORDER) {
    const info = LIQUID_GLASS_PRESET_ANCHORS[key];
    const btn = el(doc, 'button', undefined, info.label);
    btn.type = 'button';
    btn.title = info.description;
    btn.dataset.lgPresetBtn = key;
    btn.addEventListener('click', () => {
      liquidGlassStore.update(cur => applyLiquidGlassPreset(cur, key));
      setStatus(`已应用「${info.label}」预设。`, 'info');
    });
    presetButtons.set(key, btn);
    presetBtnsWrap.append(btn);
  }
  const customIndicator = el(doc, 'button', undefined, '自定');
  customIndicator.type = 'button';
  customIndicator.dataset.lgPresetBtn = 'custom';
  customIndicator.title = '微调滑块后自动切换为自定参数';
  customIndicator.addEventListener('click', () => {
    liquidGlassStore.update(cur => ({ ...cur, preset: 'custom' }));
  });
  presetButtons.set('custom', customIndicator);
  presetBtnsWrap.append(customIndicator);
  presetGroup.append(presetRow, presetBtnsWrap);
  subcontrols.append(presetGroup);

  // 6. Readability Mode (fixed theme vs adaptive)
  const readGroup = el(doc, 'div', 'lg-settings__group');
  readGroup.append(el(doc, 'div', 'lg-settings__label-row', '图标与文字颜色'));
  const readWrap = el(doc, 'div', 'lg-settings__segmented');
  readWrap.setAttribute('role', 'group');
  readWrap.setAttribute('aria-label', '图标与文字颜色模式');
  const readBtns = new Map<LiquidGlassReadabilityMode, HTMLButtonElement>();
  for (const [mode, label] of [
    ['stable', '固定主题色'],
    ['adaptive', '随背景调整'],
  ] as const) {
    const btn = el(doc, 'button', undefined, label);
    btn.type = 'button';
    btn.dataset.lgReadabilityBtn = mode;
    btn.addEventListener('click', () => {
      liquidGlassStore.update(cur => ({ ...cur, readabilityMode: mode }));
    });
    readBtns.set(mode, btn);
    readWrap.append(btn);
  }
  readGroup.append(readWrap);
  subcontrols.append(readGroup);

  // 7. Motion & Popup Material Styles
  const makeSegmentedStyleRow = <T extends string>(
    title: string,
    ariaLabel: string,
    attrName: string,
    entries: readonly [T, string][],
    onSelect: (value: T) => void
  ) => {
    const group = el(doc, 'div', 'lg-settings__group');
    group.append(el(doc, 'div', 'lg-settings__label-row', title));
    const wrap = el(doc, 'div', 'lg-settings__segmented');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', ariaLabel);
    const map = new Map<T, HTMLButtonElement>();
    for (const [value, label] of entries) {
      const btn = el(doc, 'button', undefined, label);
      btn.type = 'button';
      btn.dataset[attrName] = value;
      btn.addEventListener('click', () => onSelect(value));
      map.set(value, btn);
      wrap.append(btn);
    }
    group.append(wrap);
    subcontrols.append(group);
    return map;
  };

  const dockMotionBtns = makeSegmentedStyleRow<GlassMotionStyle>(
    '工具栏动效风格',
    '工具栏动效风格',
    'lgDockMotionBtn',
    [['standard', '标准'], ['elastic', '弹性']],
    value => liquidGlassStore.update(cur => ({ ...cur, dockMotionStyle: value }))
  );

  const popupMotionBtns = makeSegmentedStyleRow<GlassMotionStyle>(
    '弹窗动效风格',
    '弹窗动效风格',
    'lgPopupMotionBtn',
    [['standard', '标准'], ['elastic', '弹性']],
    value => liquidGlassStore.update(cur => ({ ...cur, popupMotionStyle: value }))
  );

  const popupPaletteBtns = makeSegmentedStyleRow<GlassPopupPalette>(
    '弹窗底色',
    '弹窗底色风格',
    'lgPopupPaletteBtn',
    [['dock', '原有底色'], ['theme_frosted', '主题磨砂']],
    value => liquidGlassStore.update(cur => ({ ...cur, popupPalette: value }))
  );

  // Top bar blur & progressive blur switches
  const topBlurGrid = el(doc, 'div', 'lg-scene-grid');
  const makeCheckboxRow = (label: string, desc: string, controlId: string, onChange: (checked: boolean) => void) => {
    const row = el(doc, 'label', 'lg-settings__switch-row');
    const textWrap = el(doc, 'span');
    textWrap.append(doc.createTextNode(label), el(doc, 'small', undefined, desc));
    const input = el(doc, 'input');
    input.type = 'checkbox';
    input.setAttribute('aria-label', label);
    input.dataset.lgControl = controlId;
    input.addEventListener('change', () => onChange(input.checked));
    row.append(textWrap, input);
    return { row, input };
  };

  const headerBlurCtrl = makeCheckboxRow(
    '顶栏磨砂',
    '开启标题栏与浏览器标签栏背景模糊',
    'header-blur',
    checked => liquidGlassStore.update(cur => ({ ...cur, headerBlurEnabled: checked }))
  );
  const progressiveBlurCtrl = makeCheckboxRow(
    '顶栏渐进模糊',
    '顶栏底部自然羽化过渡至网页内容',
    'progressive-top-blur',
    checked => liquidGlassStore.update(cur => ({ ...cur, progressiveTopBlurEnabled: checked }))
  );
  topBlurGrid.append(headerBlurCtrl.row, progressiveBlurCtrl.row);
  subcontrols.append(topBlurGrid);

  // 8. 5 Scene Switches
  const sceneGroup = el(doc, 'div', 'lg-settings__group');
  sceneGroup.append(el(doc, 'div', 'lg-settings__label-row', '液态玻璃适用场景'));
  const sceneGrid = el(doc, 'div', 'lg-scene-grid');
  const sceneInputs = new Map<LiquidGlassSceneKey, HTMLInputElement>();
  for (const item of SCENE_ITEMS) {
    const ctrl = makeCheckboxRow(
      item.label,
      item.desc,
      `scene-${item.key}`,
      checked => liquidGlassStore.update(cur => ({
        ...cur,
        scenes: { ...cur.scenes, [item.key]: checked },
      }))
    );
    sceneInputs.set(item.key, ctrl.input);
    sceneGrid.append(ctrl.row);
  }
  sceneGroup.append(sceneGrid);
  subcontrols.append(sceneGroup);

  // 9. Collapsible Advanced Sliders (6 items + reset)
  const advancedDetails = el(doc, 'details', 'lg-advanced');
  const advancedSummary = el(doc, 'summary', undefined, '高级光学参数调节（6 项精细滑块）');
  const advancedBody = el(doc, 'div', 'lg-advanced__body');
  const advancedSliders = new Map<keyof LiquidGlassAdvanced, { input: HTMLInputElement; readout: HTMLSpanElement }>();
  for (const item of ADVANCED_SLIDERS) {
    const wrap = el(doc, 'div', 'lg-slider-wrap');
    const row = el(doc, 'div', 'lg-settings__label-row');
    const lbl = el(doc, 'label', undefined, item.label);
    const id = `lg-adv-${item.key}`;
    lbl.htmlFor = id;
    const readout = el(doc, 'span', 'lg-settings__value-pill', '0%');
    row.append(lbl, readout);
    const input = el(doc, 'input');
    input.type = 'range';
    input.id = id;
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.dataset.lgAdvanced = item.key;
    input.addEventListener('input', () => {
      const value = Number(input.value) / 100;
      liquidGlassStore.update(cur => updateLiquidGlassAdvanced(cur, { [item.key]: value }));
    });
    wrap.append(row, input);
    advancedBody.append(wrap);
    advancedSliders.set(item.key, { input, readout });
  }
  const resetAdvBtn = el(doc, 'button', undefined, '恢复默认参数');
  resetAdvBtn.type = 'button';
  resetAdvBtn.dataset.lgAction = 'reset-advanced';
  resetAdvBtn.addEventListener('click', () => {
    liquidGlassStore.update(cur => resetLiquidGlassAdvanced(cur));
    setStatus('已恢复当前预设默认光学参数。', 'success');
  });
  advancedBody.append(resetAdvBtn);
  advancedDetails.append(advancedSummary, advancedBody);
  subcontrols.append(advancedDetails);

  // 10. My Presets + JSON Export/Import
  const presetsGroup = el(doc, 'div', 'lg-settings__group');
  presetsGroup.append(el(doc, 'div', 'lg-settings__label-row', '我的液态玻璃预设与导入 / 导出'));
  const saveRow = el(doc, 'div', 'lg-preset-save-row');
  const presetNameInput = el(doc, 'input');
  presetNameInput.type = 'text';
  presetNameInput.maxLength = 40;
  presetNameInput.placeholder = '输入预设名称，例如：深夜冰透';
  presetNameInput.setAttribute('aria-label', '新预设名称');
  presetNameInput.dataset.lgControl = 'preset-name';
  const savePresetBtn = el(doc, 'button', 'btn-primary', '保存为预设');
  savePresetBtn.type = 'button';
  savePresetBtn.dataset.lgAction = 'save-preset';
  savePresetBtn.addEventListener('click', () => {
    try {
      const name = presetNameInput.value.trim();
      saveNamedPreset(name, liquidGlassStore.getSnapshot());
      presetNameInput.value = '';
      renderSavedPresets();
      setStatus(`已保存预设「${name}」。`, 'success');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '保存预设失败。', 'error');
    }
  });
  saveRow.append(presetNameInput, savePresetBtn);

  const savedList = el(doc, 'div', 'lg-saved-list');
  savedList.dataset.lgSavedList = 'true';

  const ioRow = el(doc, 'div', 'lg-io-row');
  const exportBtn = el(doc, 'button', undefined, '导出 JSON 配置');
  exportBtn.type = 'button';
  exportBtn.dataset.lgAction = 'export-json';
  exportBtn.addEventListener('click', () => {
    try {
      const payload = exportLiquidGlassJson(liquidGlassStore.getSnapshot(), loadSavedPresets());
      const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = doc.createElement('a');
      link.href = url;
      link.download = 'studypilot-liquid-glass-config.json';
      doc.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('已导出液态玻璃 JSON 配置文件。', 'success');
    } catch {
      setStatus('导出配置文件失败。', 'error');
    }
  });

  const importLabel = el(doc, 'label', 'lg-file-label');
  importLabel.append(doc.createTextNode('导入 JSON 配置'));
  const importInput = el(doc, 'input');
  importInput.type = 'file';
  importInput.accept = 'application/json,.json';
  importInput.setAttribute('aria-label', '导入液态玻璃 JSON 配置');
  importInput.dataset.lgControl = 'import-json';
  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;
    void file.text().then(text => {
      const imported = parseImportedLiquidGlassJson(text);
      liquidGlassStore.setSettings(imported.settings);
      if (imported.savedPresets && imported.savedPresets.length > 0) {
        mergeImportedSavedPresets(imported.savedPresets);
        renderSavedPresets();
      }
      setStatus('已成功校验并导入液态玻璃配置。', 'success');
    }).catch(error => {
      setStatus(error instanceof Error ? error.message : '导入失败：JSON 文件格式无效，当前配置未更改。', 'error');
    });
  });
  importLabel.append(importInput);
  ioRow.append(exportBtn, importLabel);

  const statusLine = el(doc, 'p', 'lg-status');
  statusLine.setAttribute('role', 'status');
  statusLine.setAttribute('aria-live', 'polite');
  statusLine.dataset.lgStatus = 'true';

  presetsGroup.append(saveRow, savedList, ioRow, statusLine);
  subcontrols.append(presetsGroup);
  section.append(subcontrols);

  function setStatus(message: string, tone: 'info' | 'success' | 'error' = 'info') {
    statusLine.textContent = message;
    statusLine.dataset.tone = tone;
  }

  function renderSavedPresets() {
    const items = loadSavedPresets();
    savedList.replaceChildren();
    if (items.length === 0) {
      savedList.append(el(doc, 'p', 'lg-settings__subtitle', '暂无已保存的个人预设。调节好效果后可命名保存，随时一键切换。'));
      return;
    }
    for (const item of items) {
      const row = el(doc, 'div', 'lg-saved-item');
      row.dataset.lgSavedPresetId = item.id;
      const meta = el(doc, 'div', 'lg-saved-item__meta');
      const tier = getProgressTier(item.settings.progress);
      meta.append(
        el(doc, 'span', 'lg-saved-item__name', item.name),
        el(doc, 'span', 'lg-saved-item__info', `${tier.label} · ${tier.percent}% · ${item.settings.enabled ? '已启用' : '已关闭'}`)
      );
      const actions = el(doc, 'div', 'lg-saved-item__actions');
      const applyBtn = el(doc, 'button', undefined, '应用');
      applyBtn.type = 'button';
      applyBtn.addEventListener('click', () => {
        liquidGlassStore.setSettings(item.settings);
        setStatus(`已恢复预设「${item.name}」。`, 'success');
      });
      const delBtn = el(doc, 'button', 'btn-danger', '删除');
      delBtn.type = 'button';
      delBtn.addEventListener('click', () => {
        deleteSavedPreset(item.id);
        renderSavedPresets();
        setStatus(`已删除预设「${item.name}」。`, 'info');
      });
      actions.append(applyBtn, delBtn);
      row.append(meta, actions);
      savedList.append(row);
    }
  }

  function syncThemeState() {
    const theme = currentTheme(doc);
    themeBadge.textContent = theme === 'light' ? '清透冰瓷（浅色）' : '深海曜石（暗色）';
    lightBtn.setAttribute('aria-pressed', String(theme === 'light'));
    darkBtn.setAttribute('aria-pressed', String(theme === 'dark'));
  }

  function syncUI(settings: LiquidGlassSettings) {
    const tier = getProgressTier(settings.progress);
    section.dataset.lgMasterOff = String(!settings.enabled);
    masterToggle.checked = settings.enabled;
    preview.dataset.backdrop = settings.previewBackdrop;
    preview.dataset.disabled = String(!settings.enabled);
    previewBadge.textContent = settings.enabled ? `${tier.label} · ${tier.percent}%` : `已关闭 · ${tier.percent}%`;
    progressSlider.value = String(tier.percent);
    progressPill.textContent = `${tier.label} · ${tier.percent}%`;

    const presetLabel = settings.preset === 'custom'
      ? '自定'
      : LIQUID_GLASS_PRESET_ANCHORS[settings.preset].label;
    presetStatusPill.textContent = presetLabel;

    for (const [id, btn] of backdropBtns) btn.setAttribute('aria-pressed', String(settings.previewBackdrop === id));
    for (const [key, btn] of presetButtons) btn.setAttribute('aria-pressed', String(settings.preset === key));
    for (const [mode, btn] of readBtns) btn.setAttribute('aria-pressed', String(settings.readabilityMode === mode));
    for (const [mode, btn] of dockMotionBtns) btn.setAttribute('aria-pressed', String(settings.dockMotionStyle === mode));
    for (const [mode, btn] of popupMotionBtns) btn.setAttribute('aria-pressed', String(settings.popupMotionStyle === mode));
    for (const [mode, btn] of popupPaletteBtns) btn.setAttribute('aria-pressed', String(settings.popupPalette === mode));

    headerBlurCtrl.input.checked = settings.headerBlurEnabled;
    progressiveBlurCtrl.input.checked = settings.progressiveTopBlurEnabled;

    for (const [key, input] of sceneInputs) input.checked = settings.scenes[key];
    for (const [key, ctrl] of advancedSliders) {
      const pct = Math.round(settings.advanced[key] * 100);
      ctrl.input.value = String(pct);
      ctrl.readout.textContent = `${pct}%`;
    }
    syncThemeState();
  }

  const unsubscribe = liquidGlassStore.subscribe(syncUI);
  const themeObserver = new MutationObserver(syncThemeState);
  if (doc.documentElement) {
    themeObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  renderSavedPresets();
  syncUI(liquidGlassStore.getSnapshot());

  return {
    section,
    dispose: () => {
      unsubscribe();
      themeObserver.disconnect();
    },
  };
}

/** Mounts the Liquid Glass settings section beside `.dock-settings`. */
export function installLiquidGlassSettingsUI(doc: Document = document): () => void {
  const existing = installations.get(doc);
  if (existing) return existing;

  let disposed = false;
  let currentCleanup: (() => void) | null = null;

  const attach = () => {
    if (disposed) return;
    const mounted = doc.getElementById(LIQUID_GLASS_SETTINGS_SECTION_ID);
    if (mounted?.isConnected) return;
    if (currentCleanup) {
      currentCleanup();
      currentCleanup = null;
    }
    const anchor = doc.querySelector('.dock-settings');
    if (anchor?.isConnected) {
      const created = createLiquidGlassSettingsSection(doc);
      currentCleanup = created.dispose;
      anchor.insertAdjacentElement('afterend', created.section);
    }
  };

  const observer = new MutationObserver(attach);
  if (doc.documentElement) {
    observer.observe(doc.documentElement, { childList: true, subtree: true });
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    currentCleanup?.();
    currentCleanup = null;
    doc.getElementById(LIQUID_GLASS_SETTINGS_SECTION_ID)?.remove();
    window.removeEventListener('pagehide', dispose);
    installations.delete(doc);
  };

  window.addEventListener('pagehide', dispose, { once: true });
  installations.set(doc, dispose);
  attach();
  return dispose;
}
