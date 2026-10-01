import { z } from 'zod';
import { META_SCOPES } from '../shared/meta-scopes.ts';
import { DomainError } from '../shared/post.ts';
import type { Db } from './db/db.ts';
import { GRAPH_VERSION, type Meta } from './meta.ts';
import { exchangeAndSaveToken, inspectToken, type TokenInfo } from './meta-token.ts';

/** What the browser may change; secrets are write-only and never sent back. */
export const MetaSettingsSchema = z
  .object({
    meta_app_id: z.string().trim().regex(/^\d{5,30}$/, 'App ID: ספרות בלבד').optional(),
    meta_app_secret: z.string().trim().regex(/^[a-f0-9]{32}$/i, 'App Secret: 32 תווים (0-9, a-f)').optional(),
    meta_login_config_id: z.string().trim().regex(/^\d{0,30}$/, 'Configuration ID: ספרות בלבד').optional(),
    ig_user_id: z.string().trim().regex(/^\d{1,30}$/, 'מזהה חשבון אינסטגרם: ספרות בלבד').optional(),
    meta_ad_account_id: z
      .string()
      .trim()
      .regex(/^(act_)?\d{1,30}$/, 'מזהה חשבון מודעות: act_ ואחריו ספרות')
      .transform((v) => (v.startsWith('act_') ? v : `act_${v}`))
      .optional(),
  })
  .strict();
export const MetaTokenSchema = z.object({ token: z.string().trim().min(20).max(1000) }).strict();

export interface ScopeStatus {
  scope: string;
  label: string;
  granted: boolean;
  publishing: boolean;
}

export interface MetaStatus {
  app_id: string;
  app_secret_set: boolean;
  login_config_id: string;
  token: (Omit<TokenInfo, 'scopes'> & { scopes: ScopeStatus[]; wrong_app: boolean }) | null;
  instagram: { id: string; username: string } | null;
  ad_account: { id: string; name: string; currency: string } | null;
  /** Set when Meta could not be reached or rejected the token. */
  error: string;
  oauth_ready: boolean;
}

export interface ConnectionsStatus {
  meta: MetaStatus;
  telegram: { bot_token_set: boolean; chat_id_set: boolean };
  cloudinary: { cloud: string; preset: string };
  claude: { configured: boolean };
  app_url: string;
}

export interface MetaOptions {
  instagram: { id: string; username: string; page: string }[];
  ad_accounts: { id: string; name: string; currency: string; active: boolean }[];
}

const SETTING_KEYS = [
  'access_token',
  'meta_app_id',
  'meta_app_secret',
  'meta_login_config_id',
  'ig_user_id',
  'meta_ad_account_id',
  'telegram_bot_token',
  'telegram_chat_id',
  'cloudinary_cloud',
  'cloudinary_preset',
  'app_url',
] as const;

const OAUTH_TTL_SECONDS = 10 * 60;
const encoder = new TextEncoder();

export interface ConnectionServiceDeps {
  db: Db;
  meta: (token: string) => Meta;
  /** HMAC key for the OAuth state (SESSION_SECRET). */
  secret: () => string;
  claudeConfigured: () => boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** The "connections" settings screen: Meta (status, permissions, accounts, token, login) and the rest at a glance. */
export class ConnectionService {
  constructor(private readonly deps: ConnectionServiceDeps) {}

  private async settings(): Promise<Partial<Record<(typeof SETTING_KEYS)[number], string>>> {
    const rows = await this.deps.db.query<{ key: string; value: string }>('select key, value from settings where key = any($1::text[])', [
      [...SETTING_KEYS],
    ]);
    return Object.fromEntries(rows.map((r) => [r.key, r.value.trim()]));
  }

