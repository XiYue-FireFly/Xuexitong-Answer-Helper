import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await mkdir(path.join(root, 'dist'), { recursive: true });

// Bundle the Android injectable bridge — pure DOM JS, no Electron deps.
await build({
  entryPoints: [path.join(root, 'src', 'android-webview-bridge.ts')],
  outfile: path.join(root, 'dist', 'android-webview-bridge.js'),
  bundle: true,
  platform: 'browser',
  target: 'chrome85',
  format: 'iife',
  globalName: '__spBridge',
  minify: false,
  sourcemap: false,
  logLevel: 'info',
  // Stub out electron — the bridge modules don't use it, but transitive
  // imports in dom-utils/answer-applier pull in bridge.ts which imports electron.
  external: [],
  plugins: [{
    name: 'stub-electron',
    setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => ({
        path: 'electron-stub',
        namespace: 'electron-stub',
      }));
      build.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
        contents: 'module.exports = { ipcRenderer: { sendToHost: () => {}, on: () => {}, send: () => {} } };',
        loader: 'js',
      }));
    },
  }],
});

console.log('✓ Android WebView bridge built: dist/android-webview-bridge.js');
