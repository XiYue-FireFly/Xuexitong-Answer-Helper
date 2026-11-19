export type Unlisten = () => void;

/** The trusted local UI bridge. Remote guest pages never receive this object. */
export interface RustHostTransport {
  identity: 'rust';
  invoke<T = unknown>(command: string, payload?: unknown): Promise<T>;
  listen<T = unknown>(event: string, callback: (payload: T) => void): Unlisten | Promise<Unlisten>;
}

declare global {
  interface Window { __RUST_HOST__?: RustHostTransport }
}

export function isRustDesktopHost(): boolean {
  return typeof window !== 'undefined' && window.__RUST_HOST__?.identity === 'rust'
    && typeof window.__RUST_HOST__.invoke === 'function' && typeof window.__RUST_HOST__.listen === 'function';
}

export function getRustHost(): RustHostTransport {
  installTauriTransport();
  if (!isRustDesktopHost()) throw new Error('Rust 桌面宿主尚未连接。');
  return window.__RUST_HOST__!;
}

/** Called only from the local UI entry. The native host grants no guest capability. */
export function installTauriTransport(): void {
  if (typeof window === 'undefined' || window.__RUST_HOST__) return;
  const tauri = (window as Window & { __TAURI__?: {
    core?: { invoke: <T>(command: string, payload: unknown) => Promise<T> };
    event?: { listen: <T>(event: string, callback: (event: { payload: T }) => void) => Promise<Unlisten> };
  } }).__TAURI__;
  if (!tauri?.core?.invoke || !tauri?.event?.listen) return;
  window.__RUST_HOST__ = {
    identity: 'rust',
    invoke: <T,>(command: string, payload?: unknown) => tauri.core!.invoke<T>('desktop_host', { command, payload: payload ?? null }),
    listen: <T,>(event: string, callback: (payload: T) => void) => tauri.event!.listen<T>(event, event => callback(event.payload))
  };
}

export interface GuestSnapshot {
  guestId: number;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  documentGeneration: number;
}

export interface GuestBounds { x: number; y: number; width: number; height: number }
export interface GuestHostEvent {
  instanceId: string;
  guestId: number;
  documentGeneration: number;
  event: string;
  snapshot?: GuestSnapshot;
  properties?: Record<string, unknown>;
}

export type GuestAction = 'loadURL' | 'reload' | 'stop' | 'goBack' | 'goForward' | 'focus'
  | 'executeJavaScript' | 'send' | 'sendInputEvent';

export interface GuestCreateRequest {
  instanceId: string;
  url: string;
  partition?: string;
  preload?: string;
  webPreferences?: string;
  bounds: GuestBounds;
  active: boolean;
}
