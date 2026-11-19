import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { RustHostTransport } from '../../src/desktop-rust/hostClient';

// Ordinary tests also work in a fresh checkout without generated Rust outputs.
const { buildHostPolicies } = await import('../../scripts/build-rust-host-policies-net.mjs');
buildHostPolicies({ verify: false });
const { createHostPolicyHandlers, installHostPolicies, PolicyBytes } = await import('../../src/desktop-rust/hostPolicies');

const response = (statusCode: number, value: unknown, headers: Record<string, string> = {}) => ({ statusCode, statusMessage: '', headers, bytes: [...new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))] });
afterEach(() => { vi.useRealTimers(); });

describe('frozen original model and cloud policies', () => {
  it('extracts original handler/dependency spans and fails on any core source mutation', async () => {
    const { extractHostPolicies } = await import('../../scripts/build-rust-host-policies-net.mjs');
    const source = readFileSync('electron/main.ts', 'utf8'), built = extractHostPolicies(source);
    expect(built.manifest.handlers.map((handler: any) => handler.channel)).toEqual(['ai:discover-models', 'cloud-bank:list', 'cloud-bank:download', 'cloud-bank:upload']);
    expect(built.manifest.symbols.map((symbol: any) => symbol.name)).toContain('normalizeCloudBankManifest');
    expect(built.source).toContain(".sort((left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id, undefined, { sensitivity: 'base' }))");
    expect(() => extractHostPolicies(source.replace('.slice(0, 500)', '.slice(0, 501)'))).toThrow('Frozen host policy source changed');
    expect(built.source).not.toContain("ipcMain.handle('app:check-update'");
  });

  it('retains original model URL, headers, validation, deduplication and redirect credential stripping', async () => {
    const requests: any[] = [];
    const invoke = vi.fn(async (_command, payload: any) => {
      requests.push(payload);
      if (requests.length === 1) return response(302, '', { location: 'https://other.test/v1/models' });
      return response(200, { data: [{ id: 'z' }, { id: 'A', owned_by: 'fixture' }, { id: 'a' }, { id: '' }] });
    });
    const handler = createHostPolicyHandlers(invoke as any).get('ai:discover-models')!;
    const result = await handler(null, { baseUrl: 'https://models.test/v1/chat/completions?secret=ignored#fragment', apiKey: 'private-key' });
    expect(result).toMatchObject({ success: true, endpoint: 'https://other.test/v1/models', models: [{ id: 'A', owner: 'fixture' }, { id: 'z', owner: '' }] });
    expect(requests[0]).toMatchObject({ url: 'https://models.test/v1/models', method: 'GET', timeoutMs: 15000, headers: { Authorization: 'Bearer private-key' } });
    expect(requests[1].headers).not.toHaveProperty('Authorization');
    expect(await handler(null, { baseUrl: 'file:///invalid' })).toMatchObject({ success: false, models: [], error: '只支持 http 或 https 的 Base URL。' });
  });

  it('retains manifest path filtering and cloud downloads without writing local data', async () => {
    const invoke = vi.fn(async (_command, payload: any) => payload.url.includes('manifest.json') ? response(200, { updatedAt: 'today', banks: [{ id: 'a', name: 'fixture', path: 'banks/a.json', author: '张三' }, { path: '../unsafe.json' }] }) : response(200, { entries: [{ question: '中文', answer: 'A' }], meta: { fixture: true } }));
    const handlers = createHostPolicyHandlers(invoke as any);
    const listed = await handlers.get('cloud-bank:list')!(null, 'github');
    expect(listed.banks).toHaveLength(1); expect(listed.banks[0]).toMatchObject({ path: 'banks/a.json', author: '张*' });
    expect(await handlers.get('cloud-bank:download')!(null, { path: 'banks/a.json' })).toMatchObject({ success: true, entries: [{ question: '中文', answer: 'A' }], meta: { fixture: true } });
    expect(await handlers.get('cloud-bank:download')!(null, { path: '../private.json' })).toEqual({ success: false, error: '云端题库路径不合法。' });
    expect(invoke.mock.calls.filter(([command]) => command === 'transport:http').every(([, payload]: any) => payload.method === 'GET')).toBe(true);
  });

  it('never writes after a failed manifest read and preserves bank-before-manifest upload order', async () => {
    const failedCalls: any[] = [];
    const failed = createHostPolicyHandlers((async (command: string, payload: any) => { failedCalls.push({ command, payload }); return response(503, 'unavailable'); }) as any);
    const payload = { source: 'github', token: 'private', name: '本地题库', author: '张三', entries: [{ question: '你好', answer: '世界' }] };
    expect(await failed.get('cloud-bank:upload')!(null, payload)).toMatchObject({ success: false });
    expect(failedCalls.filter(call => call.command === 'transport:http')).toHaveLength(1);
    expect(failedCalls.some(call => call.command === 'transport:http' && call.payload.method !== 'GET')).toBe(false);
    const calls: any[] = [];
    const success = createHostPolicyHandlers((async (command: string, request: any) => {
      if (command !== 'transport:http') return null;
      calls.push(request);
      return request.method === 'GET' ? response(404, '') : response(200, { content: { sha: 'written' } });
    }) as any);
    expect(await success.get('cloud-bank:upload')!(null, payload)).toMatchObject({ success: true, name: payload.name, count: 1 });
    const writes = calls.filter(call => call.method === 'PUT');
    expect(writes).toHaveLength(2); expect(writes[0].url).toMatch(/\/banks\/[^/]+\.json$/); expect(writes[1].url).toMatch(/\/manifest\.json$/);
    const first = JSON.parse(new TextDecoder().decode(new Uint8Array(writes[0].body)));
    expect(JSON.parse(PolicyBytes.from(first.content, 'base64').toString('utf8')).entries).toEqual(payload.entries);
  });

  it('delegates socket idle timeouts to Rust without adding a shorter total-response timer', async () => {
    vi.useFakeTimers();
    let reject: (reason: unknown) => void = () => {};
    const invoke = vi.fn(() => new Promise((_resolve, fail) => { reject = fail; }));
    const handlers = createHostPolicyHandlers(invoke as any);
    const promise = handlers.get('ai:discover-models')!(null, { baseUrl: 'https://models.test/v1' });
    let settled = false; void promise.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(20000);
    expect(settled).toBe(false);
    expect(invoke).toHaveBeenCalledWith('transport:http', expect.objectContaining({ timeoutMs: 15000 }));
    reject('接口请求超时。');
    expect(await promise).toMatchObject({ success: false, error: '接口请求超时。' });
  });

  it('decorates only registered policy handlers and preserves byte/base64 compatibility', async () => {
    const invoke = vi.fn(async () => ({ success: true }));
    const host = { identity: 'rust', invoke, listen: vi.fn() } as unknown as RustHostTransport;
    installHostPolicies(host); const decorated = host.invoke; installHostPolicies(host); expect(host.invoke).toBe(decorated);
    await host.invoke('app:check-update', { preview: true });
    expect(invoke).toHaveBeenCalledWith('app:check-update', { preview: true });
    const text = '中文🌕\n';
    expect(PolicyBytes.from(PolicyBytes.from(text).toString('base64'), 'base64').toString()).toBe(text);
    expect(PolicyBytes.concat([PolicyBytes.from('中'), PolicyBytes.from('文')]).toString()).toBe('中文');
    for (const encoded of ['a', 'aGVsbG8', 'aGVs% bG8=??', '-_8', 'aGVsbG8===']) expect([...PolicyBytes.from(encoded, 'base64')]).toEqual([...Buffer.from(encoded, 'base64')]);
    const bom = [0xef, 0xbb, 0xbf, 0x41];
    expect(PolicyBytes.from(bom).toString()).toBe(Buffer.from(bom).toString('utf8'));
  });
});
