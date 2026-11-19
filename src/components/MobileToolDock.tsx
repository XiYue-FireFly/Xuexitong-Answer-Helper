import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import {
  BookOpen, Bug, Coins, History, LibraryBig, SlidersHorizontal, Sparkles,
} from 'lucide-react';
import { useDockGlass, type DockGlassSource } from '../mobile/useDockGlass';
import { releaseIndex, rubberBand } from '../mobile/dockPhysics';
import '../mobile/dock.css';
import { dockBounds } from '../ui/dockState';
import { useDockPreferences } from '../ui/dockPreferences';
import './dockAdaptive.css';
import { NativeWebView } from '../platform/nativeWebViewPlugin';

export type MobileToolTab = 'automation' | 'snapshot' | 'tokens' | 'history' | 'bugs' | 'tutorial' | 'settings';

const tabs: { id: MobileToolTab; label: string; icon: typeof Sparkles }[] = [
  { id: 'automation', label: '答题', icon: Sparkles },
  { id: 'snapshot', label: '题库', icon: LibraryBig },
  { id: 'tokens', label: 'Token', icon: Coins },
  { id: 'history', label: '记录', icon: History },
  { id: 'bugs', label: '错误', icon: Bug },
  { id: 'tutorial', label: '教程', icon: BookOpen },
  { id: 'settings', label: '设置', icon: SlidersHorizontal },
];