  async status(): Promise<ConnectionsStatus> {
    const s = await this.settings();
    return {
      meta: await this.metaStatus(s),
      telegram: { bot_token_set: !!s.telegram_bot_token, chat_id_set: !!s.telegram_chat_id },
      cloudinary: { cloud: s.cloudinary_cloud ?? '', preset: s.cloudinary_preset ?? '' },
      claude: { configured: this.deps.claudeConfigured() },
      app_url: s.app_url ?? '',
    };
  }

  private async metaStatus(s: Awaited<ReturnType<ConnectionService['settings']>>): Promise<MetaStatus> {
    const status: MetaStatus = {
      app_id: s.meta_app_id ?? '',
      app_secret_set: !!s.meta_app_secret,
      login_config_id: s.meta_login_config_id ?? '',
      token: null,
      instagram: null,
      ad_account: null,
      error: '',
      oauth_ready: !!s.meta_app_id && !!s.meta_app_secret,
    };
    if (!s.access_token) return status;
    const meta = this.deps.meta(s.access_token);
    try {
      const info = await inspectToken(meta, s.access_token);
      status.token = {
        ...info,
        wrong_app: !!status.app_id && !!info.app_id && info.app_id !== status.app_id,
        scopes: META_SCOPES.map((m) => ({ scope: m.scope, label: m.label, granted: info.scopes.includes(m.scope), publishing: !!m.publishing })),
      };
    } catch (err) {
      status.error = (err as Error).message;
      return status;
    }
    const [ig, ads] = await Promise.allSettled([
      s.ig_user_id ? meta.get<{ id: string; username?: string }>(s.ig_user_id, { fields: 'username' }) : Promise.resolve(null),
      s.meta_ad_account_id ? meta.get<{ id: string; name?: string; currency?: string }>(s.meta_ad_account_id, { fields: 'name,currency' }) : Promise.resolve(null),
    ]);
    if (ig.status === 'fulfilled' && ig.value) status.instagram = { id: ig.value.id, username: ig.value.username ?? '' };
    else if (s.ig_user_id) status.instagram = { id: s.ig_user_id, username: '' };
    if (ads.status === 'fulfilled' && ads.value) status.ad_account = { id: ads.value.id, name: ads.value.name ?? '', currency: ads.value.currency ?? '' };
    else if (s.meta_ad_account_id) status.ad_account = { id: s.meta_ad_account_id, name: '', currency: '' };
    return status;
  }

  /** Instagram accounts (through their Facebook pages) and ad accounts the token can use. */
  async options(): Promise<MetaOptions> {
    const s = await this.settings();
    if (!s.access_token) throw new DomainError('אין חיבור ל-Meta עדיין');
    const meta = this.deps.meta(s.access_token);
    const [pages, ads] = await Promise.allSettled([
      meta.get<{ data: { id: string; name: string; instagram_business_account?: { id: string; username?: string } }[] }>('me/accounts', {
        fields: 'id,name,instagram_business_account{id,username}',
        limit: '100',
      }),
      meta.get<{ data: { id: string; name: string; currency: string; account_status: number }[] }>('me/adaccounts', {
        fields: 'id,name,currency,account_status',
        limit: '100',
      }),
    ]);
    return {
      instagram:
        pages.status === 'fulfilled'
          ? pages.value.data
              .filter((p) => p.instagram_business_account)
              .map((p) => ({ id: p.instagram_business_account!.id, username: p.instagram_business_account!.username ?? '', page: p.name }))
          : [],
      ad_accounts:
        ads.status === 'fulfilled'
          ? ads.value.data.map((a) => ({ id: a.id, name: a.name, currency: a.currency, active: a.account_status === 1 }))
          : [],
    };
  }

  async update(input: z.input<typeof MetaSettingsSchema>): Promise<ConnectionsStatus> {
    const changes = MetaSettingsSchema.parse(input);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      await this.deps.db.query('insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [key, value]);
    }
    return this.status();
  }

