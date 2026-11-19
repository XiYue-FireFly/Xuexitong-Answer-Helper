import { describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Dynamic ESM loading preserves the same verifier used by the command line.
const root = process.cwd();
const loadVerifier = () => import('../../scripts/verify-core-freeze.mjs');
const documentRoot = 'docs/migrations/rust-host';
const manifest = JSON.parse(readFileSync(path.join(root, documentRoot, 'core-manifest.json'), 'utf8'));

async function temporaryBaseline() {
  const { workspacePath } = await import('../../scripts/freeze-core.mjs');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'studypilot-core-freeze-'));
  for (const entry of [...manifest.files, ...['baseline', 'core-manifest', 'symbol-boundary', 'api-contract'].map(name => ({ path: `${documentRoot}/${name}.json` }))]) {
    const source = workspacePath(root, entry.path), target = workspacePath(directory, entry.path);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target);
  }
  return directory;
}

describe('reviewed Rust host core freeze', () => {
  it('records legacy JSON, SSE byte chunks and request cleanup using the original AST handler', async () => {
    const source = readFileSync(path.join(root, 'electron/main.ts'), 'utf8');
    const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
    let handler: ts.Expression | undefined;
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'ipcMain.handle' && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'ai:chat') handler = node.arguments[1];
      ts.forEachChild(node, visit);
    }
    visit(ast);
    expect(handler).toBeTruthy();
    const script = ts.transpile(`const handler = ${handler!.getText(ast)}; handler`, { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None });
    async function scenario(contentType: string, buffers: Buffer[], statusCode = 200, timeout = false, destroyed = false) {
      const sent: unknown[] = [], lifecycle: string[] = [];
      let requestedUrl = '', timeoutMs = 0;
      const client = { request: (url: URL, _options: unknown, receive: Function) => {
        requestedUrl = url.href;
        const request = new EventEmitter() as any;
        request.setTimeout = (ms: number, callback: Function) => { timeoutMs = ms; request.timeout = callback; };
        request.write = () => lifecycle.push('write');
        request.destroy = (error: Error) => { lifecycle.push('destroy'); request.emit('error', error); };
        request.end = () => {
          lifecycle.push('end');
          if (timeout) { request.timeout(); return; }
          const response = new EventEmitter() as any;
          response.statusCode = statusCode; response.headers = { 'content-type': contentType };
          receive(response);
          for (const buffer of buffers) response.emit('data', buffer);
          response.emit('end');
        };
        return request;
      } };
      const invoke = runInNewContext(script, { URL, Buffer, http: client, https: client, app: { getVersion: () => '1.5.1' } });
      const result = await invoke({ sender: { isDestroyed: () => destroyed, send: (_channel: string, payload: unknown) => sent.push(payload) } }, { baseUrl: 'https://fixture.test/v1/', stream: true, requestId: 'fixture-one', timeoutMs: 1, body: { model: 'fixture', messages: [] } });
      return { requestedUrl, timeoutMs, lifecycle, sent, result };
    }
    const json = await scenario('application/json', [Buffer.from('{"choices":'), Buffer.from('[]}')]);
    expect(json).toMatchObject({ requestedUrl: 'https://fixture.test/v1/chat/completions', timeoutMs: 5000, sent: [], result: { success: true, statusCode: 200, text: '{"choices":[]}', json: true } });
    const sse = await scenario('text/event-stream', [Buffer.from('data: {"x":1}\n'), Buffer.from('\ndata: [DONE]\n\n')]);
    expect(sse).toMatchObject({ sent: [{ requestId: 'fixture-one', chunk: 'data: {"x":1}\n' }, { requestId: 'fixture-one', chunk: '\ndata: [DONE]\n\n' }], result: { success: true, statusCode: 200, streamed: true } });
    const bytes = Buffer.from('中');
    const splitUtf8 = await scenario('text/event-stream', [bytes.subarray(0, 1), bytes.subarray(1)]);
    expect((splitUtf8.sent as any[]).map(item => item.chunk).join('')).toBe('���');
    const failed = await scenario('application/json', [Buffer.from('unavailable')], 503);
    expect(failed.result).toMatchObject({ success: false, statusCode: 503, error: '接口返回 503：unavailable' });
    const deadline = await scenario('text/event-stream', [], 200, true);
    expect(deadline).toMatchObject({ lifecycle: ['write', 'end', 'destroy'], result: { success: false, error: 'AI 接口请求超时。' } });
    const closedSender = await scenario('text/event-stream', [Buffer.from('data: [DONE]\n\n')], 200, false, true);
    expect(closedSender.sent).toEqual([]);
    expect(closedSender.result).toMatchObject({ success: true, streamed: true });
    const out = path.join(root, '.playwright-mcp/rust-baseline');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'transport-fixtures.json'), JSON.stringify({ extractedFrom: 'electron/main.ts:ai:chat', baselineCommit: '402dd25553185f39df56ca0014a1916a58c57a8e', json, sse, splitUtf8, failed, deadline, closedSender, knownDefects: { 'LEGACY-AI-UTF8-001': { observation: splitUtf8, desiredText: '中', status: 'known-defect-not-desired-new-host-semantics', decision: 'docs/migrations/rust-host/api-contract.json#/compatibilityDecisions/LEGACY-AI-UTF8-001', requiredBefore: ['R5', 'G4'] } } }, null, 2) + '\n');
  });

  it('verifies the real workspace and complete legacy facade inventory', async () => {
    const { verifyCoreFreeze } = await loadVerifier();
    expect(verifyCoreFreeze(root)).toMatchObject({ ok: true, errors: [] });
    const api = JSON.parse(readFileSync(path.join(root, documentRoot, 'api-contract.json'), 'utf8'));
    expect(api.counts).toEqual({ preloadMethods: 34, requestHandlers: 25, oneWayEvents: 5, pageRequests: 7 });
    expect(api.methods.every((method: any) => method.release && method.bindings.length)).toBe(true);
    expect(api.requestHandlers.every((handler: any) => handler.release && !handler.release.startsWith('Unclassified'))).toBe(true);
    const chat = api.requestHandlers.find((handler: any) => handler.channel === 'ai:chat');
    expect(chat.referencedFunctions.some((symbol: any) => symbol.name === 'finish' && symbol.file === 'electron/main.ts' && symbol.line === 1434)).toBe(true);
    expect(chat.referencedFunctions.some((symbol: any) => symbol.file === 'electron/web-ai-task-resources.ts' || symbol.name === 'abort')).toBe(false);
    expect(chat.deliveries.some((delivery: string) => delivery.includes('resolve(media'))).toBe(false);
    expect(chat.deliveries).toContain('resolve(result)');
    expect(api.compatibilityDecisions['LEGACY-AI-UTF8-001']).toMatchObject({ kind: 'known-defect', status: 'explicit-decision-required-before-R5-and-G4' });
    expect(manifest.dependencyEdges).toContainEqual({ from: 'src/answerActivity/AnswerActivityLayer.tsx', specifier: './assets/crying-pixel-cat.png', to: 'src/answerActivity/assets/crying-pixel-cat.png' });
  }, 60000);

  it('resolves shadowed and imported helpers by lexical symbol and rejects ambiguous implementations', async () => {
    const { createFunctionResolver } = await import('../../scripts/freeze-core.mjs');
    const fixture = new Map([
      ['helper.ts', "export function finish() { return 'imported'; }"],
      ['other.ts', "export function finish() { return 'unrelated'; }"],
      ['entry.ts', "import { finish as importedFinish } from './helper'; export function run() { const finish = () => 'local'; return [finish(), importedFinish()]; }"]
    ]);
    const resolver = createFunctionResolver((file: string) => Buffer.from(fixture.get(file)!), [...fixture.keys()]);
    const resolved: any[] = [];
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) for (const implementation of resolver.resolve(node.expression)) resolved.push(resolver.describe(implementation));
      ts.forEachChild(node, visit);
    }
    visit(resolver.ast('entry.ts'));
    expect(resolved.map(symbol => ({ file: symbol.file, name: symbol.name }))).toEqual([{ file: 'entry.ts', name: 'finish' }, { file: 'helper.ts', name: 'finish' }]);
    const ambiguous = createFunctionResolver(() => Buffer.from('function finish() { return 1; } function finish() { return 2; } finish();'), ['ambiguous.ts']);
    const call = ambiguous.ast('ambiguous.ts').statements.at(-1) as ts.ExpressionStatement;
    expect(() => ambiguous.resolve((call.expression as ts.CallExpression).expression)).toThrow(/Ambiguous function implementation/);
  });

  it('rejects a changed answer-matching rule in a temporary copy and preserves the original', async () => {
    const { verifyCoreFreeze } = await loadVerifier();
    const directory = await temporaryBaseline();
    try {
      const entry = manifest.files.find((item: any) => item.path === 'electron/preload-webview/answer-matcher.ts');
      expect(entry, 'matching implementation must be inside the dependency closure').toBeTruthy();
      const file = path.join(directory, entry.path), original = readFileSync(file, 'utf8');
      // A real operator mutation changes matching semantics, not just a comment.
      const mutated = original.replace(/===|>=|<=|!==/, operator => ({ '===': '!==', '>=': '<', '<=': '>', '!==': '===' })[operator]!);
      expect(mutated).not.toBe(original);
      writeFileSync(file, mutated);
      const rejectedCopy = verifyCoreFreeze(directory), originalWorkspace = verifyCoreFreeze(root);
      expect(rejectedCopy).toMatchObject({ ok: false, errors: expect.arrayContaining([`Frozen source changed: ${entry.path}`]) });
      expect(originalWorkspace.ok).toBe(true);
      const output = path.join(root, '.playwright-mcp/rust-baseline');
      mkdirSync(output, { recursive: true });
      writeFileSync(path.join(output, 'mutation-result.json'), JSON.stringify({ mutation: 'First equality/comparison operator in original answer-matcher replaced in a temporary copy only', file: entry.path, rejectedCopy, originalWorkspace }, null, 2) + '\n');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('accepts checkout CRLF conversion while rejecting deletion and new unreviewed business code', async () => {
    const { verifyCoreFreeze } = await loadVerifier();
    const directory = await temporaryBaseline();
    try {
      for (const entry of manifest.files.filter((item: any) => /\.[cm]?[jt]sx?$/.test(item.path))) {
        const file = path.join(directory, entry.path);
        writeFileSync(file, readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
      }
      expect(verifyCoreFreeze(directory).errors).toEqual([]);
      const asset = manifest.files.find((entry: any) => entry.path.endsWith('.png')).path;
      const bytes = readFileSync(path.join(directory, asset));
      bytes[100] ^= 1;
      writeFileSync(path.join(directory, asset), bytes);
      const missing = manifest.files.find((entry: any) => entry.path.startsWith('src/webAI/')).path;
      rmSync(path.join(directory, missing));
      writeFileSync(path.join(directory, 'src/webAI/unreviewed-policy.ts'), 'export const bypass = true;\n');
      const result = verifyCoreFreeze(directory);
      expect(result.ok).toBe(false);
      expect(result.errors).toContain(`Frozen source missing: ${missing}`);
      expect(result.errors).toContain(`Frozen source changed: ${asset}`);
      expect(result.errors).toContain('Unreviewed file inside frozen business directory: src/webAI/unreviewed-policy.ts');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects coordinated source, manifest and self-reported digest tampering against immutable Git', async () => {
    const { verifyCoreFreeze } = await loadVerifier();
    const { canonicalBytes, sha256, workspacePath } = await import('../../scripts/freeze-core.mjs');
    const directory = await temporaryBaseline();
    try {
      const manifestFile = workspacePath(directory, `${documentRoot}/core-manifest.json`), baselineFile = workspacePath(directory, `${documentRoot}/baseline.json`);
      const forgedManifest = JSON.parse(readFileSync(manifestFile, 'utf8')), forgedBaseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
      const entry = forgedManifest.files.find((item: any) => item.path === 'electron/preload-webview/answer-matcher.ts');
      const coreFile = workspacePath(directory, entry.path), source = readFileSync(coreFile, 'utf8');
      const changed = Buffer.from(source.replace('===', '!=='));
      expect(changed.toString()).not.toBe(source);
      writeFileSync(coreFile, changed);
      entry.sha256 = sha256(changed); entry.canonicalSha256 = sha256(canonicalBytes(changed));
      forgedBaseline.documentHashes.coreManifest = sha256(JSON.stringify(forgedManifest));
      writeFileSync(manifestFile, JSON.stringify(forgedManifest)); writeFileSync(baselineFile, JSON.stringify(forgedBaseline));
      const result = verifyCoreFreeze(directory);
      expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining(['Immutable Git baseline mismatch: core-manifest.json', 'Immutable Git baseline mismatch: baseline.json']) });
      writeFileSync(path.join(root, '.playwright-mcp/rust-baseline/coordinated-tamper-result.json'), JSON.stringify(result, null, 2) + '\n');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects traversal, absolute paths and escaping junctions before manifest reads or fixture copies', async () => {
    const { verifyCoreFreeze } = await loadVerifier();
    const { workspacePath } = await import('../../scripts/freeze-core.mjs');
    const directory = await temporaryBaseline(), outside = mkdtempSync(path.join(os.tmpdir(), 'studypilot-outside-'));
    try {
      for (const value of ['../outside', '/absolute', 'C:/Windows/file', 'src/../../outside', 'src\\outside', 'src//file', 'src/./file']) expect(() => workspacePath(directory, value)).toThrow(/Unsafe workspace path/);
      symlinkSync(outside, path.join(directory, 'escape'), 'junction');
      expect(() => workspacePath(directory, 'escape/file')).toThrow(/escapes through symlink or junction/);
      const manifestFile = workspacePath(directory, `${documentRoot}/core-manifest.json`), forged = JSON.parse(readFileSync(manifestFile, 'utf8'));
      forged.files[0].path = '../outside';
      writeFileSync(manifestFile, JSON.stringify(forged));
      expect(verifyCoreFreeze(directory)).toMatchObject({ ok: false, errors: ['Immutable Git baseline mismatch: core-manifest.json'] });
    } finally { rmSync(directory, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });
});
