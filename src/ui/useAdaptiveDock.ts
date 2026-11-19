import { useEffect, useReducer, useRef } from 'react';
import { NativeWebView } from '../platform/nativeWebViewPlugin';
import { dockReducer, initialDockState } from './dockState';

// Read-only UI telemetry. Capture-phase scroll also covers nested page scrollers.
function readPageScroll() {
  const page = window as any;
  if (!page.__studyPilotDockScroll) {
    const state = { y: window.scrollY || 0, delta: 0, sequence: 0 };
    page.__studyPilotDockScroll = state;
    document.addEventListener('scroll', event => {
      const target = event.target;
      if (target instanceof Element && (target.clientHeight < 120 || target.scrollHeight <= target.clientHeight)) return;
      const y = target instanceof Element ? target.scrollTop : window.scrollY || document.documentElement.scrollTop;
      const previous = (page.__studyPilotDockScrollTarget === target) ? state.y : 0;
      page.__studyPilotDockScrollTarget = target;
      state.delta = y - previous; state.y = Math.max(0, y); state.sequence++;
    }, { capture: true, passive: true });
  }
  return page.__studyPilotDockScroll;
}
const scrollScript = `(${readPageScroll.toString()})()`;
export function useAdaptiveDock(mobile: boolean, running: boolean, panelOpen: boolean, enabled: boolean, onStart: () => void) {
  const [state, dispatch] = useReducer(dockReducer, initialDockState);
  const latest = useRef({ panelOpen, onStart, running }); latest.current = { panelOpen, onStart, running };
  useEffect(() => {
    dispatch({ type: 'running', value: running });
    if (running) latest.current.onStart();
  }, [running]);
  useEffect(() => {
    if (!enabled) { if (!latest.current.running) dispatch({ type: 'expand' }); return; }
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    let previousSource: unknown, previousSequence = -1, previousY = 0;
    const poll = async () => {
      if (!document.hidden && !latest.current.panelOpen) {
        try {
          const guest = document.querySelector('webview[data-active-browser="true"]') as any;
          const source = mobile ? (await NativeWebView.listTabs()).activeTabId : guest;
          const result = mobile ? (await NativeWebView.executeScript(scrollScript, source as string)).result : await guest?.executeJavaScript(scrollScript);
          const value = typeof result === 'string' ? JSON.parse(result) : result;
          if (!disposed && value && Number.isFinite(value.y) && (value.sequence !== previousSequence || source !== previousSource)) {
            if (source !== previousSource) { previousSource = source; previousY = value?.y || 0; }
            if (value && Number.isFinite(value.y)) {
              dispatch({ type: 'scroll', y: value.y, delta: value.y - previousY, panelOpen: latest.current.panelOpen });
              previousY = value.y; previousSequence = value.sequence;
            }
          }
        } catch { /* Navigation replaces documents; resume on the next UI sample. */ }
      }
      if (!disposed) timer = setTimeout(poll, 160);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [mobile, enabled]);
  return { collapsed: state.collapsed, expand: () => dispatch({ type: 'expand' }) };
}
