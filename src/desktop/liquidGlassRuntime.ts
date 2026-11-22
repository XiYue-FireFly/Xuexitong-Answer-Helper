import './liquidGlassTheme.css';
import {
  getProgressTier,
  liquidGlassStore,
  type LiquidGlassSettings,
} from './liquidGlassStore';
import { installLiquidGlassSettingsUI } from './liquidGlassSettingsUI';

const DOCK_PREFERENCES_KEY = 'studypilot_dock_ui_v1';
const runtimeInstallations = new WeakMap<Document, () => void>();

export function computeLiquidGlassCssVars(settings: LiquidGlassSettings): Record<string, string> {
  const { enabled, progress, advanced, dockMotionStyle, popupMotionStyle, headerBlurEnabled } = settings;
  const blurPx = enabled ? Math.round(8 + advanced.blurStrength * 28) : 0;
  const headerBlurPx = enabled && headerBlurEnabled
    ? Math.round(6 + advanced.blurStrength * Math.max(0.35, advanced.headerBlurExtent) * 26)
    : 0;
  const headerExtentPx = enabled && settings.progressiveTopBlurEnabled
    ? Math.round(8 + advanced.headerBlurExtent * 30)
    : 0;
  const dockBlurPx = enabled && settings.scenes.dock
    ? Math.round(10 + advanced.blurStrength * 24)
    : 0;
  const saturate = enabled ? (1.05 + advanced.saturationBoost * 0.95).toFixed(2) : '1.00';

  const surfaceAlphaDark = (0.76 + advanced.contentReadability * 0.20).toFixed(3);
  const surfaceAlphaLight = (0.50 + advanced.contentReadability * 0.40).toFixed(3);
  const cardAlphaDark = (0.56 + advanced.contentReadability * 0.30).toFixed(3);
  const cardAlphaLight = (0.58 + advanced.contentReadability * 0.34).toFixed(3);
  const chromeAlphaDark = (0.72 + advanced.contentReadability * 0.20).toFixed(3);
  const chromeAlphaLight = (0.56 + advanced.contentReadability * 0.36).toFixed(3);
  const dockAlphaDark = (0.38 + advanced.contentReadability * 0.38).toFixed(3);
  const dockAlphaLight = (0.52 + advanced.contentReadability * 0.36).toFixed(3);

  const prismOpacity = enabled ? (advanced.chromaticAberration * 0.85).toFixed(3) : '0';
  const refractionOpacity = enabled ? (advanced.refractionIntensity * 0.92).toFixed(3) : '0';
  const specularOpacity = enabled ? (0.22 + advanced.refractionIntensity * 0.65).toFixed(3) : '0.15';
  const borderAlphaDark = (0.14 + (enabled ? advanced.refractionIntensity * 0.24 : 0.04)).toFixed(3);
  const borderAlphaLight = (0.55 + (enabled ? advanced.refractionIntensity * 0.38 : 0.12)).toFixed(3);

  return {
    '--lg-progress': progress.toFixed(3),
    '--lg-blur-px': `${blurPx}px`,
    '--lg-header-blur-px': `${headerBlurPx}px`,
    '--lg-header-extent-px': `${headerExtentPx}px`,
    '--lg-dock-blur-px': `${dockBlurPx}px`,
    '--lg-saturate': saturate,
    '--lg-surface-alpha-dark': surfaceAlphaDark,
    '--lg-surface-alpha-light': surfaceAlphaLight,
    '--lg-card-alpha-dark': cardAlphaDark,
    '--lg-card-alpha-light': cardAlphaLight,
    '--lg-chrome-alpha-dark': chromeAlphaDark,
    '--lg-chrome-alpha-light': chromeAlphaLight,
    '--lg-dock-alpha-dark': dockAlphaDark,
    '--lg-dock-alpha-light': dockAlphaLight,
    '--lg-prism-opacity': prismOpacity,
    '--lg-refraction-opacity': refractionOpacity,
    '--lg-specular-opacity': specularOpacity,
    '--lg-border-alpha-dark': borderAlphaDark,
    '--lg-border-alpha-light': borderAlphaLight,
    '--lg-dock-timing': dockMotionStyle === 'elastic'
      ? 'cubic-bezier(0.22, 1.38, 0.36, 1)'
      : 'cubic-bezier(0.22, 0.8, 0.24, 1)',
    '--lg-dock-duration': dockMotionStyle === 'elastic' ? '460ms' : '300ms',
    '--lg-popup-timing': popupMotionStyle === 'elastic'
      ? 'cubic-bezier(0.22, 1.32, 0.36, 1)'
      : 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    '--lg-popup-duration': popupMotionStyle === 'elastic' ? '360ms' : '220ms',
  };
}

