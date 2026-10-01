import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../src/server/api.ts';
import { ConnectionService } from '../src/server/connections.ts';
import type { Meta } from '../src/server/meta.ts';
import { Store } from '../src/server/store.ts';
import { insertRows, testDb } from './helpers/db.ts';

const SECRET = 'x'.repeat(40);
const APP = '1979053692811794';
const APP_SECRET = 'a'.repeat(32);
const ALL_SCOPES = ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement', 'instagram_manage_insights', 'ads_read', 'ads_management', 'business_management'];

/** Meta keyed by token: each token has its own debug info. */
function fakeMeta(tokens: Record<string, { scopes: string[]; app_id?: string }>, extra: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const factory = (token: string): Meta => ({
    get: async (path, params = {}) => {
      calls.push(`${token} GET ${path}`);
      if (path === 'debug_token') {
        const t = tokens[params.input_token as string];
        if (!t) throw new Error('Meta 190: Invalid OAuth access token');
        return { data: { is_valid: true, type: 'USER', app_id: t.app_id ?? APP, application: 'Reynovation Publisher', expires_at: 1_800_000_000, scopes: t.scopes } } as never;
      }
      if (path in extra) return extra[path] as never;
      throw new Error(`unexpected ${path}`);
    },
    post: async () => {
      throw new Error('no posts');
    },
  });
  return { factory, calls };
}

/** Graph OAuth endpoints: code → short token, short → long token. */
function fakeFetch(map: Record<string, string>) {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(url);
    const u = new URL(url);
    const key = u.searchParams.get('code') ?? u.searchParams.get('fb_exchange_token') ?? '';
    const token = map[key];
    return new Response(JSON.stringify(token ? { access_token: token, expires_in: 5_184_000 } : { error: { message: 'bad code' } }));
  }) as unknown as typeof fetch;
  return { impl, urls };
}

let ctx: Awaited<ReturnType<typeof testDb>>;
const setting = async (key: string) => (await ctx.db.query<{ value: string }>('select value from settings where key = $1', [key]))[0]?.value;

beforeAll(async () => {
  ctx = await testDb();
});
beforeEach(async () => {
  await ctx.reset();
  await insertRows(ctx.db, 'settings', [
    { key: 'access_token', value: 'OLD' },
    { key: 'meta_app_id', value: APP },
    { key: 'meta_app_secret', value: APP_SECRET },
    { key: 'telegram_bot_token', value: 'T' },
    { key: 'cloudinary_cloud', value: 'demo' },
  ]);
});

const service = (meta: ReturnType<typeof fakeMeta>, fetchImpl?: typeof fetch, now = () => Date.now()) =>
  new ConnectionService({ db: ctx.db, meta: meta.factory, secret: () => SECRET, claudeConfigured: () => true, fetchImpl, now });

describe('connection status', () => {
  it('shows app, token, permissions, accounts and the other services, never secrets', async () => {
    await insertRows(ctx.db, 'settings', [
      { key: 'ig_user_id', value: '1789' },
      { key: 'meta_ad_account_id', value: 'act_55' },
    ]);
    const meta = fakeMeta({ OLD: { scopes: ['instagram_basic', 'instagram_content_publish', 'pages_show_list'] } }, {
      '1789': { id: '1789', username: 'reynovation' },
      act_55: { id: 'act_55', name: 'Reynovation Ads', currency: 'ILS' },
    });
    const status = await service(meta).status();
    expect(status.meta).toMatchObject({
      app_id: APP,
      app_secret_set: true,
      oauth_ready: true,
      instagram: { username: 'reynovation' },
      ad_account: { name: 'Reynovation Ads' },
      error: '',
    });
    expect(status.meta.token).toMatchObject({ valid: true, app_name: 'Reynovation Publisher', wrong_app: false });
    const scopes = Object.fromEntries(status.meta.token!.scopes.map((s) => [s.scope, s.granted]));
    expect(scopes).toMatchObject({ instagram_content_publish: true, ads_read: false });
    expect(status).toMatchObject({ telegram: { bot_token_set: true, chat_id_set: false }, cloudinary: { cloud: 'demo' }, claude: { configured: true } });
    expect(JSON.stringify(status)).not.toMatch(/OLD|aaaaaaaa/);
  });

  it('reports a rejected token and a token from another app', async () => {
    expect((await service(fakeMeta({})).status()).meta.error).toContain('Invalid OAuth');
    const other = await service(fakeMeta({ OLD: { scopes: [], app_id: '999' } })).status();
    expect(other.meta.token!.wrong_app).toBe(true);
  });
});

