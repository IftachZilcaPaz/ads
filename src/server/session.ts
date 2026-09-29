/**
 * Stateless single-user sessions: an HMAC-signed expiry timestamp in an
 * HttpOnly cookie. Web Crypto only, so it runs in Node and Deno (edge) alike.
 */
export const SESSION_COOKIE = 'bp_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]);
    keyCache.set(secret, key);
  }
  return key;
}

function assertSecret(secret: string): void {
  if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
}

export async function createSessionToken(secret: string, nowMs = Date.now(), ttl = SESSION_TTL_SECONDS): Promise<string> {
  assertSecret(secret);
  const exp = Math.floor(nowMs / 1000) + ttl;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`v1.${exp}`));
  return `${exp}.${base64url(sig)}`;
}

export async function verifySessionToken(secret: string, token: string | undefined, nowMs = Date.now()): Promise<boolean> {
  if (!token) return false;
  assertSecret(secret);
  const [expRaw, sigRaw] = token.split('.');
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp * 1000 < nowMs || !sigRaw) return false;
  const sig = fromBase64url(sigRaw);
  if (!sig) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(secret), sig, encoder.encode(`v1.${exp}`));
}

/** Constant-time comparison: HMAC(expected) is verified against the candidate. */
export async function secretsEqual(secret: string, candidate: string, expected: string): Promise<boolean> {
  const key = await hmacKey(secret);
  const expectedSig = await crypto.subtle.sign('HMAC', key, encoder.encode(expected));
  return crypto.subtle.verify('HMAC', key, expectedSig, encoder.encode(candidate));
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name) out[name] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string, maxAge = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearedSessionCookie(): string {
  return sessionCookie('', 0);
}

export interface AuthSecrets {
  sessionSecret: string;
  apiToken?: string | undefined;
}

/**
 * Accepts the browser session cookie, or `Authorization: Bearer <API_TOKEN>`
 * for automation (n8n).
 */
export async function isAuthorized(req: Request, secrets: AuthSecrets): Promise<boolean> {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
  if (bearer) {
    return !!secrets.apiToken && (await secretsEqual(secrets.sessionSecret, bearer, secrets.apiToken));
  }
  const token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
  return verifySessionToken(secrets.sessionSecret, token);
}

/**
 * CSRF defence for cookie-authenticated writes: browsers always send Origin on
 * cross-site POST/PATCH/PUT/DELETE, so a mismatch means a foreign page.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}
