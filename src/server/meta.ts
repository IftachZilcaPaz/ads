import { UpstreamError } from './errors.ts';

export const GRAPH_VERSION = 'v26.0';

/** A Graph API failure with Meta's own message (useful to show: it names the missing permission). */
export class MetaError extends UpstreamError {
  override name = 'MetaError';
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message, 502);
  }
}

export interface Meta {
  get<T>(path: string, params?: Record<string, string>): Promise<T>;
  post<T>(path: string, params: Record<string, unknown>): Promise<T>;
}

const PERMISSION_CODES = new Set([10, 200, 294]);

export function createMeta(token: string, fetchImpl: typeof fetch = fetch): Meta {
  async function call<T>(method: 'GET' | 'POST', path: string, params: Record<string, unknown>): Promise<T> {
    const form = new URLSearchParams({ access_token: token });
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) form.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${path.replace(/^\/+/, '')}`;
    let res: Response;
    try {
      res =
        method === 'GET'
          ? await fetchImpl(`${url}?${form}`)
          : await fetchImpl(url, { method, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
    } catch (err) {
      throw new UpstreamError(`Meta unreachable: ${(err as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number; error_user_msg?: string } };
    if (body.error || !res.ok) {
      const code = body.error?.code ?? res.status;
      const hint = PERMISSION_CODES.has(code) ? ' (לטוקן חסרה הרשאה, למשל ads_read או ads_management)' : code === 190 ? ' (הטוקן פג או לא תקין)' : '';
      throw new MetaError(`Meta ${code}: ${body.error?.error_user_msg || body.error?.message || res.statusText}${hint}`, code);
    }
    return body as T;
  }
  return {
    get: (path, params = {}) => call('GET', path, params),
    post: (path, params) => call('POST', path, params),
  };
}
