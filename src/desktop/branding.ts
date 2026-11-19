import './branding.css';

const isRust = () => (window as any).__RUST_HOST__?.identity === 'rust';
/** Presentation-only binding keeps the existing React/business modules intact. */
export function installBranding() {
  let scheduled = false;
  const refresh = () => {
    scheduled = false;
    const rust = isRust();
    document.documentElement.dataset.brand = rust ? 'wisp-rs' : 'wisp';
    const title = rust ? 'WISP RS' : 'WISP';
    if (document.title !== title) document.title = title;
    const label = document.querySelector('.app-brand__title');
    if (label && label.textContent !== title) label.textContent = title;
    const tag = document.querySelector('.app-brand__tag');
    if (tag && tag.textContent !== (rust ? 'Rust Edition' : 'Study Workspace')) tag.textContent = rust ? 'Rust Edition' : 'Study Workspace';
    const mark = document.querySelector('.app-brand__mark');
    if (mark && !mark.querySelector('img[data-wisp-mark]')) {
      const icon = document.createElement('img'); icon.src = new URL('../../public/wisp-icon.svg', import.meta.url).href;
      icon.alt = ''; icon.dataset.wispMark = 'true'; mark.replaceChildren(icon);
    }
    const bar = document.querySelector<HTMLElement>('.app-window-titlebar');
    if (rust && bar && bar.dataset.rustDrag !== 'true') {
      bar.dataset.rustDrag = 'true';
      bar.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !event.isPrimary || (event.target as Element).closest('button,input,select,textarea,a,[role=button]')) return;
        event.preventDefault();
        void (window as any).__RUST_HOST__.invoke('window:start-drag').catch(() => {});
      });
      bar.addEventListener('dblclick', event => {
        if (!(event.target as Element).closest('button,input,select,textarea,a,[role=button]')) void (window as any).__RUST_HOST__.invoke('window:maximize').catch(() => {});
      });
    }
    let icon = document.querySelector<HTMLLinkElement>('link[rel=icon]');
    if (!icon) { icon = document.createElement('link'); icon.rel = 'icon'; document.head.append(icon); }
    const href = new URL('../../public/wisp-icon.svg', import.meta.url).href;
    if (icon.href !== href) icon.href = href;
  };
  const queue = () => { if (!scheduled) { scheduled = true; requestAnimationFrame(refresh); } };
  if (document.documentElement) new MutationObserver(queue).observe(document.documentElement, { subtree: true, childList: true });
  addEventListener('DOMContentLoaded', queue, { once: true }); queue();
}

installBranding();
