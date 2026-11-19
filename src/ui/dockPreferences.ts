import { useSyncExternalStore } from 'react';

export type DockEdge = 'left' | 'right' | 'bottom' | 'top';
export type DockPreferences = { edge: DockEdge; glass: 'ultra' | 'standard'; autoCollapse: boolean };
const key = 'studypilot_dock_ui_v1';
const defaults: DockPreferences = { edge: 'bottom', glass: 'ultra', autoCollapse: true };
const listeners = new Set<() => void>();
function read(): DockPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return { edge: ['left', 'right', 'bottom', 'top'].includes(value.edge) ? value.edge : 'bottom',
      glass: value.glass === 'standard' ? 'standard' : 'ultra', autoCollapse: value.autoCollapse !== false };
  } catch { return defaults; }
}
let current = read();
export function updateDockPreferences(patch: Partial<DockPreferences>) {
  current = { ...current, ...patch };
  try { localStorage.setItem(key, JSON.stringify(current)); } catch { /* Still usable for this session. */ }
  listeners.forEach(listener => listener());
}
window.addEventListener('storage', event => {
  if (event.key === key || event.key === null) { current = read(); listeners.forEach(listener => listener()); }
});
export function useDockPreferences() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current);
}
