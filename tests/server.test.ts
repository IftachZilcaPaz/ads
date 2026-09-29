import { beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../src/server/api.ts';
import { SheetsClient, a1, columnLetter, type CellUpdate } from '../src/server/sheets.ts';
import { createSessionToken, secretsEqual, verifySessionToken, SESSION_COOKIE } from '../src/server/session.ts';
import { Store } from '../src/server/store.ts';
import { parseServiceAccount, signServiceAccountJwt } from '../src/server/google-auth.ts';

const SECRET = 'x'.repeat(40);
const IMG = 'https://res.cloudinary.com/demo/image/upload/v1/a.jpg';

/** In-memory spreadsheet speaking the SheetsClient surface Store relies on. */
class FakeSheets {
  tabs = new Map<string, string[][]>();
  writes: CellUpdate[] = [];

  private tabOf(range: string): string {
    return /^'((?:[^']|'')+)'/.exec(range)![1]!.replace(/''/g, "'");
  }
  async sheetTitles() {
    return [...this.tabs.keys()];
  }
  async addSheets(titles: string[]) {
    for (const t of titles) this.tabs.set(t, []);
  }
  async batchGet(ranges: string[]) {
    return ranges.map((r) => {
      const grid = this.tabs.get(this.tabOf(r)) ?? [];
      return r.endsWith('!1:1') ? grid.slice(0, 1) : grid.map((row) => [...row]);
    });
  }
  async batchUpdate(data: CellUpdate[]) {
    for (const u of data) {
      this.writes.push(u);
      const grid = this.tabs.get(this.tabOf(u.range))!;
      const m = /!([A-Z]+)(\d+)/.exec(u.range)!;
      let col = 0;
      for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
      const row = Number(m[2]) - 1;
      u.values[0]!.forEach((v, i) => {
        grid[row] ??= [];
        grid[row]![col - 1 + i] = v;
      });
    }
  }
  async append(range: string, rows: string[][]) {
    this.tabs.get(this.tabOf(range))!.push(...rows.map((r) => [...r]));
  }
}

function setup() {
  const sheets = new FakeSheets();
  // A legacy spreadsheet: original 9 columns, config tab with secrets.
  sheets.tabs.set('calendar', [
    ['id', 'publish_at', 'type', 'media_urls', 'caption', 'approval_mode', 'status', 'ig_media_id', 'error'],
    ['old-1', '2026-10-01 19:00', 'POST', IMG, 'hello', 'approve', 'draft', '', ''],
    ['', '', '', '', '', '', '', '', ''],
    ['old-2', '2026-10-02 19:00', 'POST', IMG, 'published one', 'auto', 'published', '179', ''],
  ]);
  sheets.tabs.set('config', [
    ['key', 'value'],
    ['access_token', 'SECRET-META-TOKEN'],
    ['cloudinary_cloud', 'demo'],
    ['cloudinary_preset', 'unsigned'],
  ]);
  const store = new Store(sheets as unknown as SheetsClient);
  return { sheets, store };
}

describe('sheets helpers', () => {
  it('builds A1 references', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(a1("it's", 'A1')).toBe("'it''s'!A1");
  });
});

describe('Store', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('migrates the spreadsheet schema without touching existing data', async () => {
    const snap = await ctx.store.snapshot();
    const headers = ctx.sheets.tabs.get('calendar')![0]!;
    expect(headers.slice(0, 9)).toEqual(['id', 'publish_at', 'type', 'media_urls', 'caption', 'approval_mode', 'status', 'ig_media_id', 'error']);
    expect(headers).toContain('approved_at');
    expect(ctx.sheets.tabs.has('campaigns')).toBe(true);
    expect(snap.posts.map((p) => p.id)).toEqual(['old-1', 'old-2']);
  });

  it('never exposes secrets from the config tab', async () => {
    const snap = await ctx.store.snapshot();
    expect(snap.settings).toEqual({ cloudinary_cloud: 'demo', cloudinary_preset: 'unsigned' });
    expect(JSON.stringify(snap)).not.toContain('SECRET-META-TOKEN');
  });

  it('approves by writing only the changed cells of the right row', async () => {
    await ctx.store.snapshot();
    ctx.sheets.writes = [];
    const post = await ctx.store.actOnPost('old-1', 'approve');
    expect(post.status).toBe('ready');
    const ranges = ctx.sheets.writes.map((w) => w.range);
    expect(ranges.every((r) => r.endsWith('2'))).toBe(true);
    expect(ranges).toContain("'calendar'!G2"); // status
    expect(ranges).not.toContain("'calendar'!E2"); // caption untouched
  });

  it('refuses to edit published posts', async () => {
    await expect(ctx.store.editPost('old-2', { caption: 'x' })).rejects.toThrow(/לא ניתן לעריכה/);
  });

  it('creates posts and rejects duplicate ids', async () => {
    const created = await ctx.store.createPost({ id: 'new-1', media_urls: IMG, caption: 'c' });
    expect(created.status).toBe('draft');
    await expect(ctx.store.createPost({ id: 'new-1' })).rejects.toThrow(/כבר קיים/);
    const snap = await ctx.store.snapshot();
    expect(snap.posts.find((p) => p.id === 'new-1')?.caption).toBe('c');
  });

  it('bulk-approves and reports invalid posts', async () => {
    await ctx.store.createPost({ id: 'bad-1' });
    const res = await ctx.store.bulkAct(['old-1', 'bad-1', 'missing'], 'approve');
    expect(res.updated.map((p) => p.id)).toEqual(['old-1']);
    expect(res.failed.map((f) => f.id)).toEqual(['bad-1', 'missing']);
  });

  it('saves campaigns, products and brand', async () => {
    const c = await ctx.store.saveCampaign({ name: 'חורף 2026', hashtags: 'winter' });
    expect(c.id).toMatch(/^c-/);
    const updated = await ctx.store.saveCampaign({ ...c, goal: 'מכירות' }, c.id);
    expect(updated.goal).toBe('מכירות');
    await expect(ctx.store.saveProduct({ name: '' })).rejects.toThrow(/חסר שם מוצר/);
    await ctx.store.saveBrand({ name: 'Reynovation', voice: 'חם ואישי', emoji: 'none' });
    const snap = await ctx.store.snapshot();
    expect(snap.campaigns[0]?.goal).toBe('מכירות');
    expect(snap.brand).toMatchObject({ name: 'Reynovation', voice: 'חם ואישי', emoji: 'none', language: 'he' });
  });
});

