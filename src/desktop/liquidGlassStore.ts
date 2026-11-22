export type LiquidGlassPreset = 'readable' | 'balanced' | 'prism' | 'classic_frosted' | 'custom';
export type LiquidGlassReadabilityMode = 'stable' | 'adaptive';
export type GlassMotionStyle = 'standard' | 'elastic';
export type GlassPopupPalette = 'dock' | 'theme_frosted';
export type LiquidGlassSceneKey = 'dock' | 'topChrome' | 'sheetsAndCards' | 'popupsAndMenus' | 'footerBar';
export type PreviewBackdropId = 'aurora' | 'light-grid' | 'dark-nebula' | 'warm-sunset';
export type LiquidGlassProgressTier = 'clear' | 'balanced' | 'frosted';

export interface LiquidGlassAdvanced {
  blurStrength: number;
  headerBlurExtent: number;
  contentReadability: number;
  chromaticAberration: number;
  refractionIntensity: number;
  saturationBoost: number;
}

export interface LiquidGlassSettings {
  version: 1;
  enabled: boolean;
  progress: number;
  preset: LiquidGlassPreset;
  readabilityMode: LiquidGlassReadabilityMode;
  dockMotionStyle: GlassMotionStyle;
  popupMotionStyle: GlassMotionStyle;
  popupPalette: GlassPopupPalette;
  headerBlurEnabled: boolean;
  progressiveTopBlurEnabled: boolean;
  scenes: Record<LiquidGlassSceneKey, boolean>;
  advanced: LiquidGlassAdvanced;
  previewBackdrop: PreviewBackdropId;
}

export interface SavedLiquidGlassPreset {
  id: string;
  name: string;
  createdAt: number;
  settings: LiquidGlassSettings;
}

export interface LiquidGlassExportEnvelope {
  schema: 'studypilot-liquid-glass-v1';
  exportedAt: string;
  settings: LiquidGlassSettings;
  savedPresets?: SavedLiquidGlassPreset[];
}

export const LIQUID_GLASS_STORAGE_KEY = 'studypilot_liquid_glass_v1';
export const LIQUID_GLASS_PRESETS_STORAGE_KEY = 'studypilot_liquid_glass_presets_v1';
export const MAX_SAVED_PRESETS = 24;
export const MAX_IMPORT_JSON_BYTES = 256 * 1024;

export const LIQUID_GLASS_SCENE_KEYS: readonly LiquidGlassSceneKey[] = [
  'dock',
  'topChrome',
  'sheetsAndCards',
  'popupsAndMenus',
  'footerBar',
] as const;

export const LIQUID_GLASS_ADVANCED_KEYS: readonly (keyof LiquidGlassAdvanced)[] = [
  'blurStrength',
  'headerBlurExtent',
  'contentReadability',
  'chromaticAberration',
  'refractionIntensity',
  'saturationBoost',
] as const;

const VALID_PRESETS: readonly LiquidGlassPreset[] = ['readable', 'balanced', 'prism', 'classic_frosted', 'custom'];
const VALID_READABILITY: readonly LiquidGlassReadabilityMode[] = ['stable', 'adaptive'];
const VALID_MOTION: readonly GlassMotionStyle[] = ['standard', 'elastic'];
const VALID_POPUP_PALETTE: readonly GlassPopupPalette[] = ['dock', 'theme_frosted'];
const VALID_BACKDROPS: readonly PreviewBackdropId[] = ['aurora', 'light-grid', 'dark-nebula', 'warm-sunset'];

