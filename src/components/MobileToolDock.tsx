import { useLayoutEffect, useRef, type PointerEvent, type RefObject } from 'react';
import {
  BookOpen, Bug, Coins, History, LibraryBig, SlidersHorizontal, Sparkles,
} from 'lucide-react';
import { useDockGlass } from '../mobile/useDockGlass';
import { releaseIndex, rubberBand } from '../mobile/dockPhysics';

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

export function MobileToolDock({ activeTab, panelOpen, navRef, onSelect, theme = 'dark' }: {
  activeTab: MobileToolTab;
  panelOpen: boolean;
  theme?: string;
  navRef: RefObject<HTMLElement>;
  onSelect: (tab: MobileToolTab, gesture?: 'drag') => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const glass = useDockGlass(trackRef, scrollRef, navRef, theme);
  const gesture = useRef<{ pointer: number; x: number; y: number; latestX: number; latestY: number;
    lastX: number; time: number; velocity: number; scroll: number; moved: boolean; dragging: boolean; timer: ReturnType<typeof setTimeout>; target: HTMLButtonElement } | null>(null);
  const autoFrame = useRef(0);
  const suppressClick = useRef(false);

  const restore = () => {
    const track = trackRef.current;
    const selected = track?.querySelector<HTMLElement>('.is-active');
    if (!track || !selected) return;
    delete track.dataset.dragging;
    delete track.dataset.preview;
    delete track.dataset.pressed;
    glass.lift(0);
    glass.target(selected.offsetLeft, selected.offsetWidth);
    track.style.setProperty('--dock-drag-light', '50%');
  };
  const follow = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return null;
    const buttons = Array.from(track.querySelectorAll<HTMLButtonElement>('.mobile-tab'));
    const raw = clientX - track.getBoundingClientRect().left;
    const x = Math.max(0, Math.min(track.offsetWidth, raw));
    const closest = buttons.reduce((best, button) => Math.abs(button.offsetLeft + button.offsetWidth / 2 - x)
      < Math.abs(best.offsetLeft + best.offsetWidth / 2 - x) ? button : best, buttons[0]);
    glass.target(x - closest.offsetWidth / 2, closest.offsetWidth);
    glass.pull(rubberBand(raw - x, 14));
    track.style.setProperty('--dock-drag-light', `${x / track.offsetWidth * 100}%`);
    track.dataset.preview = closest.dataset.tool;
    return closest.dataset.tool as MobileToolTab;
  };
  const autoScroll = () => {
    const current = gesture.current, scroller = scrollRef.current;
    if (!current?.dragging || !scroller) return;
    const rect = scroller.getBoundingClientRect();
    const edge = 28;
    const velocity = current.latestX < rect.left + edge ? -Math.min(6, (rect.left + edge - current.latestX) / 5)
      : current.latestX > rect.right - edge ? Math.min(6, (current.latestX - rect.right + edge) / 5) : 0;
    scroller.scrollLeft += velocity;
    follow(current.latestX);
    autoFrame.current = requestAnimationFrame(autoScroll);
  };
  const finish = (cancelled: boolean) => {
    const current = gesture.current;
    if (!current) return;
    clearTimeout(current.timer); cancelAnimationFrame(autoFrame.current); autoFrame.current = 0;
    const rect = navRef.current?.getBoundingClientRect();
    const inside = rect && current.latestY >= rect.top - 30 && current.latestY <= rect.bottom + 30;
    let selected = current.dragging && inside ? follow(current.latestX) : null;
    if (selected && !cancelled) {
      const items = Array.from(trackRef.current!.querySelectorAll<HTMLButtonElement>('.mobile-tab'));
      const index = items.findIndex(item => item.dataset.tool === selected);
      const centers = items.map(item => item.offsetLeft + item.offsetWidth / 2);
      const velocity = performance.now() - current.time < 100 ? current.velocity : 0;
      selected = items[releaseIndex(centers, current.latestX - trackRef.current!.getBoundingClientRect().left, velocity, index)].dataset.tool as MobileToolTab;
    }
    suppressClick.current = current.dragging || current.moved || cancelled;
    gesture.current = null;
    restore();
    if (current.target.hasPointerCapture(current.pointer)) current.target.releasePointerCapture(current.pointer);
    if (!cancelled && selected) onSelect(selected, 'drag');
  };
  const down = (event: PointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    finish(true);
    suppressClick.current = false;
    const target = event.currentTarget;
    trackRef.current!.dataset.pressed = 'true';
    glass.lift(1); glass.target(target.offsetLeft, target.offsetWidth);
    target.setPointerCapture(event.pointerId);
    const timer = setTimeout(() => {
      const current = gesture.current;
      if (!current || current.moved) return;
      current.dragging = true;
      trackRef.current!.dataset.dragging = 'true';
      follow(current.latestX);
      autoFrame.current = requestAnimationFrame(autoScroll);
    }, 320);
    gesture.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, latestX: event.clientX, latestY: event.clientY,
      lastX: event.clientX, time: performance.now(), velocity: 0,
      scroll: scrollRef.current!.scrollLeft, moved: false, dragging: false, timer, target };
  };

  useLayoutEffect(() => {
    const track = trackRef.current;
    const scroller = scrollRef.current;
    if (!track || !scroller) return;
    const selected = track.querySelector<HTMLElement>('.is-active');
    if (!selected) return;
    const measure = () => {
      if (gesture.current?.dragging) return;
      // Layout offsets exclude press transforms and move with the scrolling track.
      glass.target(selected.offsetLeft, selected.offsetWidth, !track.dataset.ready);
      const left = selected.offsetLeft;
      const right = left + selected.offsetWidth;
      if (left < scroller.scrollLeft || right > scroller.scrollLeft + scroller.clientWidth) {
        const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
        scroller.scrollTo({ left: Math.max(0, left - (scroller.clientWidth - selected.offsetWidth) / 2), behavior: reduced ? 'instant' : 'smooth' });
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
      if (gesture.current) { clearTimeout(gesture.current.timer); gesture.current = null; }
      cancelAnimationFrame(autoFrame.current);
    };
  }, [activeTab]);

  return <nav ref={navRef} className="mobile-tabs" aria-label="工具导航"
    onContextMenu={event => event.preventDefault()}
    onPointerMove={event => {
      const current = gesture.current;
      if (!current || current.pointer !== event.pointerId) return;
      const now = performance.now(), dt = now - current.time;
      if (dt > 0) current.velocity = current.velocity * 0.3 + (event.clientX - current.lastX) / dt * 700;
      current.lastX = event.clientX; current.time = now;
      current.latestX = event.clientX; current.latestY = event.clientY;
      if (current.dragging) { event.preventDefault(); follow(event.clientX); }
      else if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 8) {
        current.moved = true; clearTimeout(current.timer);
        const scroller = scrollRef.current!;
        if (scroller.scrollWidth <= scroller.clientWidth + 1) {
          current.dragging = true; trackRef.current!.dataset.dragging = 'true'; follow(event.clientX);
          autoFrame.current = requestAnimationFrame(autoScroll);
        } else { scroller.scrollLeft = current.scroll - (event.clientX - current.x); glass.lift(0); }
      }
    }}
    onPointerUp={event => {
      if (gesture.current?.pointer !== event.pointerId) return;
      gesture.current.latestX = event.clientX; gesture.current.latestY = event.clientY;
      finish(false);
    }} onPointerCancel={event => { if (gesture.current?.pointer === event.pointerId) finish(true); }}>
    <canvas ref={glass.canvasRef} className="mobile-tabs__optics" aria-hidden="true" />
    <div ref={scrollRef} className="mobile-tabs__scroll">
      <div ref={trackRef} className="mobile-tabs__track">
        <div className="mobile-tabs__selection" aria-hidden="true" />
        {tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button"
          data-tool={id} onPointerDown={down} onLostPointerCapture={event => { if (gesture.current?.pointer === event.pointerId) finish(true); }}
          aria-label={label} aria-controls="mobile-tool-panel" aria-expanded={panelOpen && activeTab === id}
          aria-current={activeTab === id ? 'true' : undefined}
          className={`mobile-tab${activeTab === id ? ' is-active' : ''}`} onClick={event => {
            if (event.detail !== 0 && suppressClick.current) { event.preventDefault(); suppressClick.current = false; return; }
            onSelect(id);
          }}>
          <Icon size={21} strokeWidth={1.8} aria-hidden="true" />
          <span>{label}</span>
        </button>)}
      </div>
    </div>
  </nav>;
}
