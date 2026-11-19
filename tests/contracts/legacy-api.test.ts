import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

afterEach(() => vi.unstubAllGlobals());

function bridge() {
  const callbacks = new Map<string, (payload: unknown) => void>();
  const unlisten = vi.fn();
  const invoke = vi.fn(async (_channel: string, _payload?: unknown): Promise<unknown> => ({ success: true }));
  const listen = vi.fn(async (channel: string, callback: (payload: unknown) => void) => {
    callbacks.set(channel, callback);
    return () => { callbacks.delete(channel); unlisten(channel); };
  });
  const target = Object.assign(new EventTarget(), { __RUST_HOST__: { identity: 'rust', invoke, listen } });
  vi.stubGlobal('window', target);
  return { target: target as typeof target & { electronAPI: any }, callbacks, unlisten, invoke, listen };
}

describe('Rust legacy desktop facade', () => {
  it('installs exactly the frozen 34 methods and forwards every invocation without changing business payloads', async () => {
    const host = bridge();
    const { installLegacyApi } = await import('../../src/desktop-rust/legacyApi');
    const api = await installLegacyApi();
    const contract = JSON.parse(readFileSync('docs/migrations/rust-host/api-contract.json', 'utf8'));
    expect(Object.keys(api).sort()).toEqual(contract.methods.map((method: any) => method.name).sort());
    expect(host.target.electronAPI).toBe(api);
    const payload = { source: 'github', entries: [{ question: 'fixture' }] };
    for (const method of contract.methods) {
      const binding = method.bindings[0];
      if (binding.kind === 'on') continue;
      const args = method.name === 'notify' ? ['title', 'body'] : method.name === 'log' ? ['warn', 'message'] : method.parameters.length ? [payload] : [];
      await (api as any)[method.name](...args);
      expect(host.invoke).toHaveBeenLastCalledWith(binding.channel, method.name === 'notify' ? { title: 'title', body: 'body' } : method.name === 'log' ? { level: 'warn', message: 'message' } : args[0]);
    }
  });

  it('subscribes before exposing the facade and preserves chunks, concurrent request identities and unsubscribe isolation', async () => {
    const host = bridge();
    const { installLegacyApi } = await import('../../src/desktop-rust/legacyApi');
    const api = await installLegacyApi();
    expect(host.listen).toHaveBeenCalledTimes(4);
    const first = vi.fn(), second = vi.fn();
    const stop = api.onAIChatChunk(first);
    api.onAIChatChunk(second);
    host.callbacks.get('ai:chat-chunk')!({ requestId: 'two', chunk: 'data: 中\n' });
    host.callbacks.get('ai:chat-chunk')!({ requestId: 'one', chunk: '\ndata: [DONE]\n\n' });
    stop(); stop();
    host.callbacks.get('ai:chat-chunk')!({ requestId: 'two', chunk: 'last' });
    expect(first.mock.calls.map(call => call[0].requestId)).toEqual(['two', 'one']);
    expect(second).toHaveBeenCalledTimes(3);
    expect(host.unlisten).not.toHaveBeenCalled();
    expect(await installLegacyApi()).toBe(api);
    expect(host.listen).toHaveBeenCalledTimes(4);
    host.target.dispatchEvent(new Event('pagehide'));
    expect(host.unlisten).toHaveBeenCalledTimes(4);
    expect(host.callbacks.size).toBe(0);
  });

  it('keeps failure payloads and rejected invocations observable and never logs credentials for one-way errors', async () => {
    const host = bridge();
    const { installLegacyApi } = await import('../../src/desktop-rust/legacyApi');
    const api = await installLegacyApi();
    const failure = { success: false, error: 'not implemented: cloud-bank:list' };
    host.invoke.mockResolvedValueOnce(failure);
    expect(await api.listCloudQuestionBanks('github')).toBe(failure);
    host.invoke.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(api.getSettings()).rejects.toThrow('network unavailable');
    const hostError = vi.fn();
    host.target.addEventListener('rust-host-error', hostError);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      host.invoke.mockRejectedValueOnce(new Error('Bearer secret-fixture-token'));
      expect(api.recordError({ message: 'fixture' })).toBeUndefined();
      await Promise.resolve(); await Promise.resolve();
      expect(hostError).toHaveBeenCalledOnce();
      expect(JSON.stringify(hostError.mock.calls[0][0].detail)).not.toContain('secret-fixture-token');
      expect(log).not.toHaveBeenCalled();
      host.invoke.mockResolvedValueOnce({ success: false, error: 'unsupported' });
      api.minimize();
      await Promise.resolve(); await Promise.resolve();
      expect(hostError).toHaveBeenCalledTimes(2);
    } finally { log.mockRestore(); }
  });

  it('rolls back partial subscriptions and leaves no facade when host registration fails', async () => {
    const host = bridge();
    host.listen.mockImplementationOnce(async () => () => host.unlisten('first'));
    host.listen.mockRejectedValueOnce(new Error('event transport unavailable'));
    const { installLegacyApi } = await import('../../src/desktop-rust/legacyApi');
    await expect(installLegacyApi()).rejects.toThrow('event transport unavailable');
    expect(host.target.electronAPI).toBeUndefined();
    expect(host.unlisten).toHaveBeenCalledWith('first');
    host.target.__RUST_HOST__.identity = 'electron';
    await expect(installLegacyApi()).rejects.toThrow(/Rust host/);
  });

  it('releases a late registration when the UI leaves during async installation', async () => {
    const host = bridge();
    let complete!: (release: () => void) => void;
    host.listen.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const { installLegacyApi } = await import('../../src/desktop-rust/legacyApi');
    const installation = installLegacyApi();
    host.target.dispatchEvent(new Event('pagehide'));
    complete(() => host.unlisten('late'));
    await expect(installation).rejects.toThrow(/disposed/);
    expect(host.unlisten).toHaveBeenCalledWith('late');
    expect(host.target.electronAPI).toBeUndefined();
    expect(host.listen).toHaveBeenCalledOnce();
  });
});