export const LIQUID_GLASS_PRESET_ANCHORS: Record<Exclude<LiquidGlassPreset, 'custom'>, {
  label: string;
  description: string;
  progress: number;
  advanced: LiquidGlassAdvanced;
}> = {
  readable: {
    label: '清晰',
    description: '高通透轻折射，强化文字清晰度',
    progress: 0.22,
    advanced: {
      blurStrength: 0.42,
      headerBlurExtent: 0.55,
      contentReadability: 0.72,
      chromaticAberration: 0.35,
      refractionIntensity: 0.55,
      saturationBoost: 0.52,
    },
  },
  balanced: {
    label: '均衡',
    description: '通透与磨砂平衡，推荐日常使用',
    progress: 0.50,
    advanced: {
      blurStrength: 0.60,
      headerBlurExtent: 0.65,
      contentReadability: 0.62,
      chromaticAberration: 0.56,
      refractionIntensity: 0.65,
      saturationBoost: 0.62,
    },
  },
  prism: {
    label: '棱镜',
    description: '强化边缘色散彩光与液体折射高光',
    progress: 0.38,
    advanced: {
      blurStrength: 0.52,
      headerBlurExtent: 0.72,
      contentReadability: 0.58,
      chromaticAberration: 0.92,
      refractionIntensity: 0.92,
      saturationBoost: 0.85,
    },
  },
  classic_frosted: {
    label: '经典磨砂',
    description: '柔和雾面磨砂，关闭色散与折射畸变',
    progress: 0.85,
    advanced: {
      blurStrength: 0.88,
      headerBlurExtent: 0.80,
      contentReadability: 0.82,
      chromaticAberration: 0.0,
      refractionIntensity: 0.0,
      saturationBoost: 0.35,
    },
  },
};

const PROGRESS_CLEAR_ANCHOR: LiquidGlassAdvanced = {
  blurStrength: 0.24,
  headerBlurExtent: 0.45,
  contentReadability: 0.42,
  chromaticAberration: 0.78,
  refractionIntensity: 0.86,
  saturationBoost: 0.76,
};

const PROGRESS_BALANCED_ANCHOR: LiquidGlassAdvanced = {
  ...LIQUID_GLASS_PRESET_ANCHORS.balanced.advanced,
};

const PROGRESS_FROSTED_ANCHOR: LiquidGlassAdvanced = {
  blurStrength: 0.94,
  headerBlurExtent: 0.86,
  contentReadability: 0.88,
  chromaticAberration: 0.08,
  refractionIntensity: 0.12,
  saturationBoost: 0.34,
};

export function createDefaultLiquidGlassSettings(): LiquidGlassSettings {
  return {
    version: 1,
    enabled: true,
    progress: LIQUID_GLASS_PRESET_ANCHORS.balanced.progress,
    preset: 'balanced',
    readabilityMode: 'adaptive',
    dockMotionStyle: 'elastic',
    popupMotionStyle: 'elastic',
    popupPalette: 'dock',
    headerBlurEnabled: true,
    progressiveTopBlurEnabled: true,
    scenes: {
      dock: true,
      topChrome: true,
      sheetsAndCards: true,
      popupsAndMenus: true,
      footerBar: true,
    },
    advanced: { ...LIQUID_GLASS_PRESET_ANCHORS.balanced.advanced },
    previewBackdrop: 'aurora',
  };
}

export const DEFAULT_LIQUID_GLASS_SETTINGS: Readonly<LiquidGlassSettings> = createDefaultLiquidGlassSettings();

export function clamp01(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.round(Math.max(0, Math.min(1, num)) * 1000) / 1000;
}

function lerp(start: number, end: number, t: number): number {
  return Math.round((start + (end - start) * t) * 1000) / 1000;
}

