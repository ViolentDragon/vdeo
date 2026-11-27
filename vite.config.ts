import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => ({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
  },
  build: {
    outDir: resolve(__dirname, mode === 'browser' ? 'node_modules/.cache/nebula-browser' : 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome128',
    sourcemap: true,
  },
}));
