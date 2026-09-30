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
    // Fixed ports (never 3000): app 5173, local API / netlify dev 8888.
    port: 5173,
    strictPort: true,
    // Regex key: a plain '/api' prefix would also swallow the module '/api.ts'.
    proxy: { '^/api/': { target: 'http://localhost:8888', xfwd: true } },
  },
});