export function interpolateLiquidGlassFromProgress(progress: number): LiquidGlassAdvanced {
  const p = clamp01(progress, 0.5);
  if (p <= 0.5) {
    const t = p / 0.5;
    return {
      blurStrength: lerp(PROGRESS_CLEAR_ANCHOR.blurStrength, PROGRESS_BALANCED_ANCHOR.blurStrength, t),
      headerBlurExtent: lerp(PROGRESS_CLEAR_ANCHOR.headerBlurExtent, PROGRESS_BALANCED_ANCHOR.headerBlurExtent, t),
      contentReadability: lerp(PROGRESS_CLEAR_ANCHOR.contentReadability, PROGRESS_BALANCED_ANCHOR.contentReadability, t),
      chromaticAberration: lerp(PROGRESS_CLEAR_ANCHOR.chromaticAberration, PROGRESS_BALANCED_ANCHOR.chromaticAberration, t),
      refractionIntensity: lerp(PROGRESS_CLEAR_ANCHOR.refractionIntensity, PROGRESS_BALANCED_ANCHOR.refractionIntensity, t),
      saturationBoost: lerp(PROGRESS_CLEAR_ANCHOR.saturationBoost, PROGRESS_BALANCED_ANCHOR.saturationBoost, t),
    };
  }
  const t = (p - 0.5) / 0.5;
  return {
    blurStrength: lerp(PROGRESS_BALANCED_ANCHOR.blurStrength, PROGRESS_FROSTED_ANCHOR.blurStrength, t),
    headerBlurExtent: lerp(PROGRESS_BALANCED_ANCHOR.headerBlurExtent, PROGRESS_FROSTED_ANCHOR.headerBlurExtent, t),
    contentReadability: lerp(PROGRESS_BALANCED_ANCHOR.contentReadability, PROGRESS_FROSTED_ANCHOR.contentReadability, t),
    chromaticAberration: lerp(PROGRESS_BALANCED_ANCHOR.chromaticAberration, PROGRESS_FROSTED_ANCHOR.chromaticAberration, t),
    refractionIntensity: lerp(PROGRESS_BALANCED_ANCHOR.refractionIntensity, PROGRESS_FROSTED_ANCHOR.refractionIntensity, t),
    saturationBoost: lerp(PROGRESS_BALANCED_ANCHOR.saturationBoost, PROGRESS_FROSTED_ANCHOR.saturationBoost, t),
  };
}

export function getProgressTier(progress: number): {
  tier: LiquidGlassProgressTier;
  label: string;
  percent: number;
} {
  const p = clamp01(progress, 0.5);
  const percent = Math.round(p * 100);
  if (p < 0.34) return { tier: 'clear', label: '通透', percent };
  if (p < 0.68) return { tier: 'balanced', label: '平衡', percent };
  return { tier: 'frosted', label: '磨砂', percent };
}

export function detectMatchingPreset(progress: number, advanced: LiquidGlassAdvanced): LiquidGlassPreset {
  const epsilon = 0.015;
  for (const preset of ['readable', 'balanced', 'prism', 'classic_frosted'] as const) {
    const anchor = LIQUID_GLASS_PRESET_ANCHORS[preset];
    if (Math.abs(progress - anchor.progress) > epsilon) continue;
    const allMatch = LIQUID_GLASS_ADVANCED_KEYS.every(
      key => Math.abs(advanced[key] - anchor.advanced[key]) <= epsilon
    );
    if (allMatch) return preset;
  }
  return 'custom';
}

