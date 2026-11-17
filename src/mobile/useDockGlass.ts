import { useLayoutEffect, useRef, type RefObject } from 'react';
import { springStep, type Spring } from './dockPhysics';
import { createGlassRenderer } from './glassRenderer';
import { NativeWebView } from '../platform/nativeWebViewPlugin';
import { TaskStatus } from '../platform/taskStatusPlugin';

const spring = (value: number): Spring => ({ value, target: value, velocity: 0 });
export function useDockGlass(trackRef: RefObject<HTMLDivElement>, scrollRef: RefObject<HTMLDivElement>, navRef: RefObject<HTMLElement>, theme: string) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const motion = useRef({ x: spring(0), width: spring(76), lift: spring(0), stretch: spring(0), pull: spring(0) });
  const frame = useRef(0), previous = useRef(0), dark = useRef(theme === 'dark'); dark.current = theme === 'dark';
  const renderer = useRef<ReturnType<typeof createGlassRenderer>>(null);
  const pressedAt = useRef(0), dropTimer = useRef<ReturnType<typeof setTimeout>>();
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const paint = (now: number) => {
    frame.current = 0;
    const track = trackRef.current, nav = navRef.current;
    if (!track || !nav) return;
    const dt = previous.current ? (now - previous.current) / 1000 : 1 / 60; previous.current = now;
    const m = motion.current;
    m.stretch.target = Math.min(0.18, Math.abs(m.x.velocity) / 3500) * (m.lift.target ? 1 : 0.5);
    let moving = false;
    for (const key of ['x', 'width', 'lift', 'stretch', 'pull'] as const) {
      if (reduced()) { m[key].value = m[key].target; m[key].velocity = 0; }
      else moving = springStep(m[key], dt, key === 'x' && track.dataset.dragging ? 1050 : key === 'stretch' ? 170 : 460,
        key === 'x' && track.dataset.dragging ? 58 : key === 'stretch' ? 15 : 32) || moving;
    }
    const lift = Math.max(0, Math.min(1.12, m.lift.value));
    track.style.setProperty('--dock-active-x', `${m.x.value}px`);
    track.style.setProperty('--dock-active-width', `${m.width.value}px`);
    track.style.setProperty('--dock-lift', `${lift}`);
    track.style.setProperty('--dock-stretch', `${m.stretch.value}`);
    track.style.setProperty('--dock-pull', `${m.pull.value}px`);
    const center = m.x.value + m.width.value / 2;
    for (const button of track.querySelectorAll<HTMLButtonElement>('.mobile-tab')) {
      const weight = Math.max(0, 1 - Math.abs(button.offsetLeft + button.offsetWidth / 2 - center) / (m.width.value * 0.65));
      button.style.setProperty('--dock-magnify', `${1 + lift * 0.16 * weight}`);
    }
    const offset = track.getBoundingClientRect().left - nav.getBoundingClientRect().left;
    renderer.current?.draw(nav.clientWidth, nav.clientHeight + 22, { x: m.x.value + offset + m.pull.value, width: m.width.value,
      lift, stretch: m.stretch.value, light: (center / track.offsetWidth - 0.5) * 2, dark: dark.current });
    if (moving) frame.current = requestAnimationFrame(paint); else previous.current = 0;
  };
  const animate = () => { if (!frame.current && !document.hidden) frame.current = requestAnimationFrame(paint); };
  const target = (x: number, width: number, immediate = false) => {
    const m = motion.current; m.width.target = Math.max(76, width + 6); m.x.target = x + width / 2 - m.width.target / 2;
    if (immediate) { m.x.value = m.x.target; m.width.value = m.width.target; }
    animate();
  };
  const lift = (value: number) => {
    clearTimeout(dropTimer.current);
    if (value) { pressedAt.current = performance.now(); motion.current.lift.target = value; animate(); }
    else {
      const drop = () => { motion.current.lift.target = 0; motion.current.pull.target = 0; animate(); };
      const remaining = 220 - (performance.now() - pressedAt.current);
      if (!reduced() && remaining > 0) dropTimer.current = setTimeout(drop, remaining); else drop();
    }
  };
  useLayoutEffect(() => {
    const canvas = canvasRef.current, track = trackRef.current, scroller = scrollRef.current, nav = navRef.current;
    if (!canvas || !track || !scroller || !nav) return;
    let disposed = false, revision = 0, timer: ReturnType<typeof setTimeout>;
    const create = () => { renderer.current?.dispose(); renderer.current = createGlassRenderer(canvas); track.dataset.optics = renderer.current ? 'gpu' : 'css'; animate(); };
    const lost = (event: Event) => { event.preventDefault(); renderer.current = null; track.dataset.optics = 'css'; };
    const capture = async () => {
      if (document.hidden || !renderer.current) return;
      const request = ++revision;
      try {
        const result = await NativeWebView.captureDockBackdrop();
        if (!result.dataUrl || disposed || request !== revision) return;
        const image = new Image(); image.src = result.dataUrl; await image.decode();
        if (!disposed && request === revision) { renderer.current?.image(image); animate(); }
      } catch { /* CSS material remains available without a snapshot. */ }
    };
    const refresh = () => { clearTimeout(timer); timer = setTimeout(capture, 180); };
    const visible = () => { if (document.hidden) { cancelAnimationFrame(frame.current); frame.current = 0; previous.current = 0; }
      else { animate(); refresh(); } };
    // Legacy Android hardware compositors can stall when a live WebGL surface
    // sits above another WebView. Keep the CSS material and spring interaction
    // there, and enable the optical surface only on the newer compositor path.
    track.dataset.optics = 'css';
    void TaskStatus.getCapabilities().then(capabilities => {
      if (disposed) return;
      if (capabilities.api >= 30) { create(); refresh(); }
    }).catch(() => { /* Base glass remains usable without native capabilities. */ });
    const listener = NativeWebView.onNavigationChanged(refresh);
    const observer = new ResizeObserver(() => { animate(); refresh(); }); observer.observe(scroller);
    canvas.addEventListener('webglcontextlost', lost); canvas.addEventListener('webglcontextrestored', create);
    document.addEventListener('visibilitychange', visible); scroller.addEventListener('scroll', animate, { passive: true });
    nav.addEventListener('pointerdown', refresh, { passive: true });
    return () => { disposed = true; ++revision; clearTimeout(timer); clearTimeout(dropTimer.current); observer.disconnect(); cancelAnimationFrame(frame.current); frame.current = 0;
      renderer.current?.dispose(); renderer.current = null; void listener.then(handle => handle.remove());
      canvas.removeEventListener('webglcontextlost', lost); canvas.removeEventListener('webglcontextrestored', create);
      document.removeEventListener('visibilitychange', visible); scroller.removeEventListener('scroll', animate); nav.removeEventListener('pointerdown', refresh); };
  }, []);
  useLayoutEffect(animate, [theme]);
  return { canvasRef, target, lift, animate, pull: (value: number) => { motion.current.pull.target = value; animate(); } };
}
