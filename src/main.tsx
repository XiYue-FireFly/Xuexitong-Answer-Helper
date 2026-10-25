import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Detect Android at startup; import the mobile bundle only when needed so the
// desktop bundle stays unaffected.
const isAndroid =
  typeof window !== 'undefined' &&
  (window as any).Capacitor?.getPlatform?.() === 'android';

async function boot() {
  let Root: React.ComponentType;
  if (isAndroid) {
    const { default: MobileApp } = await import('./MobileApp');
    // @ts-ignore — Vite handles CSS dynamic imports at runtime
    await import('./mobile.css');
    Root = MobileApp;
  } else {
    Root = App;
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>
  );
}

void boot();
