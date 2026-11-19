import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { BASELINE_COMMIT, canonicalBytes, sha256 } from './freeze-core.mjs';
import { verifyCoreFreeze } from './verify-core-freeze.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const POLICY_CHANNELS = ['ai:discover-models', 'cloud-bank:list', 'cloud-bank:download', 'cloud-bank:upload'];
const FUNCTIONS = ['maskDisplayName', 'safeSlug', 'normalizeCloudBankManifest', 'cloudRepo', 'safeParseJson',
  'modelDiscoveryUrl', 'parseModelIds', 'createRequestHeaders', 'fetchText', 'fetchRepoContent', 'requestJson', 'writeRepoContent'];

export function extractHostPolicies(source) {
  const manifest = JSON.parse(readFileSync(path.join(root, 'docs/migrations/rust-host/core-manifest.json'), 'utf8'));
  if (sha256(canonicalBytes(Buffer.from(source))) !== manifest.files.find(file => file.path === 'electron/main.ts').canonicalSha256) throw new Error('Frozen host policy source changed');
  const ast = ts.createSourceFile('electron/main.ts', source, ts.ScriptTarget.Latest, true);
  const selected = [], handlers = new Map();
  for (const name of ['CLOUD_QUESTION_BANK_REPOS', ...FUNCTIONS]) {
    const nodes = ast.statements.flatMap(statement => ts.isVariableStatement(statement) ? statement.declarationList.declarations.filter(declaration => declaration.name.getText(ast) === name) : ts.isFunctionDeclaration(statement) && statement.name?.text === name ? [statement] : []);
    if (nodes.length !== 1) throw new Error(`Frozen policy symbol count mismatch: ${name}`);
    const node = nodes[0], original = node.getText(ast);
    selected.push({ name, original, declaration: ts.isVariableDeclaration(node) ? `const ${original};` : original, sha256: sha256(canonicalBytes(Buffer.from(original))) });
  }
  for (const statement of ast.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (call.expression.getText(ast) !== 'ipcMain.handle' || !call.arguments[0] || !ts.isStringLiteralLike(call.arguments[0])) continue;
    const channel = call.arguments[0].text;
    if (!POLICY_CHANNELS.includes(channel)) continue;
    if (handlers.has(channel) || !call.arguments[1]) throw new Error(`Frozen handler count mismatch: ${channel}`);
    const original = call.arguments[1].getText(ast);
    handlers.set(channel, { channel, original, sha256: sha256(canonicalBytes(Buffer.from(original))) });
  }
  if (handlers.size !== POLICY_CHANNELS.length) throw new Error('Frozen host policy handler coverage mismatch');
  const generated = '// @ts-nocheck\n// Generated from immutable Electron policy AST. Do not edit.\n'
    + 'export function createFrozenHostPolicies(bindings: any) {\nconst { http, https, Buffer, app, writeUnknownError } = bindings;\n'
    + selected.map(symbol => symbol.declaration).join('\n\n')
    + '\nreturn new Map<string, (_event: any, payload?: any) => Promise<any>>([\n'
    + [...handlers.values()].map(handler => `[${JSON.stringify(handler.channel)}, ${handler.original}]`).join(',\n') + '\n]);\n}\n';
  return { source: generated, manifest: { schemaVersion: 1, baselineCommit: BASELINE_COMMIT, originalFile: 'electron/main.ts', sourceSha256: sha256(canonicalBytes(Buffer.from(source))), generatedSha256: sha256(Buffer.from(generated)),
    bindings: ['http.get/request', 'https.get/request', 'Buffer UTF-8/base64 bytes only', 'app.getVersion', 'writeUnknownError diagnostics binding'],
    symbols: selected.map(({ name, sha256 }) => ({ name, sha256 })), handlers: [...handlers.values()].map(({ channel, sha256 }) => ({ channel, sha256 })),
    policy: 'Original AST text is copied without modification. Network redirect/auth/error rules and cloud write ordering execute the original JavaScript. No update/install handler is included.' } };
}

export function buildHostPolicies({ write = true, verify = true } = {}) {
  if (verify) { const result = verifyCoreFreeze(root); if (!result.ok) throw new Error(`Core freeze failed: ${result.errors.join('; ')}`); }
  const built = extractHostPolicies(readFileSync(path.join(root, 'electron/main.ts'), 'utf8'));
  if (write) {
    const directory = path.join(root, 'dist-rust-policies'); mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'policies.ts'), built.source);
    writeFileSync(path.join(directory, 'policies.manifest.json'), JSON.stringify(built.manifest, null, 2) + '\n');
  }
  return built;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = buildHostPolicies();
  console.log(`Extracted ${built.manifest.handlers.length} original handlers and ${built.manifest.symbols.length} policy declarations`);
}
