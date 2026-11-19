import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [{ name: 'wisp-ui-brand', transformIndexHtml: { order: 'pre', handler(html) { return html.replace('</head>', '<script type="module" src="/src/desktop/branding.ts"></script></head>'); } } }, react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 3000,
  },
});
