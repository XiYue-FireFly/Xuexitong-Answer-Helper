import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await mkdir(path.join(root, 'dist-electron'), { recursive: true });

await build({
  entryPoints: [path.join(root, 'electron', 'preload-webview.ts')],
  outfile: path.join(root, 'dist-electron', 'preload-webview.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info'
});
