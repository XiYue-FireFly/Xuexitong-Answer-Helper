export type DockState = { collapsed: boolean; running: boolean; travel: number };
export type DockEvent = { type: 'scroll'; y: number; delta: number; panelOpen: boolean }
  | { type: 'running'; value: boolean } | { type: 'expand' };
export const initialDockState: DockState = { collapsed: false, running: false, travel: 0 };
export function dockReducer(state: DockState, event: DockEvent): DockState {
  if (event.type === 'running') return state.running === event.value ? state
    : { collapsed: event.value, running: event.value, travel: 0 };
  if (event.type === 'expand') return { ...state, collapsed: false, travel: 0 };
  if (state.running || event.panelOpen || !Number.isFinite(event.y) || !Number.isFinite(event.delta)) return state;
  if (event.y <= 8) return state.collapsed || state.travel ? { ...state, collapsed: false, travel: 0 } : state;
  const travel = event.delta > 0 ? state.travel + Math.min(80, event.delta) : 0;
  return { ...state, travel, collapsed: state.collapsed || (event.y > 48 && travel >= 28) };
}

export function dockBounds(edge: 'left' | 'right' | 'top' | 'bottom', collapsed: boolean,
  count: number, area: { x: number; y: number; width: number; height: number }) {
  const margin = 14, cross = 62;
  const width = Math.max(0, area.width - margin * 2), height = Math.max(0, area.height - margin * 2);
  const vertical = edge === 'left' || edge === 'right';
  const length = Math.min(count * 86 + 10, vertical ? height : width);
  const w = Math.min(width, vertical || collapsed ? cross : length);
  const h = Math.min(height, !vertical || collapsed ? cross : length);
  const x = edge === 'right' ? area.x + area.width - margin - w
    : vertical || collapsed ? area.x + margin : area.x + (area.width - w) / 2;
  const y = edge === 'top' ? area.y + margin : !vertical || collapsed ? area.y + area.height - margin - h
    : area.y + (area.height - h) / 2;
  return { left: x, top: y, width: w, height: h };
}
