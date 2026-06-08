import { extractFile } from '@electron/asar';

const [asarPath] = process.argv.slice(2);

if (!asarPath) {
  throw new Error('Usage: node scripts/verify-webview-preload-bundle.mjs <app.asar>');
}

const content = extractFile(asarPath, 'dist-electron/preload-webview.js').toString('utf8');

if (content.includes("require('./preload-webview/") || content.includes('require("./preload-webview/')) {
  throw new Error('Packaged WebView preload still references split modules. Run npm run electron:build and ensure preload-webview.js is bundled.');
}
