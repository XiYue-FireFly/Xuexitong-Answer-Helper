// @ts-ignore -- generated before Rust builds; the original build never loads this module.
import { createFrozenHostPolicies } from '../../dist-rust-policies/policies';
import { getRustHost, type RustHostTransport } from './hostClient';

type Listener = (...args: any[]) => void;
type NativeResponse = { statusCode: number; statusMessage: string; headers: Record<string, string | string[]>; bytes: number[] };
type RawInvoke = <T = unknown>(command: string, payload?: unknown) => Promise<T>;

/** Minimal byte and event bindings required by the original Node HTTP helpers.
 * These implement transport APIs only; policy decisions remain extracted AST. */
export class PolicyBytes extends Uint8Array<ArrayBuffer> {
  static from(value: any, encoding: any = 'utf8', thisArg?: any): PolicyBytes {
    let bytes: Uint8Array;
    if (typeof encoding === 'function') bytes = Uint8Array.from(value, encoding, thisArg);
    else if (typeof value === 'string') {
      if (encoding === 'utf8') bytes = new TextEncoder().encode(value);
      else if (encoding === 'base64') {
        // Node Buffer accepts URL-safe base64, ignores non-alphabet characters
        // and decodes an incomplete final group without manufacturing bytes.
        let encoded = value.replace(/[^A-Za-z0-9+/=_-]/g, '').split('=')[0].replace(/-/g, '+').replace(/_/g, '/');
        if (encoded.length % 4 === 1) encoded = encoded.slice(0, -1);
        encoded += '='.repeat((4 - encoded.length % 4) % 4);
        const decoded = atob(encoded);
        bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
      } else throw new Error('Unsupported policy byte encoding');
    } else if (value instanceof Uint8Array || Array.isArray(value)) bytes = new Uint8Array(value);
    else throw new Error('Unsupported policy byte input');
    const result = new PolicyBytes(new ArrayBuffer(bytes.length)); result.set(bytes); return result;
  }
  static isBuffer(value: unknown): value is PolicyBytes { return value instanceof PolicyBytes; }
  static concat(chunks: Uint8Array[]): PolicyBytes {
    const result = new PolicyBytes(new ArrayBuffer(chunks.reduce((size, bytes) => size + bytes.length, 0)));
    let offset = 0; for (const bytes of chunks) { result.set(bytes, offset); offset += bytes.length; } return result;
  }
  toString(encoding = 'utf8'): string {
    if (encoding === 'utf8') return new TextDecoder('utf-8', { ignoreBOM: true }).decode(this);
    if (encoding !== 'base64') throw new Error('Unsupported policy byte encoding');
    let value = ''; for (let offset = 0; offset < this.length; offset += 8192) value += String.fromCharCode(...this.subarray(offset, offset + 8192));
    return btoa(value);
  }
}

class Events {
  private listeners = new Map<string, Listener[]>();
  on(event: string, listener: Listener): this { this.listeners.set(event, [...this.listeners.get(event) || [], listener]); return this; }
  emit(event: string, ...args: unknown[]): void { for (const listener of this.listeners.get(event) || []) listener(...args); }
}

function httpBinding(invoke: RawInvoke) {
  const request = (input: string | URL, options: { method?: string; headers?: Record<string, string> }, receive: (response: Events & { statusCode: number; statusMessage: string; headers: NativeResponse['headers']; resume(): void }) => void, startImmediately = false) => {
    const emitter = new Events() as Events & { setTimeout(ms: number, callback: () => void): void; destroy(error: Error): void; write(bytes: Uint8Array): void; end(): void };
    const chunks: Uint8Array[] = [];
    let started = false, settled = false, timeoutMs = 15000, timeout: (() => void) | undefined;
    emitter.destroy = error => { if (settled) return; settled = true; emitter.emit('error', error); };
    // Node's socket timeout measures inactivity. Rust owns connection/read idle
    // deadlines; a JS wall-clock timer would truncate an active slow response.
    emitter.setTimeout = (ms, callback) => { timeoutMs = ms; timeout = callback; };
    emitter.write = bytes => { if (started) throw new Error('Cannot write an already started policy request'); chunks.push(PolicyBytes.from(bytes)); };
    emitter.end = () => {
      if (started) return; started = true;
      const body = chunks.length ? [...PolicyBytes.concat(chunks)] : null;
      void invoke<NativeResponse>('transport:http', { url: String(input), method: options.method || 'GET', headers: options.headers || {}, body, timeoutMs }).then(result => {
        if (settled) return;
        settled = true;
        if (!result || !Number.isInteger(result.statusCode) || typeof result.statusMessage !== 'string' || !result.headers || !Array.isArray(result.bytes)
          || result.bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error('Native policy HTTP response is invalid');
        const headers = Object.fromEntries(Object.entries(result.headers).map(([name, value]) => [name.toLowerCase(), value]));
        const response = Object.assign(new Events(), { statusCode: result.statusCode, statusMessage: result.statusMessage, headers, resume() {} });
        receive(response); response.emit('data', PolicyBytes.from(result.bytes)); response.emit('end');
      }).catch(error => {
        if (!settled && timeout && (error instanceof Error ? error.message : String(error)) === '接口请求超时。') timeout();
        else if (!settled) { settled = true; emitter.emit('error', error instanceof Error ? error : new Error(String(error))); }
        else emitter.emit('error', error instanceof Error ? error : new Error(String(error)));
      });
    };
    if (startImmediately) queueMicrotask(() => emitter.end());
    return emitter;
  };
  return { request, get: (input: string | URL, options: { headers?: Record<string, string> }, receive: Parameters<typeof request>[2]) => request(input, options, receive, true) };
}

export function createHostPolicyHandlers(invoke: RawInvoke) {
  const client = httpBinding(invoke);
  return createFrozenHostPolicies({ http: client, https: client, Buffer: PolicyBytes, app: { getVersion: () => '1.5.1' },
    writeUnknownError: (source: string) => { void invoke('diagnostics:error-log', { source, level: 'warn', message: 'Rust host policy request failed.' }).catch(() => {}); } }) as Map<string, (_event: unknown, payload?: unknown) => Promise<any>>;
}

const installed = new WeakSet<RustHostTransport>();
export function installHostPolicies(host = getRustHost()): void {
  if (installed.has(host)) return;
  const nativeInvoke: RawInvoke = host.invoke.bind(host), handlers = createHostPolicyHandlers(nativeInvoke);
  host.invoke = <T,>(command: string, payload?: unknown): Promise<T> => {
    const handler = handlers.get(command);
    return handler ? handler(undefined, payload) as Promise<T> : nativeInvoke<T>(command, payload);
  };
  installed.add(host);
}
