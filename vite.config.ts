import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { createDevBackend } from './src/server/dev-backend.ts';

/** Fixed dev port (never 3000; 5173 is often taken by other Vite projects). */
const DEV_PORT = 5199;

/**
 * Serves /api/* from an in-memory backend inside the Vite dev server, so the
 * whole app runs with `npm run dev` on one port. Skipped under `netlify dev`,
 * where the real Netlify functions answer /api/*.
 */
function devBackend(): Plugin {
  return {
    name: 'bp-dev-backend',
    apply: 'serve',
    configureServer(server) {
      if (process.env.NETLIFY_DEV) return;
      const handle = createDevBackend();

      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!req.url?.startsWith('/api/')) return next();
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
        const response = await handle(
          new Request(`http://${req.headers.host ?? `localhost:${DEV_PORT}`}${req.url}`, {
            method: req.method,
            headers,
            body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? null : Buffer.concat(chunks),
          }),
        );
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        if (response.body) for await (const chunk of response.body) res.write(chunk);
        res.end();
      });
      server.httpServer?.once('listening', () =>
        server.config.logger.info(`  ➜  Dev backend: in-memory sample data, password "dev"`),
      );
    },
  };
}

export default defineConfig({
  root: 'src/web',
  publicDir: 'public',
  plugins: [preact(), devBackend()],
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: DEV_PORT,
    strictPort: true,
  },
});