export function sanitizeLiquidGlassSettings(raw: unknown): LiquidGlassSettings {
  const defaults = createDefaultLiquidGlassSettings();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  const candidate = raw as Record<string, unknown>;
  const preset = VALID_PRESETS.includes(candidate.preset as LiquidGlassPreset)
    ? (candidate.preset as LiquidGlassPreset)
    : defaults.preset;
  const progress = clamp01(candidate.progress, defaults.progress);
  const rawScenes = (candidate.scenes && typeof candidate.scenes === 'object' && !Array.isArray(candidate.scenes))
    ? (candidate.scenes as Record<string, unknown>)
    : {};
  const scenes: Record<LiquidGlassSceneKey, boolean> = {
    dock: typeof rawScenes.dock === 'boolean' ? rawScenes.dock : defaults.scenes.dock,
    topChrome: typeof rawScenes.topChrome === 'boolean' ? rawScenes.topChrome : defaults.scenes.topChrome,
    sheetsAndCards: typeof rawScenes.sheetsAndCards === 'boolean' ? rawScenes.sheetsAndCards : defaults.scenes.sheetsAndCards,
    popupsAndMenus: typeof rawScenes.popupsAndMenus === 'boolean' ? rawScenes.popupsAndMenus : defaults.scenes.popupsAndMenus,
    footerBar: typeof rawScenes.footerBar === 'boolean' ? rawScenes.footerBar : defaults.scenes.footerBar,
  };
  const fallbackAdvanced = preset !== 'custom'
    ? LIQUID_GLASS_PRESET_ANCHORS[preset].advanced
    : interpolateLiquidGlassFromProgress(progress);
  const rawAdvanced = (candidate.advanced && typeof candidate.advanced === 'object' && !Array.isArray(candidate.advanced))
    ? (candidate.advanced as Record<string, unknown>)
    : {};
  const advanced: LiquidGlassAdvanced = {
    blurStrength: clamp01(rawAdvanced.blurStrength, fallbackAdvanced.blurStrength),
    headerBlurExtent: clamp01(rawAdvanced.headerBlurExtent, fallbackAdvanced.headerBlurExtent),
    contentReadability: clamp01(rawAdvanced.contentReadability, fallbackAdvanced.contentReadability),
    chromaticAberration: clamp01(rawAdvanced.chromaticAberration, fallbackAdvanced.chromaticAberration),
    refractionIntensity: clamp01(rawAdvanced.refractionIntensity, fallbackAdvanced.refractionIntensity),
    saturationBoost: clamp01(rawAdvanced.saturationBoost, fallbackAdvanced.saturationBoost),
  };
  return {
    version: 1,
    enabled: typeof candidate.enabled === 'boolean' ? candidate.enabled : defaults.enabled,
    progress,
    preset,
    readabilityMode: VALID_READABILITY.includes(candidate.readabilityMode as LiquidGlassReadabilityMode)
      ? (candidate.readabilityMode as LiquidGlassReadabilityMode)
      : defaults.readabilityMode,
    dockMotionStyle: VALID_MOTION.includes(candidate.dockMotionStyle as GlassMotionStyle)
      ? (candidate.dockMotionStyle as GlassMotionStyle)
      : defaults.dockMotionStyle,
    popupMotionStyle: VALID_MOTION.includes(candidate.popupMotionStyle as GlassMotionStyle)
      ? (candidate.popupMotionStyle as GlassMotionStyle)
      : defaults.popupMotionStyle,
    popupPalette: VALID_POPUP_PALETTE.includes(candidate.popupPalette as GlassPopupPalette)
      ? (candidate.popupPalette as GlassPopupPalette)
      : defaults.popupPalette,
    headerBlurEnabled: typeof candidate.headerBlurEnabled === 'boolean'
      ? candidate.headerBlurEnabled
      : defaults.headerBlurEnabled,
    progressiveTopBlurEnabled: typeof candidate.progressiveTopBlurEnabled === 'boolean'
      ? candidate.progressiveTopBlurEnabled
      : defaults.progressiveTopBlurEnabled,
    scenes,
    advanced,
    previewBackdrop: VALID_BACKDROPS.includes(candidate.previewBackdrop as PreviewBackdropId)
      ? (candidate.previewBackdrop as PreviewBackdropId)
      : defaults.previewBackdrop,
  };
}

export function applyLiquidGlassPreset(
  current: LiquidGlassSettings,
  preset: Exclude<LiquidGlassPreset, 'custom'>
): LiquidGlassSettings {
  const anchor = LIQUID_GLASS_PRESET_ANCHORS[preset];
  return {
    ...current,
    preset,
    progress: anchor.progress,
    advanced: { ...anchor.advanced },
  };
}

export function updateLiquidGlassProgress(current: LiquidGlassSettings, progress: number): LiquidGlassSettings {
  const nextProgress = clamp01(progress, current.progress);
  const nextAdvanced = interpolateLiquidGlassFromProgress(nextProgress);
  return {
    ...current,
    progress: nextProgress,
    advanced: nextAdvanced,
    preset: detectMatchingPreset(nextProgress, nextAdvanced),
  };
}

