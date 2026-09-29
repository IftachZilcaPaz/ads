import { z } from 'zod';
import { DomainError } from '../shared/post.ts';
import { ConfigError } from './env.ts';
import { isAuthorized, isSameOrigin, type AuthSecrets } from './session.ts';
import { UpstreamError } from './sheets.ts';
import { ConflictError, NotFoundError } from './table.ts';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const MAX_BODY_BYTES = 256 * 1024;

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export async function readJson<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) {
    throw new HttpError(415, 'Expected application/json');
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large');
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
    throw new HttpError(400, issues[0] ?? 'Invalid request', issues);
  }
  return parsed.data;
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: err.message, details: err.details }, { status: err.status });
  if (err instanceof DomainError) return json({ error: err.message, details: err.issues }, { status: 422 });
  if (err instanceof NotFoundError) return json({ error: err.message }, { status: 404 });
  if (err instanceof ConflictError) return json({ error: err.message }, { status: 409 });
  if (err instanceof UpstreamError) {
    console.error(err);
    return json({ error: 'Google Sheets לא זמין כרגע, נסה שוב' }, { status: 502 });
  }
  if (err instanceof ConfigError) {
    console.error(err);
    return json({ error: 'השרת לא מוגדר עד הסוף (משתני סביבה חסרים)' }, { status: 500 });
  }
  console.error(err);
  return json({ error: 'שגיאה לא צפויה' }, { status: 500 });
}

export interface RouteContext {
  req: Request;
  params: Record<string, string>;
}

export type Handler = (ctx: RouteContext) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  public: boolean;
}

/** Tiny method + path router; `:param` segments are captured. */
export class Router {
  private readonly routes: Route[] = [];

  constructor(private readonly secrets: () => AuthSecrets) {}

  add(method: string, path: string, handler: Handler, opts: { public?: boolean } = {}): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/\/:([a-z_]+)/gi, (_, key: string) => {
        keys.push(key);
        return '/([^/]+)';
      })}/?$`,
    );
    this.routes.push({ method, pattern, keys, handler, public: !!opts.public });
    return this;
  }

  async handle(req: Request): Promise<Response> {
    try {
      const { pathname } = new URL(req.url);
      const candidates = this.routes.filter((r) => r.pattern.test(pathname));
      if (!candidates.length) throw new HttpError(404, 'Not found');
      const route = candidates.find((r) => r.method === req.method);
      if (!route) throw new HttpError(405, 'Method not allowed');

      if (!route.public) {
        if (!(await isAuthorized(req, this.secrets()))) throw new HttpError(401, 'צריך להתחבר');
        if (req.method !== 'GET' && !isSameOrigin(req)) throw new HttpError(403, 'Cross-origin request blocked');
      }

      const match = route.pattern.exec(pathname)!;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(match[i + 1] ?? '')]));
      return await route.handler({ req, params });
    } catch (err) {
      return errorResponse(err);
    }
  }
}
