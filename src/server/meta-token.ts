import { PUBLISHING_SCOPES } from '../shared/meta-scopes.ts';
import { toLocal } from '../shared/time.ts';
import type { Db } from './db/db.ts';
import { DomainError } from '../shared/post.ts';
import { GRAPH_VERSION, createMeta, type Meta } from './meta.ts';

export interface TokenInfo {
  valid: boolean;
  type: string;
  app_id: string;
  app_name: string;
  /** Unix seconds; 0 = does not expire. */
  expires_at: number;
  scopes: string[];
}

export async function inspectToken(meta: Meta, token: string): Promise<TokenInfo> {
  const { data } = await meta.get<{
    data: { is_valid?: boolean; type?: string; app_id?: string; application?: string; expires_at?: number; scopes?: string[] };
  }>('debug_token', { input_token: token });
  return {
    valid: !!data.is_valid,
    type: data.type ?? '',
    app_id: data.app_id ?? '',
    app_name: data.application ?? '',
    expires_at: data.expires_at ?? 0,
    scopes: data.scopes ?? [],
  };
}

export interface SaveTokenOptions {
  db: Db;
  appId: string;
  appSecret: string;
  /** A short-lived user token (Graph API Explorer or OAuth). */
  token: string;
  /** Saves even if publishing scopes are missing. */
  force?: boolean;
  fetchImpl?: typeof fetch;
  meta?: (token: string) => Meta;
}

/**
 * POSTs to Meta's token endpoint. The app secret goes in the form body, never in a URL,
 * so it can't end up in proxy/access logs or in an error message that echoes the URL.
 */
export async function requestAccessToken(
  fetchImpl: typeof fetch,
  params: Record<string, string>,
): Promise<{ access_token?: string; expires_in?: number; error?: { message?: string } }> {
  let res: Response;
  try {
    res = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
  } catch {
    throw new DomainError('אין חיבור ל-Meta');
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: { message?: string } };
  return body.access_token || body.error ? body : { error: { message: `HTTP ${res.status}` } };
}

/**
 * Exchanges a short-lived user token for a ~60-day one (the same exchange BP4
 * keeps doing), refuses a token that cannot publish, and saves it.
 */
export async function exchangeAndSaveToken(opts: SaveTokenOptions): Promise<TokenInfo & { days: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const metaFor = opts.meta ?? ((t: string) => createMeta(t, fetchImpl));
  if (!opts.appId || !opts.appSecret) throw new DomainError('חסרים App ID ו-App Secret של אפליקציית Meta');

  const body = await requestAccessToken(fetchImpl, {
    grant_type: 'fb_exchange_token',
    client_id: opts.appId,
    client_secret: opts.appSecret,
    fb_exchange_token: opts.token.trim(),
  });
  if (!body.access_token) throw new DomainError(`ההחלפה לטוקן ארוך נכשלה: ${body.error?.message ?? 'אין תשובה'}`);

  const info = await inspectToken(metaFor(body.access_token), body.access_token);
  if (info.app_id && info.app_id !== opts.appId) {
    throw new DomainError(`הטוקן שייך לאפליקציה אחרת (${info.app_name || info.app_id}). צור אותו עם האפליקציה ${opts.appId}`);
  }
  const lost = PUBLISHING_SCOPES.filter((s) => !info.scopes.includes(s));
  if (lost.length && !opts.force) {
    throw new DomainError(`לטוקן החדש חסרות הרשאות פרסום: ${lost.join(', ')}. לא שמרתי אותו, הטוקן הקיים נשאר.`);
  }

  for (const [key, value] of [
    ['access_token', body.access_token],
    ['access_token_refreshed_at', toLocal()],
  ] as const) {
    await opts.db.query('insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [key, value]);
  }
  return { ...info, days: Math.round((body.expires_in ?? 5_184_000) / 86400) };
}
