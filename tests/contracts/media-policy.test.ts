import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';

describe('frozen Rust media policy extraction', () => {
  it('keeps exact original function AST and rejects changed selectors before generating output', async () => {
    const { extractMediaPolicy } = await import('../../scripts/build-rust-media-policy.mjs');
    const original = readFileSync('electron/web-ai-task-resources.ts', 'utf8');
    const extracted = extractMediaPolicy(original);
    expect(extracted.manifest.symbols.map((symbol: any) => symbol.name)).toEqual(['inspectSourceMedia', 'readDocumentImage', 'installNavigationIntent']);
    const { BASELINE_COMMIT } = await import('../../scripts/freeze-core.mjs');
    expect(extracted.manifest.baselineCommit).toBe(BASELINE_COMMIT);
    for (const symbol of extracted.manifest.symbols) {
      const originalAst = ts.createSourceFile('original.ts', original, ts.ScriptTarget.Latest, true);
      const declaration = originalAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === symbol.name)!;
      expect(symbol.original).toBe(declaration.getText(originalAst));
    }
    expect(() => extractMediaPolicy(original.replace('.questionLi,', '.changed-selector,'))).toThrow(/Frozen media/);
  });

  it('runs original source-document and byte-limit checks with unchanged arguments and cleanup', async () => {
    const { extractMediaPolicy } = await import('../../scripts/build-rust-media-policy.mjs');
    const extracted = extractMediaPolicy(readFileSync('electron/web-ai-task-resources.ts', 'utf8'));
    const cancel = vi.fn(), clear = vi.fn();
    const fetch = vi.fn(async () => ({ ok: true, headers: new Headers({ 'content-type': 'image/png; fixture=true' }), body: { getReader: () => ({ read: vi.fn().mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) }).mockResolvedValue({ done: true }), cancel }) } }));
    const context = createContext({ window: { __studyPilotTaskNavigation: { documentId: 'current-document' } }, document: { querySelector: () => { throw new Error('must not inspect wrong document'); } }, AbortController, setTimeout: () => 123, clearTimeout: clear, fetch, URL, URLSearchParams });
    const policy = runInContext(`(${extracted.factorySource})()`, context);
    expect(policy.inspectSourceMedia('#image', undefined, 'stale-document')).toEqual({ error: '来源网页文档已改变' });
    expect(await policy.readDocumentImage('blob:fixture', 3, 500)).toEqual({ bytes: [1, 2, 3], mime: 'image/png' });
    expect(await policy.readDocumentImage('blob:fixture', 2, 500)).toEqual({ error: '单张图片超过 8 MiB' });
    expect(fetch).toHaveBeenLastCalledWith('blob:fixture', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it('routes lease, read and release payloads unchanged through registered native media commands', async () => {
    const { createMediaPolicy, installMediaPolicy } = await import('../../src/desktop-rust/mediaPolicy');
    const invoke = vi.fn(async (_command: string, _payload?: unknown): Promise<any> => ({ ok: true }));
    const api = createMediaPolicy({ identity: 'rust', invoke, listen: () => () => {} });
    const lease = { sessionId: 'session', sourceContentsId: 23, sourceUrl: 'https://fixture.test/question', aiContentsId: 24 };
    const read = { sessionId: 'session', questionHash: 'question', mediaId: 'image', selector: '#source-image', sourceUrl: 'blob:fixture' };
    await api.leaseWebAITask(lease); expect(invoke).toHaveBeenLastCalledWith('media:lease', lease);
    await api.readQuestionMedia(read); expect(invoke).toHaveBeenLastCalledWith('media:read', read);
    await api.releaseWebAITask('session'); expect(invoke).toHaveBeenLastCalledWith('media:release', 'session');
    invoke.mockResolvedValueOnce({ ok: false, error: 'expired document' });
    expect(await api.readQuestionMedia(read)).toEqual({ ok: false, error: 'expired document' });
    invoke.mockRejectedValueOnce(new Error('native caller rejected'));
    await expect(api.leaseWebAITask(lease)).rejects.toThrow('native caller rejected');
    const host: any = { identity: 'rust', invoke, listen: () => () => {} };
    installMediaPolicy(host); installMediaPolicy(host);
    await host.invoke('web-ai:read-question-media', read);
    expect(invoke).toHaveBeenLastCalledWith('media:read', read);
    await host.invoke('settings:get');
    expect(invoke).toHaveBeenLastCalledWith('settings:get', undefined);
  });
});
