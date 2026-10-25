import type { PlatformAPI } from './types';
import { createElectronBridge } from './electronBridge';
import { createCapacitorBridge } from './capacitorBridge';

/** Detect runtime platform */
export function detectPlatform(): 'electron' | 'android' | 'web' {
  if (typeof window !== 'undefined') {
    if ((window as any).electronAPI) return 'electron';
    if ((window as any).Capacitor?.getPlatform?.() === 'android') return 'android';
  }
  return 'web';
}

let _bridge: PlatformAPI | null = null;

export function getPlatformAPI(): PlatformAPI {
  if (_bridge) return _bridge;
  const platform = detectPlatform();
  if (platform === 'electron') {
    _bridge = createElectronBridge();
  } else {
    // android or dev-mode web preview — use the capacitor bridge
    _bridge = createCapacitorBridge();
  }
  return _bridge;
}