describe('changing the Meta connection', () => {
  it('validates and saves app details and account choices', async () => {
    const svc = service(fakeMeta({ OLD: { scopes: [] } }));
    await svc.update({ meta_ad_account_id: '123', ig_user_id: '456', meta_login_config_id: '' });
    expect(await setting('meta_ad_account_id')).toBe('act_123');
    expect(await setting('ig_user_id')).toBe('456');
    await expect(svc.update({ meta_app_secret: 'short' })).rejects.toThrow();
    await expect(svc.update({ access_token: 'x' } as never)).rejects.toThrow(); // not writable from the UI
  });

  const OPTIONS = {
    'me/accounts': { data: [{ id: 'pg', name: 'Reynovation', instagram_business_account: { id: '1789', username: 'reynovation' } }, { id: 'pg2', name: 'no ig' }] },
    'me/adaccounts': {
      data: [
        { id: 'act_1', name: 'Reynovation Ads', currency: 'ILS', account_status: 1 },
        { id: 'act_2', name: 'closed', currency: 'ILS', account_status: 2 },
      ],
    },
  };
  const TOKENS = {
    OLD: { scopes: [] },
    LONG_OK: { scopes: ALL_SCOPES },
    LONG_BAD: { scopes: ['ads_read', 'ads_management'] },
    LONG_OTHER: { scopes: ALL_SCOPES, app_id: '999' },
  };
  const SHORT = { ok: 'short-token-ok-0000000000', bad: 'short-token-bad-000000000', other: 'short-token-other-0000000' };
  const exchange = () => fakeFetch({ [SHORT.ok]: 'LONG_OK', [SHORT.bad]: 'LONG_BAD', [SHORT.other]: 'LONG_OTHER', 'code-1': SHORT.ok });

  it('lists Instagram accounts (via pages) and ad accounts', async () => {
    const options = await service(fakeMeta(TOKENS, OPTIONS)).options();
    expect(options.instagram).toEqual([{ id: '1789', username: 'reynovation', page: 'Reynovation' }]);
    expect(options.ad_accounts.map((a) => [a.id, a.active])).toEqual([
      ['act_1', true],
      ['act_2', false],
    ]);
  });

  it('exchanges a pasted token, refuses one that cannot publish or is from another app, and auto-picks single accounts', async () => {
    const { impl, urls } = exchange();
    const svc = service(fakeMeta(TOKENS, OPTIONS), impl);

    await expect(svc.connectWithToken({ token: SHORT.bad })).rejects.toThrow(/instagram_basic.*הטוקן הקיים נשאר/);
    await expect(svc.connectWithToken({ token: SHORT.other })).rejects.toThrow(/אפליקציה אחרת/);
    expect(await setting('access_token')).toBe('OLD');

    const status = await svc.connectWithToken({ token: SHORT.ok });
    expect(await setting('access_token')).toBe('LONG_OK');
    expect(await setting('ig_user_id')).toBe('1789');
    expect(await setting('meta_ad_account_id')).toBe('act_1'); // the only active one
    expect(status.meta.token!.scopes.every((s) => s.granted)).toBe(true);
    expect(urls[0]).toContain(`client_id=${APP}`);
    expect(urls[0]).toContain('grant_type=fb_exchange_token');
  });

  it('runs the Facebook login: signed state, config_id or scopes, code exchange', async () => {
    const { impl, urls } = exchange();
    let now = Date.parse('2026-10-01T10:00:00Z');
    const svc = service(fakeMeta(TOKENS, OPTIONS), impl, () => now);
    const redirect = 'https://app.example/api/connections/meta/callback';

    const url = new URL(await svc.oauthUrl(redirect));
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe(APP);
    expect(url.searchParams.get('redirect_uri')).toBe(redirect);
    expect(url.searchParams.get('scope')).toContain('instagram_content_publish');
    const state = url.searchParams.get('state')!;

    await expect(svc.oauthCallback('code-1', `${state}0`, redirect)).rejects.toThrow(/פג תוקף/);
    await svc.oauthCallback('code-1', state, redirect);
    expect(await setting('access_token')).toBe('LONG_OK');
    expect(urls[0]).toContain('code=code-1');
    expect(urls[0]).toContain(`redirect_uri=${encodeURIComponent(redirect)}`);

    now += 11 * 60_000; // state lives 10 minutes
    await expect(svc.oauthCallback('code-1', state, redirect)).rejects.toThrow(/פג תוקף/);

    await svc.update({ meta_login_config_id: '777' });
    const business = new URL(await svc.oauthUrl(redirect));
    expect(business.searchParams.get('config_id')).toBe('777');
    expect(business.searchParams.has('scope')).toBe(false);
  });
});

describe('connections routes', () => {
  const api = (svc: ConnectionService) =>
    createApi({ store: () => new Store(ctx.db), secrets: () => ({ sessionSecret: SECRET, apiToken: 'tok' }), password: () => 'pw', connections: () => svc });
  const call = (svc: ConnectionService, method: string, path: string, body?: unknown, auth = true) =>
    api(svc).handle(
      new Request(`https://app.example${path}`, {
        method,
        redirect: 'manual',
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer tok' } : {}) },
        body: body === undefined ? null : JSON.stringify(body),
      }),
    );

  it('requires auth, redirects to Facebook, and returns to settings with the outcome', async () => {
    const svc = service(fakeMeta({ OLD: { scopes: [] } }));
    expect((await call(svc, 'GET', '/api/connections', undefined, false)).status).toBe(401);
    expect((await call(svc, 'GET', '/api/connections')).status).toBe(200);

    const login = await call(svc, 'GET', '/api/connections/meta/login');
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toContain('redirect_uri=https%3A%2F%2Fapp.example%2Fapi%2Fconnections%2Fmeta%2Fcallback');

    const denied = await call(svc, 'GET', '/api/connections/meta/callback?error=access_denied');
    expect(denied.headers.get('location')).toBe('/#/settings?meta_error=access_denied');
    const forged = await call(svc, 'GET', '/api/connections/meta/callback?code=x&state=1.2.ab');
    expect(decodeURIComponent(forged.headers.get('location')!)).toContain('meta_error=החיבור פג תוקף');

    await ctx.db.query(`delete from settings where key = 'meta_app_secret'`);
    const missing = await call(svc, 'GET', '/api/connections/meta/login');
    expect(decodeURIComponent(missing.headers.get('location')!)).toContain('App Secret');
    expect((await call(svc, 'PUT', '/api/connections/meta', { meta_app_id: 'abc' })).status).toBe(400);
  });
});
