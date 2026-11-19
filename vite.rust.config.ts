import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import rustHostCompatPlugin from './build/rust-host-compat-plugin';

export default defineConfig({
  plugins: [rustHostCompatPlugin(), react()],
  base: './',
  resolve: { alias: { '@': path.resolve(__dirname, 'src'), '@rust-host': path.resolve(__dirname, 'src/desktop-rust') } },
  build: { outDir: 'dist-rust', emptyOutDir: true, rollupOptions: { input: path.resolve(__dirname, 'rust-index.html') } },
  server: { host: '127.0.0.1', port: 3001, strictPort: true }
});