export function applyLiquidGlassToRoot(doc: Document, settings: LiquidGlassSettings): void {
  const root = doc.documentElement;
  if (!root) return;
  const tier = getProgressTier(settings.progress);
  const theme = root.dataset.theme === 'light'
    || doc.querySelector<HTMLElement>('.desktop-shell')?.dataset?.theme === 'light'
    ? 'light'
    : 'dark';

  root.dataset.lgReady = 'true';
  root.dataset.lgTheme = theme;
  root.dataset.lgEnabled = String(settings.enabled);
  root.dataset.lgPreset = settings.preset;
  root.dataset.lgTier = tier.tier;
  root.dataset.lgReadability = settings.readabilityMode;
  root.dataset.lgDockMotion = settings.dockMotionStyle;
  root.dataset.lgPopupMotion = settings.popupMotionStyle;
  root.dataset.lgPopupPalette = settings.popupPalette;
  root.dataset.lgHeaderBlur = String(settings.headerBlurEnabled);
  root.dataset.lgProgressiveTop = String(settings.progressiveTopBlurEnabled);
  root.dataset.lgSceneDock = String(settings.scenes.dock);
  root.dataset.lgSceneTopChrome = String(settings.scenes.topChrome);
  root.dataset.lgSceneSheets = String(settings.scenes.sheetsAndCards);
  root.dataset.lgScenePopups = String(settings.scenes.popupsAndMenus);
  root.dataset.lgSceneFooter = String(settings.scenes.footerBar);

  const vars = computeLiquidGlassCssVars(settings);
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
}

export function targetDockGlassQuality(settings: LiquidGlassSettings): 'ultra' | 'standard' {
  if (!settings.enabled || !settings.scenes.dock) return 'standard';
  if (settings.preset === 'classic_frosted') return 'standard';
  if (settings.advanced.refractionIntensity < 0.25 && settings.progress >= 0.72) return 'standard';
  return 'ultra';
}

export function syncDockGlassPreference(settings: LiquidGlassSettings, doc?: Document): 'ultra' | 'standard' {
  const targetGlass = targetDockGlassQuality(settings);
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const existingRaw = window.localStorage.getItem(DOCK_PREFERENCES_KEY);
      const parsed = existingRaw ? JSON.parse(existingRaw) : {};
      const currentGlass = parsed?.glass === 'standard' ? 'standard' : 'ultra';
      if (!existingRaw || currentGlass !== targetGlass) {
        const next = {
          edge: ['left', 'right', 'bottom', 'top'].includes(parsed?.edge) ? parsed.edge : 'bottom',
          glass: targetGlass,
          autoCollapse: parsed?.autoCollapse !== false,
        };
        window.localStorage.setItem(DOCK_PREFERENCES_KEY, JSON.stringify(next));
        if (doc?.querySelector('.desktop-shell')) {
          void import('../ui/dockPreferences')
            .then(mod => mod.updateDockPreferences({ glass: targetGlass }))
            .catch(() => undefined);
        }
      }
    }
  } catch {
    // Keep non-fatal if storage is restricted.
  }
  return targetGlass;
}

function isModalOverlayCandidate(element: HTMLElement): boolean {
  if (
    element.classList.contains('workbench-drag-shield')
    || element.classList.contains('mock-page-container')
    || element.classList.contains('desktop-dissolve')
    || element.classList.contains('browser-tab-context-menu')
    || element.classList.contains('desktop-dismiss')
  ) {
    return false;
  }

  const card = element.querySelector<HTMLElement>(':scope > .glass-panel');
  if (!card) return false;

  if (element.getAttribute('role') === 'dialog') return true;

  const inlinePos = element.style.position;
  const computedPos = inlinePos || (typeof getComputedStyle === 'function' ? getComputedStyle(element).position : '');
  if (computedPos !== 'fixed') return false;

  const rawZ = element.style.zIndex || (typeof getComputedStyle === 'function' ? getComputedStyle(element).zIndex : '');
  const zIndex = Number(rawZ);
  if (!Number.isFinite(zIndex) || zIndex < 900) return false;

  const inlineInset = element.style.inset;
  const coversByInset = inlineInset === '0px' || inlineInset === '0' || inlineInset === '0px 0px 0px 0px';
  const coversByEdges = element.style.top === '0px' && element.style.left === '0px'
    && element.style.right === '0px' && element.style.bottom === '0px';
  return coversByInset || coversByEdges;
}

/**
 * Ensures full-viewport React modals (startup "使用公告" and Settings "获取 API Key")
 * always expose `role="dialog"`, `aria-modal="true"`, and `data-native-modal="true"`
 * so Rust's `ui-layout.js` immediately reports `blocked: true` and renders the modal
 * above the guest WebView instead of clipping its center.
 */
