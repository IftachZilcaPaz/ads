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
    proxy: { '/api': 'http://localhost:8888' },
  },
});