  /** A pasted short-lived token (Graph API Explorer): exchanged, checked, saved. */
  async connectWithToken(input: z.input<typeof MetaTokenSchema>): Promise<ConnectionsStatus> {
    const { token } = MetaTokenSchema.parse(input);
    const s = await this.settings();
    await exchangeAndSaveToken({ db: this.deps.db, appId: s.meta_app_id ?? '', appSecret: s.meta_app_secret ?? '', token, fetchImpl: this.deps.fetchImpl, meta: this.deps.meta });
    await this.autoSelect();
    return this.status();
  }

  // ---------- "Continue with Facebook" ----------

  /** The Facebook login dialog URL; `redirectUri` must be listed in the Meta app's valid OAuth redirect URIs. */
  async oauthUrl(redirectUri: string): Promise<string> {
    const s = await this.settings();
    if (!s.meta_app_id || !s.meta_app_secret) throw new DomainError('קודם שומרים App ID ו-App Secret');
    const params = new URLSearchParams({
      client_id: s.meta_app_id,
      redirect_uri: redirectUri,
      state: await this.signState(),
      response_type: 'code',
    });
    // Facebook Login for Business apps define permissions in a configuration; classic apps take a scope list.
    if (s.meta_login_config_id) params.set('config_id', s.meta_login_config_id);
    else params.set('scope', META_SCOPES.map((m) => m.scope).join(','));
    return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params}`;
  }

  async oauthCallback(code: string, state: string, redirectUri: string): Promise<void> {
    if (!(await this.verifyState(state))) throw new DomainError('החיבור פג תוקף או לא תקין. נסה שוב');
    const s = await this.settings();
    if (!s.meta_app_id || !s.meta_app_secret) throw new DomainError('חסרים App ID ו-App Secret');
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const qs = new URLSearchParams({ client_id: s.meta_app_id, client_secret: s.meta_app_secret, redirect_uri: redirectUri, code });
    const res = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?${qs}`);
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: { message?: string } };
    if (!body.access_token) throw new DomainError(`פייסבוק לא החזירה טוקן: ${body.error?.message ?? res.status}`);
    await exchangeAndSaveToken({ db: this.deps.db, appId: s.meta_app_id, appSecret: s.meta_app_secret, token: body.access_token, fetchImpl, meta: this.deps.meta });
    await this.autoSelect();
  }

  /** Picks the Instagram account / ad account when there is exactly one and none is set. */
  private async autoSelect(): Promise<void> {
    const s = await this.settings();
    if (s.ig_user_id && s.meta_ad_account_id) return;
    const options = await this.options().catch(() => null);
    if (!options) return;
    const changes: Record<string, string> = {};
    if (!s.ig_user_id && options.instagram.length === 1) changes.ig_user_id = options.instagram[0]!.id;
    const active = options.ad_accounts.filter((a) => a.active);
    if (!s.meta_ad_account_id && active.length === 1) changes.meta_ad_account_id = active[0]!.id;
    if (Object.keys(changes).length) await this.update(changes);
  }

  private async key(): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', encoder.encode(`oauth:${this.deps.secret()}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  }

  private async signState(): Promise<string> {
    const exp = Math.floor((this.deps.now?.() ?? Date.now()) / 1000) + OAUTH_TTL_SECONDS;
    const nonce = crypto.getRandomValues(new Uint8Array(8)).reduce((acc, b) => acc + b.toString(16).padStart(2, '0'), '');
    const payload = `${exp}.${nonce}`;
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await this.key(), encoder.encode(payload)));
    return `${payload}.${[...sig].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

  private async verifyState(state: string): Promise<boolean> {
    const [exp, nonce, sigHex] = state.split('.');
    if (!exp || !nonce || !sigHex || !/^[0-9a-f]+$/.test(sigHex) || sigHex.length % 2) return false;
    if (Number(exp) * 1000 < (this.deps.now?.() ?? Date.now())) return false;
    const sig = new Uint8Array(sigHex.match(/../g)!.map((h) => parseInt(h, 16)));
    return crypto.subtle.verify('HMAC', await this.key(), sig, encoder.encode(`${exp}.${nonce}`));
  }
}