export function updateLiquidGlassAdvanced(
  current: LiquidGlassSettings,
  patch: Partial<LiquidGlassAdvanced>
): LiquidGlassSettings {
  const nextAdvanced: LiquidGlassAdvanced = {
    blurStrength: patch.blurStrength !== undefined ? clamp01(patch.blurStrength, current.advanced.blurStrength) : current.advanced.blurStrength,
    headerBlurExtent: patch.headerBlurExtent !== undefined ? clamp01(patch.headerBlurExtent, current.advanced.headerBlurExtent) : current.advanced.headerBlurExtent,
    contentReadability: patch.contentReadability !== undefined ? clamp01(patch.contentReadability, current.advanced.contentReadability) : current.advanced.contentReadability,
    chromaticAberration: patch.chromaticAberration !== undefined ? clamp01(patch.chromaticAberration, current.advanced.chromaticAberration) : current.advanced.chromaticAberration,
    refractionIntensity: patch.refractionIntensity !== undefined ? clamp01(patch.refractionIntensity, current.advanced.refractionIntensity) : current.advanced.refractionIntensity,
    saturationBoost: patch.saturationBoost !== undefined ? clamp01(patch.saturationBoost, current.advanced.saturationBoost) : current.advanced.saturationBoost,
  };
  return {
    ...current,
    advanced: nextAdvanced,
    preset: detectMatchingPreset(current.progress, nextAdvanced),
  };
}

export function resetLiquidGlassAdvanced(current: LiquidGlassSettings): LiquidGlassSettings {
  const targetPreset = current.preset === 'custom' ? 'balanced' : current.preset;
  return applyLiquidGlassPreset(current, targetPreset);
}

function defaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadLiquidGlassSettings(storage: Storage | null = defaultStorage()): LiquidGlassSettings {
  if (!storage) return createDefaultLiquidGlassSettings();
  try {
    const raw = storage.getItem(LIQUID_GLASS_STORAGE_KEY);
    if (!raw) return createDefaultLiquidGlassSettings();
    return sanitizeLiquidGlassSettings(JSON.parse(raw));
  } catch {
    return createDefaultLiquidGlassSettings();
  }
}

export function saveLiquidGlassSettings(
  settings: LiquidGlassSettings,
  storage: Storage | null = defaultStorage()
): LiquidGlassSettings {
  const sanitized = sanitizeLiquidGlassSettings(settings);
  if (storage) {
    try {
      storage.setItem(LIQUID_GLASS_STORAGE_KEY, JSON.stringify(sanitized));
    } catch {
      // Storage quota or private mode: keep active in memory without crashing UI.
    }
  }
  return sanitized;
}

function sanitizeSavedPreset(raw: unknown): SavedLiquidGlassPreset | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 40) : '';
  if (!name) return null;
  const id = typeof entry.id === 'string' && entry.id.trim()
    ? entry.id.trim().slice(0, 64)
    : `lg_preset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const createdAt = typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
    ? entry.createdAt
    : Date.now();
  return {
    id,
    name,
    createdAt,
    settings: sanitizeLiquidGlassSettings(entry.settings),
  };
}

export function loadSavedPresets(storage: Storage | null = defaultStorage()): SavedLiquidGlassPreset[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(LIQUID_GLASS_PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(sanitizeSavedPreset)
      .filter((item): item is SavedLiquidGlassPreset => item !== null)
      .slice(0, MAX_SAVED_PRESETS);
  } catch {
    return [];
  }
}

function writeSavedPresets(presets: SavedLiquidGlassPreset[], storage: Storage | null = defaultStorage()): SavedLiquidGlassPreset[] {
  const trimmed = presets.slice(0, MAX_SAVED_PRESETS);
  if (storage) {
    try {
      storage.setItem(LIQUID_GLASS_PRESETS_STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      // Ignore quota failures.
    }
  }
  return trimmed;
}

export function saveNamedPreset(
  rawName: string,
  settings: LiquidGlassSettings,
  storage: Storage | null = defaultStorage()
): SavedLiquidGlassPreset[] {
  const name = rawName.trim().slice(0, 40);
  if (!name) throw new Error('请输入预设名称。');
  const existing = loadSavedPresets(storage);
  const sanitizedSettings = sanitizeLiquidGlassSettings(settings);
  const matchIndex = existing.findIndex(item => item.name === name);
  const entry: SavedLiquidGlassPreset = {
    id: matchIndex >= 0
      ? existing[matchIndex].id
      : `lg_preset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    createdAt: Date.now(),
    settings: sanitizedSettings,
  };
  const next = matchIndex >= 0
    ? [entry, ...existing.filter((_, idx) => idx !== matchIndex)]
    : [entry, ...existing];
  return writeSavedPresets(next, storage);
}