describe('sessions', () => {
  it('signs and verifies expiring tokens', async () => {
    const now = Date.now();
    const token = await createSessionToken(SECRET, now, 60);
    expect(await verifySessionToken(SECRET, token, now)).toBe(true);
    expect(await verifySessionToken(SECRET, token, now + 61_000)).toBe(false);
    expect(await verifySessionToken('y'.repeat(40), token, now)).toBe(false);
    expect(await verifySessionToken(SECRET, `${Number(token.split('.')[0]) + 999}.${token.split('.')[1]}`, now)).toBe(false);
  });
  it('compares secrets', async () => {
    expect(await secretsEqual(SECRET, 'pw', 'pw')).toBe(true);
    expect(await secretsEqual(SECRET, 'pw ', 'pw')).toBe(false);
  });
});

describe('API router', () => {
  const { store } = setup();
  const api = createApi({
    store: () => store,
    secrets: () => ({ sessionSecret: SECRET, apiToken: 'automation-token' }),
    password: () => 'correct horse',
  });
  const url = (p: string) => `https://app.example${p}`;

  it('requires authentication', async () => {
    const res = await api.handle(new Request(url('/api/bootstrap')));
    expect(res.status).toBe(401);
  });

  it('logs in and serves the snapshot with the cookie', async () => {
    const bad = await api.handle(
      new Request(url('/api/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"nope"}' }),
    );
    expect(bad.status).toBe(401);

    const ok = await api.handle(
      new Request(url('/api/login'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'correct horse' }),
      }),
    );
    const cookie = ok.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    const token = /bp_session=([^;]+)/.exec(cookie)![1]!;

    const res = await api.handle(new Request(url('/api/bootstrap'), { headers: { cookie: `${SESSION_COOKIE}=${token}` } }));
    expect(res.status).toBe(200);
    expect((await res.json()).posts.length).toBeGreaterThan(0);
  });

  it('accepts the automation bearer token and blocks cross-site writes', async () => {
    const res = await api.handle(new Request(url('/api/bootstrap'), { headers: { authorization: 'Bearer automation-token' } }));
    expect(res.status).toBe(200);
    const token = await createSessionToken(SECRET);
    const csrf = await api.handle(
      new Request(url('/api/posts/old-1/approve'), {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: 'https://evil.example' },
      }),
    );
    expect(csrf.status).toBe(403);
  });

  it('validates bodies and maps domain errors to 422', async () => {
    const headers = { authorization: 'Bearer automation-token', 'content-type': 'application/json' };
    const unknownField = await api.handle(
      new Request(url('/api/posts'), { method: 'POST', headers, body: JSON.stringify({ status: 'published' }) }),
    );
    expect(unknownField.status).toBe(400);
    const invalid = await api.handle(new Request(url('/api/posts/old-1/approve'), { method: 'POST', headers }));
    expect(invalid.status).toBe(200);
    const created = await api.handle(new Request(url('/api/posts'), { method: 'POST', headers, body: '{"id":"empty-1"}' }));
    expect(created.status).toBe(201);
    const cannot = await api.handle(new Request(url('/api/posts/empty-1/approve'), { method: 'POST', headers }));
    expect(cannot.status).toBe(422);
    expect((await cannot.json()).details.length).toBeGreaterThan(0);
    const missing = await api.handle(new Request(url('/api/posts/nope/approve'), { method: 'POST', headers }));
    expect(missing.status).toBe(404);
  });
});

describe('google auth', () => {
  it('signs an RS256 JWT with a service account key', async () => {
    const { privateKey } = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
    const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64');
    const pem = `-----BEGIN PRIVATE KEY-----\\n${der}\\n-----END PRIVATE KEY-----\\n`;
    const sa = parseServiceAccount(Buffer.from(JSON.stringify({ client_email: 'bot@x.iam', private_key: pem })).toString('base64'));
    const jwt = await signServiceAccountJwt(sa, 'scope', 0);
    const [, claims] = jwt.split('.');
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({ iss: 'bot@x.iam', exp: 3600 });
  });
});
