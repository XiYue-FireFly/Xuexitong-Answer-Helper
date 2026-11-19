import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { BASELINE_COMMIT, astHash, canonicalBytes, sha256 } from './freeze-core.mjs';
import { verifyCoreFreeze } from './verify-core-freeze.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalFile = 'electron/web-ai-task-resources.ts';
const functions = ['inspectSourceMedia', 'readDocumentImage', 'installNavigationIntent'];

/** Only original declaration text is copied. Type erasure is the sole transform. */
export function extractMediaPolicy(source) {
  const original = execFileSync('git', ['-C', root, 'show', `${BASELINE_COMMIT}:${originalFile}`], { windowsHide: true });
  if (sha256(canonicalBytes(Buffer.from(source))) !== sha256(canonicalBytes(original))) throw new Error('Frozen media policy source changed');
  const ast = ts.createSourceFile(originalFile, source, ts.ScriptTarget.Latest, true);
  const symbols = functions.map(name => {
    const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name && node.body);
    if (declarations.length !== 1) throw new Error(`Frozen media symbol count mismatch: ${name}`);
    const node = declarations[0], original = node.getText(ast);
    return { name, original, sourceSha256: sha256(canonicalBytes(Buffer.from(original))), astSha256: astHash(node), line: ast.getLineAndCharacterOfPosition(node.getStart()).line + 1, endLine: ast.getLineAndCharacterOfPosition(node.end).line + 1 };
  });
  const types = ast.statements.filter(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'Inspection');
  if (types.length !== 1) throw new Error('Frozen media Inspection type count mismatch');
  const sourceText = types[0].getText(ast) + '\n\n' + symbols.map(symbol => symbol.original).join('\n\n');
  const compiled = ts.transpileModule(sourceText, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None, removeComments: false }, reportDiagnostics: true });
  if (compiled.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) throw new Error('Frozen media type erasure failed');
  const factorySource = `(function() {\n${compiled.outputText}\nreturn Object.freeze({ ${functions.join(', ')} });\n})\n`;
  return {
    factorySource,
    manifest: { schemaVersion: 1, baselineCommit: BASELINE_COMMIT, originalFile, sourceSha256: sha256(canonicalBytes(original)), factorySha256: sha256(Buffer.from(factorySource)), symbols,
      types: [{ name: 'Inspection', sourceSha256: sha256(canonicalBytes(Buffer.from(types[0].getText(ast)))) }],
      policy: 'Original DOM ownership/selectors, document/element identity, URL checks, image reader limits/timer cleanup and navigation intent execute unchanged in the actual leased document. Native code must bind actual guest/frame/document, validate leases and enforce byte quotas. No source algorithm is translated into Rust.' },
  };
}

export function buildRustMediaPolicy({ write = true } = {}) {
  const frozen = verifyCoreFreeze(root);
  if (!frozen.ok) throw new Error(`Core freeze failed: ${frozen.errors.join('; ')}`);
  const extracted = extractMediaPolicy(readFileSync(path.join(root, originalFile), 'utf8'));
  if (write) {
    const directory = path.join(root, 'dist-rust-bridge');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'media-policy.js'), extracted.factorySource);
    writeFileSync(path.join(directory, 'media-policy.manifest.json'), JSON.stringify(extracted.manifest, null, 2) + '\n');
  }
  return extracted;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const extracted = buildRustMediaPolicy();
  console.log(`Extracted ${extracted.manifest.symbols.length} unchanged media policy functions at ${BASELINE_COMMIT}`);
}