export function deleteSavedPreset(
  id: string,
  storage: Storage | null = defaultStorage()
): SavedLiquidGlassPreset[] {
  const existing = loadSavedPresets(storage);
  return writeSavedPresets(existing.filter(item => item.id !== id), storage);
}

export function exportLiquidGlassJson(
  settings: LiquidGlassSettings,
  savedPresets: SavedLiquidGlassPreset[] = []
): string {
  const envelope: LiquidGlassExportEnvelope = {
    schema: 'studypilot-liquid-glass-v1',
    exportedAt: new Date().toISOString(),
    settings: sanitizeLiquidGlassSettings(settings),
    ...(savedPresets.length > 0 ? { savedPresets: savedPresets.slice(0, MAX_SAVED_PRESETS) } : {}),
  };
  return JSON.stringify(envelope, null, 2);
}

function assertStrictSettingsPayload(raw: unknown): LiquidGlassSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('液态玻璃配置格式无效：缺少配置对象。');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error('液态玻璃配置版本不受支持（需要 version = 1）。');
  }
  if (typeof obj.enabled !== 'boolean') {
    throw new Error('液态玻璃配置无效：enabled 必须为布尔值。');
  }
  if (typeof obj.progress !== 'number' || !Number.isFinite(obj.progress) || obj.progress < 0 || obj.progress > 1) {
    throw new Error('液态玻璃配置无效：progress 必须为 0 到 1 之间的数值。');
  }
  if (!VALID_PRESETS.includes(obj.preset as LiquidGlassPreset)) {
    throw new Error('液态玻璃配置无效：preset 值不受支持。');
  }
  if (obj.readabilityMode !== undefined && !VALID_READABILITY.includes(obj.readabilityMode as LiquidGlassReadabilityMode)) {
    throw new Error('液态玻璃配置无效：readabilityMode 值不受支持。');
  }
  if (obj.dockMotionStyle !== undefined && !VALID_MOTION.includes(obj.dockMotionStyle as GlassMotionStyle)) {
    throw new Error('液态玻璃配置无效：dockMotionStyle 值不受支持。');
  }
  if (obj.popupMotionStyle !== undefined && !VALID_MOTION.includes(obj.popupMotionStyle as GlassMotionStyle)) {
    throw new Error('液态玻璃配置无效：popupMotionStyle 值不受支持。');
  }
  if (obj.popupPalette !== undefined && !VALID_POPUP_PALETTE.includes(obj.popupPalette as GlassPopupPalette)) {
    throw new Error('液态玻璃配置无效：popupPalette 值不受支持。');
  }
  if (obj.scenes !== undefined) {
    if (!obj.scenes || typeof obj.scenes !== 'object' || Array.isArray(obj.scenes)) {
      throw new Error('液态玻璃配置无效：scenes 必须为对象。');
    }
    for (const [k, v] of Object.entries(obj.scenes as Record<string, unknown>)) {
      if (!LIQUID_GLASS_SCENE_KEYS.includes(k as LiquidGlassSceneKey) || typeof v !== 'boolean') {
        throw new Error(`液态玻璃配置无效：场景开关 ${k} 格式错误。`);
      }
    }
  }
  if (obj.advanced !== undefined) {
    if (!obj.advanced || typeof obj.advanced !== 'object' || Array.isArray(obj.advanced)) {
      throw new Error('液态玻璃配置无效：advanced 必须为对象。');
    }
    for (const [k, v] of Object.entries(obj.advanced as Record<string, unknown>)) {
      if (!LIQUID_GLASS_ADVANCED_KEYS.includes(k as keyof LiquidGlassAdvanced) || typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
        throw new Error(`液态玻璃配置无效：高级参数 ${k} 超出 0~1 范围。`);
      }
    }
  }
  return sanitizeLiquidGlassSettings(obj);
}

