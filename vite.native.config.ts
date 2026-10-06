import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve('apps/local'),
  publicDir: resolve('.app-build/native-public'),
  define: { 'import.meta.env.VITE_LOCAL_APP': JSON.stringify('1') },
  resolve: { alias: { '/src': resolve('src') } },
  build: { outDir: resolve('native-dist'), emptyOutDir: true },
  server: { host: process.env.TAURI_DEV_HOST || '127.0.0.1', port: 1420, strictPort: true, fs: { allow: [resolve('.')] } },
  worker: { format: 'es' },
});