export function enhanceModalOverlays(doc: Document): HTMLElement[] {
  const enhanced: HTMLElement[] = [];
  const candidates = new Set<HTMLElement>();

  doc.querySelectorAll<HTMLElement>('[role="dialog"], [style*="fixed"]').forEach(el => candidates.add(el));
  doc.querySelectorAll<HTMLElement>('.app-shell > div, .desktop-shell > div').forEach(el => candidates.add(el));

  for (const element of candidates) {
    if (!isModalOverlayCandidate(element)) continue;
    if (element.getAttribute('role') !== 'dialog') {
      element.setAttribute('role', 'dialog');
    }
    if (element.getAttribute('aria-modal') !== 'true') {
      element.setAttribute('aria-modal', 'true');
    }
    if (element.dataset.nativeModal !== 'true') {
      element.dataset.nativeModal = 'true';
    }
    if (element.dataset.lgModalOverlay !== 'true') {
      element.dataset.lgModalOverlay = 'true';
    }
    if (!element.getAttribute('aria-label') && !element.getAttribute('aria-labelledby')) {
      const heading = element.querySelector('h1, h2, h3, h4');
      const label = heading?.textContent?.trim();
      if (label) element.setAttribute('aria-label', label);
    }
    const card = element.querySelector<HTMLElement>(':scope > .glass-panel');
    if (card && card.dataset.lgModalCard !== 'true') {
      card.dataset.lgModalCard = 'true';
    }
    enhanced.push(element);
  }

  // Synchronize a data flag on any .desktop-sheet / .app-workspace containing a modal
  // so CSS reliably lifts the fixed modal out of sheet containment and restores layering on close.
  const sheets = doc.querySelectorAll<HTMLElement>('.desktop-sheet');
  let anySheetModal = false;
  for (const sheet of sheets) {
    const hasModal = Boolean(sheet.querySelector('[data-lg-modal-overlay="true"], [role="dialog"]'));
    if (hasModal) {
      anySheetModal = true;
      if (sheet.dataset.lgHasModal !== 'true') sheet.dataset.lgHasModal = 'true';
    } else if (sheet.dataset.lgHasModal !== undefined) {
      delete sheet.dataset.lgHasModal;
    }
  }
  const workspace = doc.querySelector<HTMLElement>('.app-workspace');
  if (workspace) {
    if (anySheetModal) {
      if (workspace.dataset.lgHasModal !== 'true') workspace.dataset.lgHasModal = 'true';
    } else if (workspace.dataset.lgHasModal !== undefined) {
      delete workspace.dataset.lgHasModal;
    }
  }

  return enhanced;
}

export function installLiquidGlassRuntime(doc: Document = document): () => void {
  const existing = runtimeInstallations.get(doc);
  if (existing) return existing;

  let disposed = false;
  let shellSynced = false;
  let lastAppliedJson = '';

  const applyCurrent = (syncDock: boolean) => {
    if (disposed) return;
    const settings = liquidGlassStore.getSnapshot();
    applyLiquidGlassToRoot(doc, settings);
    const serialized = JSON.stringify(settings);
    if (syncDock && serialized !== lastAppliedJson) {
      lastAppliedJson = serialized;
      syncDockGlassPreference(settings, doc);
    }
  };

  const handleShellAppearance = () => {
    if (shellSynced || disposed) return;
    if (doc.querySelector('.desktop-shell')) {
      shellSynced = true;
      // Re-read storage after Rust restoreImportedProfile() and React mount.
      liquidGlassStore.reloadFromStorage();
      applyCurrent(true);
    }
  };

  const unsubscribe = liquidGlassStore.subscribe(() => {
    applyCurrent(true);
  });

  const observer = new MutationObserver(records => {
    if (disposed) return;
    let needsModalScan = false;
    let needsThemeRefresh = false;

    for (const record of records) {
      if (record.type === 'childList' && (record.addedNodes.length > 0 || record.removedNodes.length > 0)) {
        needsModalScan = true;
      } else if (record.type === 'attributes' && record.attributeName === 'data-theme') {
        needsThemeRefresh = true;
      }
    }

    if (needsModalScan) {
      // Run synchronously so Rust ui-layout.js sees role="dialog" on the very first rAF.
      enhanceModalOverlays(doc);
      handleShellAppearance();
    }
    if (needsThemeRefresh) {
      applyCurrent(false);
    }
  });

  if (doc.documentElement) {
    observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    const overlays = doc.querySelectorAll<HTMLElement>('[data-lg-modal-overlay="true"]');
    const topOverlay = overlays.item(overlays.length - 1);
    if (!topOverlay) return;
    const closeBtn = topOverlay.querySelector<HTMLButtonElement>('button[title*="关闭"]')
      || Array.from(topOverlay.querySelectorAll<HTMLButtonElement>('button')).find(
        btn => /我知道了|关闭/.test(btn.textContent || '')
      );
    if (closeBtn) {
      event.preventDefault();
      closeBtn.click();
    }
  };

  const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  win?.addEventListener('keydown', onKeyDown);

  const disposeSettingsUI = installLiquidGlassSettingsUI(doc);

  // Initial synchronous pass
  applyCurrent(false);
  enhanceModalOverlays(doc);
  handleShellAppearance();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    unsubscribe();
    disposeSettingsUI();
    win?.removeEventListener('keydown', onKeyDown);
    win?.removeEventListener('pagehide', dispose);
    runtimeInstallations.delete(doc);
  };

  win?.addEventListener('pagehide', dispose, { once: true });
  runtimeInstallations.set(doc, dispose);
  return dispose;
}

if (typeof document !== 'undefined' && document.documentElement) {
  installLiquidGlassRuntime(document);
}