export function parseImportedLiquidGlassJson(rawText: string): {
  settings: LiquidGlassSettings;
  savedPresets?: SavedLiquidGlassPreset[];
} {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw new Error('导入文件为空。');
  }
  if (rawText.length > MAX_IMPORT_JSON_BYTES) {
    throw new Error('导入文件体积过大（最大支持 256 KB）。');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('JSON 格式解析失败，请检查文件内容是否完整。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('导入文件内容必须为 JSON 对象。');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schema !== undefined) {
    if (obj.schema !== 'studypilot-liquid-glass-v1') {
      throw new Error('导入文件的 schema 标识不匹配。');
    }
    const settings = assertStrictSettingsPayload(obj.settings);
    let savedPresets: SavedLiquidGlassPreset[] | undefined;
    if (obj.savedPresets !== undefined) {
      if (!Array.isArray(obj.savedPresets)) {
        throw new Error('导入文件的 savedPresets 必须为数组。');
      }
      savedPresets = [];
      for (const item of obj.savedPresets.slice(0, MAX_SAVED_PRESETS)) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new Error('导入文件中包含格式错误的已保存预设。');
        }
        const entry = item as Record<string, unknown>;
        const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 40) : '';
        if (!name) throw new Error('导入文件中存在无名称的预设项。');
        savedPresets.push({
          id: typeof entry.id === 'string' && entry.id.trim()
            ? entry.id.trim().slice(0, 64)
            : `lg_preset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
          name,
          createdAt: typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
          settings: assertStrictSettingsPayload(entry.settings),
        });
      }
    }
    return { settings, savedPresets };
  }
  return { settings: assertStrictSettingsPayload(obj) };
}

export function mergeImportedSavedPresets(
  incoming: SavedLiquidGlassPreset[],
  storage: Storage | null = defaultStorage()
): SavedLiquidGlassPreset[] {
  const existing = loadSavedPresets(storage);
  const byName = new Map<string, SavedLiquidGlassPreset>();
  for (const item of existing) byName.set(item.name, item);
  for (const item of incoming) byName.set(item.name, item);
  return writeSavedPresets([...byName.values()].sort((a, b) => b.createdAt - a.createdAt), storage);
}

type Listener = (settings: LiquidGlassSettings) => void;

class LiquidGlassStore {
  private current: LiquidGlassSettings = loadLiquidGlassSettings();
  private listeners = new Set<Listener>();
  private storageBound = false;

  private ensureStorageListener() {
    if (this.storageBound || typeof window === 'undefined') return;
    this.storageBound = true;
    window.addEventListener('storage', event => {
      if (event.key === LIQUID_GLASS_STORAGE_KEY || event.key === null) {
        this.reloadFromStorage();
      }
    });
  }

  getSnapshot(): LiquidGlassSettings {
    this.ensureStorageListener();
    return this.current;
  }

  reloadFromStorage(): LiquidGlassSettings {
    const next = loadLiquidGlassSettings();
    this.current = next;
    this.notify();
    return next;
  }

  setSettings(next: LiquidGlassSettings): LiquidGlassSettings {
    this.ensureStorageListener();
    this.current = saveLiquidGlassSettings(next);
    this.notify();
    return this.current;
  }

  update(updater: (current: LiquidGlassSettings) => LiquidGlassSettings): LiquidGlassSettings {
    return this.setSettings(updater(this.getSnapshot()));
  }

  subscribe(listener: Listener): () => void {
    this.ensureStorageListener();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    for (const listener of [...this.listeners]) {
      listener(this.current);
    }
  }
}

export const liquidGlassStore = new LiquidGlassStore();
