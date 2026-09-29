import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  root: 'src/web',
  publicDir: 'public',
  plugins: [preact()],
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    // Regex key: a plain '/api' prefix would also swallow the module '/api.ts'.
    proxy: { '^/api/': { target: 'http://localhost:8888', xfwd: true } },
  },
});
