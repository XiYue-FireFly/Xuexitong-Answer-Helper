import { build } from 'esbuild';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyCoreFreeze } from './verify-core-freeze.mjs';
import { canonicalBytes, DOCUMENT_DIRECTORY, workspacePath } from './freeze-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedChannels = [
  'studypilot:snapshot', 'studypilot:web-document-request', 'studypilot:web-cancel-operation',
  'studypilot:extract-question', 'studypilot:execute-plan', 'studypilot:apply-answer',
  'studypilot:exam-next-question',
];
const slash = value => value.split(path.sep).join('/');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function inspectFrozenEntry(bytes, filename) {
  const source = ts.createSourceFile(filename, bytes.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const channels = [];
  let webFrameReferences = 0;
  function visit(node) {
    if (ts.isIdentifier(node) && node.text === 'webFrame') {
      webFrameReferences += 1;
      const allowed = ts.isImportSpecifier(node.parent)
        || (ts.isVoidExpression(node.parent) && node.parent.expression === node);
      if (!allowed) throw new Error('webFrame acquired behavior; the Rust placeholder requires re-audit');
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'ipcRenderer'
        && node.expression.name.text === 'on') {
      const channel = node.arguments[0];
      if (!channel || !ts.isStringLiteral(channel)) throw new Error('Dynamic guest receive channel requires re-audit');
      channels.push(channel.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (webFrameReferences !== 2 || JSON.stringify(channels) !== JSON.stringify(expectedChannels)) {
    throw new Error('Frozen preload registration/import contract changed; update the reviewed transport boundary');
  }
  return channels;
}

function inspectElectronImports(bytes, filename) {
  const source = ts.createSourceFile(filename, bytes.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== 'electron') continue;
    const clause = node.importClause;
    if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)
        || clause.namedBindings.elements.some(item => item.propertyName || !['ipcRenderer', 'webFrame'].includes(item.name.text))) {
      throw new Error(`Unsupported Electron import in ${filename}; only reviewed transport bindings may change`);
    }
  }
}

/** Return a callable JS function expression. Native installs it independently in
 * each actual frame/document, choosing its own generation and hook name. */
export async function buildRustPageBridge({ write = true, sourceRoot = root, outDir } = {}) {
  sourceRoot = path.resolve(sourceRoot);
  // The verifier reconstructs its trust anchor from immutable Git in THIS
  // script's repository, even when sourceRoot points at a temporary copy.
  const freeze = verifyCoreFreeze(sourceRoot);
  if (!freeze.ok) throw new Error(`Core freeze verification failed:\n${freeze.errors.join('\n')}`);
  const coreManifest = JSON.parse(await readFile(workspacePath(sourceRoot, `${DOCUMENT_DIRECTORY}/core-manifest.json`), 'utf8'));
  const frozenInputs = new Map(coreManifest.files.map(input => [input.path, input]));
  const compiledFrozenInputs = new Map();
  const entry = workspacePath(sourceRoot, 'electron/preload-webview.ts');
  const transport = slash(workspacePath(sourceRoot, 'src/desktop-rust/guestTransport.ts'));
  const original = await readFile(entry);
  const requestChannels = inspectFrozenEntry(original, entry);
  const outputPath = path.resolve(outDir || path.join(sourceRoot, 'dist-rust-bridge'), 'page-bridge.js');
  const result = await build({
    absWorkingDir: sourceRoot,
    stdin: {
      contents: `import ${JSON.stringify(slash(entry))};\nimport { markReady } from 'electron';\nmarkReady();`,
      resolveDir: sourceRoot, sourcefile: 'rust-page-bridge-entry.js', loader: 'js',
    },
    outfile: outputPath,
    bundle: true, platform: 'browser', target: 'es2020', format: 'iife',
    write: false, metafile: true, sourcemap: false, minify: false, legalComments: 'none', logLevel: 'silent',
    plugins: [{
      name: 'immutable-page-core-inputs',
      setup(plugin) {
        plugin.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: 'file' }, async args => {
          const relative = slash(path.relative(sourceRoot, args.path));
          const expected = frozenInputs.get(relative);
          if (!expected) return undefined;
          const bytes = await readFile(workspacePath(sourceRoot, relative));
          if (hash(canonicalBytes(bytes)) !== expected.canonicalSha256) {
            throw new Error(`Frozen bridge input changed before compilation: ${relative}`);
          }
          compiledFrozenInputs.set(relative, hash(bytes));
          const extension = path.extname(relative).slice(1);
          return { contents: bytes.toString('utf8'), loader: extension === 'tsx' ? 'tsx' : extension === 'jsx' ? 'jsx' : /[cm]?ts/.test(extension) ? 'ts' : 'js' };
        });
      },
    }, {
      name: 'reviewed-electron-transport-binding',
      setup(plugin) {
        plugin.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'rust-electron-transport' }));
        plugin.onLoad({ filter: /.*/, namespace: 'rust-electron-transport' }, () => ({
          contents: `import { createWebView2GuestTransport } from ${JSON.stringify(transport)};\n`
            + 'const transport = createWebView2GuestTransport(__STUDYPILOT_NATIVE_CONFIG__);\n'
            + 'export const ipcRenderer = transport.ipcRenderer;\nexport const webFrame = transport.webFrame;\n'
            + 'export const markReady = transport.markReady;\n',
          resolveDir: sourceRoot, loader: 'js',
        }));
      },
    }],
  });
  const bundle = result.outputFiles.find(file => file.path === outputPath);
  if (!bundle) throw new Error('Rust page bridge build produced no JavaScript');
  const inputs = [];
  for (const name of Object.keys(result.metafile.inputs).sort()) {
    if (name.startsWith('rust-electron-transport:') || name === 'rust-page-bridge-entry.js') continue;
    const filename = path.resolve(sourceRoot, name);
    const bytes = await readFile(filename);
    const relative = slash(path.relative(sourceRoot, filename));
    const expected = frozenInputs.get(relative);
    if (expected && (hash(canonicalBytes(bytes)) !== expected.canonicalSha256 || compiledFrozenInputs.get(relative) !== hash(bytes))) {
      throw new Error(`Frozen bridge input was not verified or changed during compilation: ${relative}`);
    }
    inspectElectronImports(bytes, filename);
    inputs.push({ path: relative, sha256: hash(bytes), bytes: bytes.length,
      ...(expected ? { canonicalSha256: expected.canonicalSha256, frozen: true } : {}) });
  }
  if (!original.equals(await readFile(entry))) throw new Error('Frozen entry changed during the bridge build');
  const factorySource = `(function(__STUDYPILOT_NATIVE_CONFIG__) {\n${bundle.text}\n})\n`;
  const manifest = {
    schemaVersion: 1, protocol: 'studypilot-rust-page-v1', entry: 'electron/preload-webview.ts',
    entrySha256: hash(original), factorySha256: hash(factorySource), sourceMaps: false,
    output: 'dist-rust-bridge/page-bridge.js', requestChannels, inputs,
    coreFreeze: { baselineCommit: freeze.baselineCommit, files: freeze.files, symbols: freeze.symbols, verifiedBeforeBuild: true },
    bindingChanges: ['electron ipcRenderer.on/sendToHost', 'unused webFrame placeholder'],
    identityAuthority: 'Native WebView2 sender/frame/current-document registry; JavaScript fields are untrusted',
  };
  if (write) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, factorySource, 'utf8');
    await writeFile(path.join(path.dirname(outputPath), 'page-bridge.manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }
  return { factorySource, manifest, outputPath };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await buildRustPageBridge();
    console.log(`Built ${slash(path.relative(root, result.outputPath))} from ${result.manifest.inputs.length} unchanged source inputs`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
