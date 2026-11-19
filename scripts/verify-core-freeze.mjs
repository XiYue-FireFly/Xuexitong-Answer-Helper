import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE_COMMIT, DOCUMENT_DIRECTORY, canonicalBytes, createSnapshot, sha256, symbolsFor, workspacePath } from './freeze-core.mjs';

// Reconstruct the reviewed documents solely from immutable Git objects in the
// verifier's repository. A target copy's documents never provide trust anchors.
let trustedSnapshot;
const trustedBaseline = () => trustedSnapshot ||= createSnapshot(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

export function verifyCoreFreeze(root = process.cwd()) {
  const errors = [], read = file => readFileSync(workspacePath(root, file));
  let manifest, boundary, baseline, api;
  try {
    [manifest, boundary, baseline, api] = ['core-manifest', 'symbol-boundary', 'baseline', 'api-contract'].map(name => JSON.parse(read(`${DOCUMENT_DIRECTORY}/${name}.json`)));
  } catch (error) { return { ok: false, errors: [`Cannot read freeze documents: ${error.message}`] }; }
  let trusted;
  try { trusted = trustedBaseline(); } catch (error) { return { ok: false, errors: [`Cannot reconstruct immutable Git baseline ${BASELINE_COMMIT}: ${error.message}`] }; }
  for (const [name, actual, expected] of [['core-manifest', manifest, trusted.manifest], ['symbol-boundary', boundary, trusted.boundary], ['baseline', baseline, trusted.baseline], ['api-contract', api, trusted.api]]) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`Immutable Git baseline mismatch: ${name}.json`);
  }
  // Reject tampered metadata before using any of its paths, arrays or hashes.
  if (errors.length) return { ok: false, baselineCommit: BASELINE_COMMIT, errors };
  for (const document of [manifest, boundary, baseline, api]) if (document.baselineCommit !== BASELINE_COMMIT) errors.push('Reviewed baseline commit changed');
  if (sha256(JSON.stringify(manifest)) !== baseline.documentHashes.coreManifest) errors.push('Core manifest integrity mismatch');
  if (sha256(JSON.stringify(boundary)) !== baseline.documentHashes.symbolBoundary) errors.push('Symbol boundary integrity mismatch');
  if (sha256(JSON.stringify(api)) !== baseline.documentHashes.apiContract) errors.push('API contract integrity mismatch');
  for (const entry of manifest.files) {
    try {
      if (sha256(canonicalBytes(read(entry.path))) !== entry.canonicalSha256) errors.push(`Frozen source changed: ${entry.path}`);
    } catch (error) { errors.push(error.message.startsWith('Unsafe workspace path:') || error.message.startsWith('Workspace path escapes') ? error.message : `Frozen source missing: ${entry.path}`); }
  }
  const expected = new Set(manifest.files.map(entry => entry.path));
  function inspect(directory) {
    let entries; try { entries = readdirSync(workspacePath(root, directory), { withFileTypes: true }); } catch (error) { errors.push(`Cannot inspect frozen directory ${directory}: ${error.message}`); return; }
    for (const entry of entries) {
      const relative = path.posix.join(directory, entry.name);
      if (entry.isSymbolicLink()) errors.push(`Unreviewed symlink inside frozen business directory: ${relative}`);
      else if (entry.isDirectory()) inspect(relative);
      else if (!expected.has(relative)) errors.push(`Unreviewed file inside frozen business directory: ${relative}`);
    }
  }
  for (const directory of manifest.strictDirectories) inspect(directory.replace(/\/$/, ''));
  for (const file of boundary.files) {
    try {
      const actual = symbolsFor(file.path, read(file.path).toString('utf8'));
      const normalized = items => items.map(({ line, endLine, ...item }) => item);
      if (JSON.stringify(normalized(actual)) !== JSON.stringify(normalized(file.symbols))) errors.push(`Mixed-file AST boundary changed: ${file.path}`);
    } catch (error) { errors.push(`Cannot inspect ${file.path}: ${error.message}`); }
  }
  return { ok: errors.length === 0, baselineCommit: BASELINE_COMMIT, files: manifest.files.length, symbols: boundary.files.reduce((sum, file) => sum + file.symbols.length, 0), errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootOption = process.argv.indexOf('--root');
  const result = verifyCoreFreeze(rootOption < 0 ? process.cwd() : path.resolve(process.argv[rootOption + 1]));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
