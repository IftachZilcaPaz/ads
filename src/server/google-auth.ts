/**
 * Google service-account OAuth (JWT bearer grant) using Web Crypto, so no
 * heavyweight client library is bundled into the function.
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

/** Accepts the raw key-file JSON or its base64 encoding (handy for env vars). */
export function parseServiceAccount(raw: string): ServiceAccount {
  const text = raw.trim().startsWith('{') ? raw : atob(raw.trim());
  const parsed = JSON.parse(text) as Partial<ServiceAccount>;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON must contain client_email and private_key');
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key.replace(/\\n/g, '\n') };
}

const encoder = new TextEncoder();

function b64url(data: ArrayBuffer | string): string {
  const bytes = typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const binary = atob(body);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

export async function signServiceAccountJwt(sa: ServiceAccount, scope: string, nowMs = Date.now()): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(signature)}`;
}

export interface TokenProvider {
  getToken(): Promise<string>;
}

/** Caches the access token per warm function instance and dedupes refreshes. */
export class ServiceAccountTokenProvider implements TokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly sa: ServiceAccount,
    private readonly scope = SHEETS_SCOPE,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > Date.now()) return this.cached.token;
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const assertion = await signServiceAccountJwt(this.sa, this.scope);
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !body.access_token) {
      throw new Error(`Google auth failed (${res.status}): ${body.error_description ?? 'no access_token'}`);
    }
    this.cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }
}
