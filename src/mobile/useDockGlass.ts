import { useLayoutEffect, useRef, type RefObject } from 'react';
import { fitDockLens, springStep, type Spring } from './dockPhysics';
import { continuousCapture } from './continuousCapture';
import { createGlassRenderer } from './glassRenderer';
import { NativeWebView } from '../platform/nativeWebViewPlugin';
import { TaskStatus } from '../platform/taskStatusPlugin';
import { lensDisplacement } from './lensDisplacement';

const spring = (value: number): Spring => ({ value, target: value, velocity: 0 });
export type GlassBackdrop = { dataUrl: string; bounds: { x: number; y: number; width: number; height: number } };
export type DockGlassSource = { capture: (bounds: DOMRect) => Promise<GlassBackdrop>; available: () => Promise<boolean> };
export function useDockGlass(trackRef: RefObject<HTMLDivElement>, scrollRef: RefObject<HTMLDivElement>, navRef: RefObject<HTMLElement>, theme: string, source?: DockGlassSource, vertical = false, collapsed = false, quality: 'ultra' | 'standard' = 'ultra') {
  const options = useRef({ vertical, collapsed, quality }); options.current = { vertical, collapsed, quality };
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const motion = useRef({ x: spring(0), width: spring(44), lift: spring(0), stretch: spring(0), pull: spring(0) });
  const frame = useRef(0), previous = useRef(0), dark = useRef(theme === 'dark'); dark.current = theme === 'dark';
  const renderer = useRef<ReturnType<typeof createGlassRenderer>>(null);
  const dropping = useRef(false);
  const contents = useRef<{ button: HTMLButtonElement; base: HTMLElement | null; magnified: HTMLElement | null; map: Element | null; warps: Element[]; active: boolean }[]>([]);
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const paint = (now: number) => {
    frame.current = 0;
    const track = trackRef.current, nav = navRef.current;
    if (!track || !nav) return;
    const dt = previous.current ? (now - previous.current) / 1000 : 1 / 60; previous.current = now;
    const m = motion.current;
    const { vertical, collapsed, quality } = options.current;
    const length = vertical ? nav.clientHeight : nav.clientWidth, cross = vertical ? nav.clientWidth : nav.clientHeight;
    const acceleration = (m.x.target - m.x.value) * 600 - m.x.velocity * 35;
    const braking = Math.max(0, -acceleration * Math.sign(m.x.velocity));
    m.stretch.target = .10 * Math.tanh(Math.abs(m.x.velocity) / 400) - .07 * Math.tanh(braking / 2500);
    let moving = false;
    for (const key of ['x', 'width', 'lift', 'stretch', 'pull'] as const) {
      if (reduced()) { m[key].value = m[key].target; m[key].velocity = 0; }
      else moving = springStep(m[key], dt, key === 'x' ? 1024 : key === 'stretch' ? 160 : key === 'lift' ? 400 : 600,
        key === 'x' ? 60 : key === 'stretch' ? 20 : key === 'lift' ? 28 : 40) || moving;
    }
    // Finish rising and reach the released destination before lowering. A
    // fixed timeout drops a quick flick while its lens is still travelling.
    if (dropping.current && (reduced() || (m.lift.value >= .975 && Math.abs(m.x.target - m.x.value) < .25))) {
      dropping.current = false; m.lift.target = 0; m.pull.target = 0; moving = true;
    }
    const lift = Math.max(0, Math.min(1.12, m.lift.value));
    const navBounds = nav.getBoundingClientRect();
    const offset = vertical ? track.getBoundingClientRect().top - navBounds.top : track.getBoundingClientRect().left - navBounds.left;
    // Read geometry before any style writes. Alternating offset reads with
    // clip/filter writes forces a new layout for every destination each frame.
    const geometry = contents.current.map(content => ({ ...content, left: vertical ? content.button.offsetTop : content.button.offsetLeft,
      width: vertical ? content.button.offsetHeight : content.button.offsetWidth, height: vertical ? content.button.offsetWidth : content.button.offsetHeight }));
    const lens = fitDockLens(m.x.value + offset + m.pull.value + m.width.value / 2, m.width.value, lift,
      m.stretch.value, length, cross, quality === 'ultra' ? 16 : 4);
    track.style.setProperty('--dock-active-x', `${lens.x - offset}px`);
    track.style.setProperty('--dock-active-width', `${lens.width}px`);
    track.style.setProperty('--dock-active-height', `${lens.height}px`);
    track.style.setProperty('--dock-lift', `${lift}`);
    track.style.setProperty('--dock-stretch', `${m.stretch.value}`);
    track.style.setProperty('--dock-pull', `${m.pull.value}px`);
    const center = m.x.value + m.width.value / 2;
    for (const [index, content] of geometry.entries()) {
      const { button, base, magnified, map, warps, left: buttonLeft, width: buttonWidth, height: buttonHeight } = content;
      const weight = Math.max(0, 1 - Math.abs(buttonLeft + buttonWidth / 2 - center) / (m.width.value * 0.65));
      const intersects = !collapsed && lift > .4 && lens.x - offset < buttonLeft + buttonWidth && lens.x - offset + lens.width > buttonLeft;
      if (!intersects && !content.active) continue;
      contents.current[index].active = intersects;
      button.style.setProperty('--dock-magnify', `${1 + lift * 0.16 * weight}`);
      if (base && magnified) {
        const along = lens.x - offset - buttonLeft, across = (buttonHeight - lens.height) / 2;
        const left = vertical ? across : along, top = vertical ? along : across;
        const w = vertical ? lens.height : lens.width, h = vertical ? lens.width : lens.height, r = Math.min(w, h) / 2;
        const path = `M${left+r} ${top}H${left+w-r}Q${left+w} ${top} ${left+w} ${top+r}V${top+h-r}Q${left+w} ${top+h} ${left+w-r} ${top+h}H${left+r}Q${left} ${top+h} ${left} ${top+h-r}V${top+r}Q${left} ${top} ${left+r} ${top}Z`;
        base.style.clipPath = intersects ? `path(evenodd, "M-20 -20H${(vertical ? buttonHeight : buttonWidth)+20}V${(vertical ? buttonWidth : buttonHeight)+20}H-20Z ${path}")` : '';
        magnified.style.clipPath = `path("${path}")`;
        magnified.style.opacity = intersects ? '1' : '0';
        if (map) {
          map.setAttribute('x', String(left)); map.setAttribute('y', String(top));
          map.setAttribute('width', String(w)); map.setAttribute('height', String(h));
        }
        warps.forEach(warp => warp.setAttribute('scale', String(lift * (quality === 'ultra'
          ? 14 + Number(warp.getAttribute('data-channel') || 0) * 3.6 : 8))));
      }
    }
    renderer.current?.draw(nav.clientWidth, nav.clientHeight, { x: collapsed ? 2 : m.x.value + offset + m.pull.value, width: collapsed ? length - 4 : m.width.value,
      vertical, quality, lift: collapsed ? 0 : lift, stretch: m.stretch.value, light: (center / (vertical ? track.offsetHeight : track.offsetWidth) - 0.5) * 2, dark: dark.current,
      originX: navBounds.x, originY: navBounds.y });
    if (moving) frame.current = requestAnimationFrame(paint); else previous.current = 0;
  };
  const animate = () => { if (!frame.current && !document.hidden) frame.current = requestAnimationFrame(paint); };
  const target = (x: number, width: number, immediate = false) => {
    const m = motion.current; m.width.target = Math.max(32, width - 4); m.x.target = x + width / 2 - m.width.target / 2;
    if (immediate) { m.x.value = m.x.target; m.width.value = m.width.target; }
    animate();
  };
  const lift = (value: number) => {
    if (value) { dropping.current = false; motion.current.lift.target = value; }
    else if (motion.current.lift.target < .9) { dropping.current = false; motion.current.lift.target = 0; motion.current.pull.target = 0; }
    else dropping.current = true;
    animate();
  };
  useLayoutEffect(() => {
    const canvas = canvasRef.current, track = trackRef.current, scroller = scrollRef.current, nav = navRef.current;
    if (!canvas || !track || !scroller || !nav) return;
    contents.current = Array.from(track.querySelectorAll<HTMLButtonElement>('.mobile-tab')).map(button => ({ button,
      base: button.querySelector<HTMLElement>('.mobile-tab__content'), magnified: button.querySelector<HTMLElement>('.mobile-tab__lens'),
      map: nav.querySelector(`[data-warp-map="${button.dataset.tool}"]`), warps: Array.from(nav.querySelectorAll(`[data-warp-scale="${button.dataset.tool}"]`)), active: false }));
    const field = lensDisplacement(), mapCanvas = document.createElement('canvas');
    mapCanvas.width = field.width; mapCanvas.height = field.height;
    const mapContext = mapCanvas.getContext('2d');
    if (mapContext) {
      mapContext.putImageData(new ImageData(field.pixels, field.width, field.height), 0, 0);
      const uri = mapCanvas.toDataURL();
      nav.querySelectorAll('[data-warp-map]').forEach(map => map.setAttribute('href', uri));
    }
    let disposed = false, revision = 0, foreground = true;
    const create = () => { renderer.current?.dispose(); renderer.current = createGlassRenderer(canvas); track.dataset.optics = renderer.current && !source ? 'gpu' : 'css'; animate(); };
    const lost = (event: Event) => { event.preventDefault(); renderer.current?.dispose(); renderer.current = null; track.dataset.optics = 'css'; };
    const capture = async () => {
      if (!foreground || document.hidden || !renderer.current) return;
      // Source drawing and texture uploads share the compositor with the lens.
      // Keep a live cadence while leaving several frames free during travel.
      const now = performance.now();
      const travelling = Math.abs(motion.current.x.velocity) > 20 || Math.abs(motion.current.x.target - motion.current.x.value) > 2;
      if (travelling && now - lastCapture < 320) return;
      lastCapture = now;
      const request = ++revision;
      try {
        const { x, y, width, height } = nav.getBoundingClientRect();
        const result = source ? await source.capture(nav.getBoundingClientRect()) : await NativeWebView.captureDockBackdrop({ x, y, width, height });
        if (disposed || request !== revision) return;
        if (!result.dataUrl) { if (source) { track.dataset.optics = 'css'; delete nav.dataset.backdropTone; } return; }
        const image = new Image(); image.src = result.dataUrl; await image.decode();
        const current = nav.getBoundingClientRect();
        if (!disposed && foreground && request === revision && Math.abs(current.x - x) < 1 && Math.abs(current.y - y) < 1
          && Math.abs(current.width - width) < 1 && Math.abs(current.height - height) < 1) {
          renderer.current?.image(image, result.bounds); if (renderer.current) track.dataset.optics = 'gpu';
          {
            const sample = document.createElement('canvas'); sample.width = sample.height = 4;
            const context = sample.getContext('2d', { willReadFrequently: true });
            if (context) {
              context.drawImage(image, 0, 0, 4, 4);
              const pixels = context.getImageData(0, 0, 4, 4).data;
              let luminance = 0;
              for (let i = 0; i < pixels.length; i += 4) luminance += pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722;
              let tone = luminance / 16;
              nav.dataset.sceneTone = tone > 155 ? 'light' : 'dark';
              if (options.current.quality === 'ultra') {
                const t = Math.max(0, Math.min(1, (tone / 255 - .2) / .75));
                const contrast = t * t * (3 - 2 * t);
                const veil = dark.current ? .48 + .22 * contrast : .576 + .18 * (1 - contrast);
                tone = tone * (1 - veil) + (dark.current ? 20 : 244) * veil;
              }
              nav.dataset.backdropTone = tone > 155 ? 'light' : 'dark';
            }
          }
          animate();
        }
      } catch { /* CSS material remains available without a snapshot. */ }
    };
    let lastCapture = 0;
    const captures = continuousCapture(capture, reduced() ? 180 : 90);
    const visible = () => {
      captures.setVisible(foreground && !document.hidden && !!renderer.current);
      if (!foreground || document.hidden) { ++revision; cancelAnimationFrame(frame.current); frame.current = 0; previous.current = 0; }
      else animate();
    };
    // Legacy Android hardware compositors can stall when a live WebGL surface
    // sits above another WebView. Keep the CSS material and spring interaction
    // there, and enable the optical surface only on the newer compositor path.
    track.dataset.optics = 'css';
    void (source ? source.available() : TaskStatus.getCapabilities().then(capabilities => capabilities.api >= 30)).then(available => {
      if (disposed) return;
      if (available) { create(); visible(); }
    }).catch(() => { /* Base glass remains usable without native capabilities. */ });
    const observer = new ResizeObserver(animate); observer.observe(scroller); observer.observe(nav);
    const nativeVisibility = source ? Promise.resolve(null) : NativeWebView.onVisibilityChanged(state => { foreground = state.visible; visible(); });
    const contextLost = (event: Event) => { lost(event); captures.setVisible(false); ++revision; };
    const restored = () => { create(); visible(); };
    canvas.addEventListener('webglcontextlost', contextLost); canvas.addEventListener('webglcontextrestored', restored);
    document.addEventListener('visibilitychange', visible); scroller.addEventListener('scroll', animate, { passive: true });
    return () => { disposed = true; ++revision; captures.dispose(); observer.disconnect(); cancelAnimationFrame(frame.current); frame.current = 0;
      renderer.current?.dispose(); renderer.current = null;
      void nativeVisibility.then(listener => listener?.remove());
      canvas.removeEventListener('webglcontextlost', contextLost); canvas.removeEventListener('webglcontextrestored', restored);
      document.removeEventListener('visibilitychange', visible); scroller.removeEventListener('scroll', animate); };
  }, []);
  useLayoutEffect(animate, [theme, vertical, collapsed, quality]);
  return { canvasRef, target, lift, animate, pull: (value: number) => { motion.current.pull.target = value; animate(); } };
}
