/** One in-flight capture, including decoding. Idle/hidden surfaces do no work. */
export function continuousCapture(capture: () => Promise<void>, interval: number, initialDelay = 0) {
  let visible = false, disposed = false, busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (disposed || !visible || busy) return;
    busy = true;
    try { await capture(); } catch { /* Retry transient surface/context loss on the next tick. */ }
    finally {
      busy = false;
      if (!disposed && visible) timer = setTimeout(tick, interval);
    }
  };
  return {
    setVisible(value: boolean) {
      if (disposed || visible === value) return;
      visible = value; clearTimeout(timer);
      if (visible) { if (initialDelay) timer = setTimeout(tick, initialDelay); else void tick(); }
    },
    dispose() { disposed = true; visible = false; clearTimeout(timer); },
  };
}