export function MobileToolDock({ activeTab, panelOpen, navRef, onSelect, theme = 'dark', glassSource, panelId = 'mobile-tool-panel', compact = false, collapsed = false, onExpand }: {
  activeTab: MobileToolTab;
  panelOpen: boolean;
  theme?: string;
  navRef: RefObject<HTMLElement>;
  onSelect: (tab: MobileToolTab, gesture?: 'drag') => void;
  glassSource?: DockGlassSource;
  panelId?: string;
  compact?: boolean;
  collapsed?: boolean;
  onExpand?: () => void;
}) {
  const preferences = useDockPreferences();
  const vertical = preferences.edge === 'left' || preferences.edge === 'right';
  const items = compact ? tabs.filter(tab => ['automation', 'snapshot', 'settings'].includes(tab.id)) : tabs;
  const selectedTab = items.some(tab => tab.id === activeTab) ? activeTab : 'settings';
  const [bounds, setBounds] = useState({ left: 14, top: 140, width: 62, height: 62 });
  useLayoutEffect(() => {
    const measure = () => {
      const workspace = navRef.current?.parentElement;
      if (!workspace) return;
      const mobile = workspace.classList.contains('mobile-shell');
      const header = document.querySelector('.mobile-header')?.getBoundingClientRect();
      const area = mobile ? { x: 0, y: header?.bottom || 90, width: innerWidth, height: innerHeight - (header?.bottom || 90) }
        : { x: 0, y: Math.min(98, workspace.clientHeight / 4), width: workspace.clientWidth, height: workspace.clientHeight - Math.min(98, workspace.clientHeight / 4) };
      setBounds(dockBounds(preferences.edge, collapsed, items.length, area));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (navRef.current?.parentElement) observer.observe(navRef.current.parentElement);
    const header = document.querySelector('.mobile-header'); if (header) observer.observe(header);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('resize', measure); };
  }, [preferences.edge, collapsed, compact]);
  const trackRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const glass = useDockGlass(trackRef, scrollRef, navRef, theme, glassSource, vertical, collapsed, preferences.glass);
  const gesture = useRef<{ pointer: number; x: number; y: number; latestX: number; latestY: number;
    lastX: number; time: number; velocity: number; scroll: number; moved: boolean; dragging: boolean; timer: ReturnType<typeof setTimeout>; target: HTMLButtonElement } | null>(null);
  const autoFrame = useRef(0);
  const suppressClick = useRef(false);

  const coordinate = (x: number, y: number) => vertical ? y : x;
  const offset = (element: HTMLElement) => vertical ? element.offsetTop : element.offsetLeft;
  const extent = (element: HTMLElement) => vertical ? element.offsetHeight : element.offsetWidth;
  const origin = (rect: DOMRect) => vertical ? rect.top : rect.left;
  const scrollValue = (element: HTMLElement) => vertical ? element.scrollTop : element.scrollLeft;
  const setScroll = (element: HTMLElement, value: number) => { if (vertical) element.scrollTop = value; else element.scrollLeft = value; };
  const restore = (destination?: MobileToolTab) => {
    const track = trackRef.current;
    const selected = track?.querySelector<HTMLElement>(destination ? `[data-tool="${destination}"]` : '.is-active');
    if (!track || !selected) return;
    delete track.dataset.dragging;
    delete track.dataset.preview;
    delete track.dataset.pressed;
    glass.lift(0);
    glass.target(offset(selected), extent(selected));
    track.style.setProperty('--dock-drag-light', '50%');
  };
  const follow = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return null;
    const buttons = Array.from(track.querySelectorAll<HTMLButtonElement>('.mobile-tab'));
    const raw = clientX - origin(track.getBoundingClientRect());
    const x = Math.max(0, Math.min(extent(track), raw));
    const closest = buttons.reduce((best, button) => Math.abs(offset(button) + extent(button) / 2 - x)
      < Math.abs(offset(best) + extent(best) / 2 - x) ? button : best, buttons[0]);
    glass.target(x - extent(closest) / 2, extent(closest));
    glass.pull(rubberBand(raw - x, 14));
    track.style.setProperty('--dock-drag-light', `${x / extent(track) * 100}%`);
    if (gesture.current?.dragging && track.dataset.preview && track.dataset.preview !== closest.dataset.tool) {
      if (!glassSource) void NativeWebView.selectionHaptic().catch(() => undefined);
    }
    track.dataset.preview = closest.dataset.tool;
    return closest.dataset.tool as MobileToolTab;
  };
  const autoScroll = () => {
    const current = gesture.current, scroller = scrollRef.current;
    if (!current?.dragging || !scroller) return;
    const rect = scroller.getBoundingClientRect();
    const edge = 28;
    const point = coordinate(current.latestX, current.latestY), start = origin(rect), end = start + (vertical ? rect.height : rect.width);
    const velocity = point < start + edge ? -Math.min(6, (start + edge - point) / 5)
      : point > end - edge ? Math.min(6, (point - end + edge) / 5) : 0;
    setScroll(scroller, scrollValue(scroller) + velocity);
    follow(point);
    autoFrame.current = requestAnimationFrame(autoScroll);
  };
  const finish = (cancelled: boolean) => {
    const current = gesture.current;
    if (!current) return;
    clearTimeout(current.timer); cancelAnimationFrame(autoFrame.current); autoFrame.current = 0;
    // Captured drags keep following horizontally even when the finger moves
    // above the glass. Only a real pointer cancellation abandons selection.
    let selected = current.dragging ? follow(coordinate(current.latestX, current.latestY)) : null;
    if (selected && !cancelled) {
      const items = Array.from(trackRef.current!.querySelectorAll<HTMLButtonElement>('.mobile-tab'));
      const index = items.findIndex(item => item.dataset.tool === selected);
      const centers = items.map(item => offset(item) + extent(item) / 2);
      const velocity = performance.now() - current.time < 100 ? current.velocity : 0;
      selected = items[releaseIndex(centers, coordinate(current.latestX, current.latestY) - origin(trackRef.current!.getBoundingClientRect()), velocity, index)].dataset.tool as MobileToolTab;
    }
    suppressClick.current = current.dragging || current.moved || cancelled;
    gesture.current = null;
    const committed = !cancelled && selected ? selected : !cancelled && !current.moved ? current.target.dataset.tool as MobileToolTab : undefined;
    restore(committed);
    if (current.target.hasPointerCapture(current.pointer)) current.target.releasePointerCapture(current.pointer);
    if (!cancelled && selected) onSelect(selected, 'drag');
  };
  const down = (event: PointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    finish(true);
    suppressClick.current = false;
    const target = event.currentTarget;
    trackRef.current!.dataset.pressed = 'true';
    glass.lift(.18); glass.target(offset(target), extent(target));
    target.setPointerCapture(event.pointerId);
    const timer = setTimeout(() => {
      const current = gesture.current;
      if (!current || current.moved) return;
      current.dragging = true;
      glass.lift(1);
      trackRef.current!.dataset.dragging = 'true';
      follow(coordinate(current.latestX, current.latestY));
      autoFrame.current = requestAnimationFrame(autoScroll);
    }, 320);
    gesture.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, latestX: event.clientX, latestY: event.clientY,
      lastX: coordinate(event.clientX, event.clientY), time: performance.now(), velocity: 0,
      scroll: scrollValue(scrollRef.current!), moved: false, dragging: false, timer, target };
  };

  useLayoutEffect(() => {
    const track = trackRef.current;
    const scroller = scrollRef.current;
    if (!track || !scroller) return;
    const selected = track.querySelector<HTMLElement>(`[data-tool="${selectedTab}"]`);
    if (!selected) return;
    const measure = () => {
      if (gesture.current) return;
      // Layout offsets exclude press transforms and move with the scrolling track.
      glass.target(offset(selected), extent(selected), !track.dataset.ready);
      const left = offset(selected);
      const right = left + extent(selected);
      if (left < scrollValue(scroller) || right > scrollValue(scroller) + (vertical ? scroller.clientHeight : scroller.clientWidth)) {
        const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
        scroller.scrollTo({ [vertical ? 'top' : 'left']: Math.max(0, left - ((vertical ? scroller.clientHeight : scroller.clientWidth) - extent(selected)) / 2), behavior: reduced ? 'instant' : 'smooth' });
      }
    };
    measure();
    // The first position is immediate; later changes slide the same capsule.
    const frame = requestAnimationFrame(() => { track.dataset.ready = 'true'; });
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    observer.observe(selected);
    observer.observe(scroller);
    const resize = () => finish(true);
    const hidden = () => { if (document.hidden) finish(true); };
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', hidden);
      if (gesture.current) finish(true);
      cancelAnimationFrame(autoFrame.current);
    };
  }, [selectedTab, vertical, collapsed]);
  useLayoutEffect(() => { scrollRef.current?.toggleAttribute('inert', collapsed); }, [collapsed]);

  return <nav ref={navRef} className={`mobile-tabs adaptive-dock${collapsed ? ' is-collapsed' : ''}`} aria-label="工具导航"
    data-edge={preferences.edge} data-vertical={vertical} data-glass={preferences.glass} data-compact={compact}
    style={bounds}
    onContextMenu={event => event.preventDefault()}
    onPointerMove={event => {
      const current = gesture.current;
      if (!current || current.pointer !== event.pointerId) return;
      const now = performance.now(), dt = now - current.time;
      if (dt > 0) current.velocity = current.velocity * 0.3 + (coordinate(event.clientX, event.clientY) - current.lastX) / dt * 700;
      current.lastX = coordinate(event.clientX, event.clientY); current.time = now;
      current.latestX = event.clientX; current.latestY = event.clientY;
      if (current.dragging) { event.preventDefault(); follow(coordinate(event.clientX, event.clientY)); }
      else if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 8) {
        current.moved = true; clearTimeout(current.timer);
        const scroller = scrollRef.current!;
        if ((vertical ? scroller.scrollHeight <= scroller.clientHeight + 1 : scroller.scrollWidth <= scroller.clientWidth + 1)) {
          current.dragging = true; glass.lift(1); trackRef.current!.dataset.dragging = 'true'; follow(coordinate(event.clientX, event.clientY));
          autoFrame.current = requestAnimationFrame(autoScroll);
        } else { setScroll(scroller, current.scroll - (coordinate(event.clientX, event.clientY) - coordinate(current.x, current.y))); glass.lift(0); }
      }
    }}
    onPointerUp={event => {
      if (gesture.current?.pointer !== event.pointerId) return;
      gesture.current.latestX = event.clientX; gesture.current.latestY = event.clientY;
      finish(false);
    }} onPointerCancel={event => { if (gesture.current?.pointer === event.pointerId) finish(true); }}>
    <canvas ref={glass.canvasRef} className="mobile-tabs__optics" aria-hidden="true" />
    <svg width="0" height="0" aria-hidden="true" className="mobile-tabs__filters"><defs>
      {items.map(({ id }) => <filter key={id} id={`dock-content-${id}`} x="-100%" y="-100%" width="300%" height="300%" colorInterpolationFilters="sRGB">
        <feImage data-warp-map={id} preserveAspectRatio="none" result="rim" />
        <feDisplacementMap data-warp-scale={id} data-channel="1" in="SourceGraphic" in2="rim" scale="0" xChannelSelector="R" yChannelSelector="G" result="redWarp" />
        <feColorMatrix in="redWarp" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="red" />
        <feDisplacementMap data-warp-scale={id} data-channel="0" in="SourceGraphic" in2="rim" scale="0" xChannelSelector="R" yChannelSelector="G" result="greenWarp" />
        <feColorMatrix in="greenWarp" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="green" />
        <feDisplacementMap data-warp-scale={id} data-channel="-1" in="SourceGraphic" in2="rim" scale="0" xChannelSelector="R" yChannelSelector="G" result="blueWarp" />
        <feColorMatrix in="blueWarp" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="blue" />
        <feBlend in="red" in2="green" mode="screen" result="rg" /><feBlend in="rg" in2="blue" mode="screen" />
      </filter>)}
    </defs></svg>
    <div ref={scrollRef} className="mobile-tabs__scroll" aria-hidden={collapsed}>
      <div ref={trackRef} className="mobile-tabs__track">
        <div className="mobile-tabs__selection" aria-hidden="true" />
        {items.map(({ id, label, icon: Icon }) => <button key={id} type="button"
          data-tool={id} onPointerDown={down} onLostPointerCapture={event => { if (gesture.current?.pointer === event.pointerId) finish(true); }}
          aria-label={label} aria-controls={panelId} aria-expanded={panelOpen && selectedTab === id}
          aria-current={selectedTab === id ? 'true' : undefined}
          className={`mobile-tab${selectedTab === id ? ' is-active' : ''}`} onClick={event => {
            if (event.detail !== 0 && suppressClick.current) { event.preventDefault(); suppressClick.current = false; return; }
            onSelect(id);
          }}>
          <span className="mobile-tab__content"><Icon size={21} strokeWidth={1.8} aria-hidden="true" /><span>{label}</span></span>
          <span className="mobile-tab__lens" aria-hidden="true" style={{ filter: `url(#dock-content-${id})` }}><span className="mobile-tab__magnified"><Icon size={21} strokeWidth={1.8} /><span>{label}</span></span></span>
        </button>)}
      </div>
    </div>
    <button type="button" className="dock-answer" aria-label="答题 · 展开工具栏" aria-expanded={!collapsed}
      tabIndex={collapsed ? 0 : -1} aria-hidden={!collapsed} onClick={() => onExpand?.()}>
      <Sparkles size={25} strokeWidth={1.8} aria-hidden="true" /><span>答题</span>
    </button>
  </nav>;
}
