import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../src/server/api.ts';
import { a1, columnLetter } from '../src/server/sheets.ts';
import { CAMPAIGN_COLUMNS, PRODUCT_COLUMNS } from '../src/shared/catalog.ts';
import { POST_COLUMNS } from '../src/shared/post.ts';
import { insertRows, testDb } from './helpers/db.ts';
import { createSessionToken, secretsEqual, verifySessionToken, SESSION_COOKIE } from '../src/server/session.ts';
import { Store } from '../src/server/store.ts';
import { parseServiceAccount, signServiceAccountJwt } from '../src/server/google-auth.ts';

const SECRET = 'x'.repeat(40);
const IMG = 'https://res.cloudinary.com/demo/image/upload/v1/a.jpg';

const LEGACY: Record<string, string>[] = [
  { id: 'old-1', publish_at: '2026-10-01 19:00', media_urls: IMG, caption: 'hello', status: 'draft' },
  { id: 'old-2', publish_at: '2026-10-02 19:00', media_urls: IMG, caption: 'published one', approval_mode: 'auto', status: 'published', ig_media_id: '179' },
];

let ctx: Awaited<ReturnType<typeof testDb>>;
let store: Store;

beforeAll(async () => {
  ctx = await testDb();
  store = new Store(ctx.db);
});

beforeEach(async () => {
  await ctx.reset();
  await insertRows(ctx.db, 'posts', LEGACY);
  await insertRows(ctx.db, 'settings', [
    { key: 'access_token', value: 'SECRET-META-TOKEN' },
    { key: 'cloudinary_cloud', value: 'demo' },
    { key: 'cloudinary_preset', value: 'unsigned' },
  ]);
});

describe('sheets helpers (sheet import)', () => {
  it('builds A1 references', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(a1("it's", 'A1')).toBe("'it''s'!A1");
  });
});

describe('Store', () => {
  it('loads everything in one snapshot, hiding archived posts', async () => {
    await store.actOnPost('old-2', 'archive');
    const snap = await store.snapshot();
    expect(snap.posts.map((p) => p.id)).toEqual(['old-1']);
    expect(snap.brand).toMatchObject({ emoji: 'light', language: 'he' });
  });

  it('never exposes secret settings', async () => {
    const snap = await store.snapshot();
    expect(snap.settings).toEqual({ cloudinary_cloud: 'demo', cloudinary_preset: 'unsigned' });
    expect(JSON.stringify(snap)).not.toContain('SECRET-META-TOKEN');
  });

  it('approves and persists the transition', async () => {
    const post = await store.actOnPost('old-1', 'approve');
    expect(post.status).toBe('ready');
    const [row] = await ctx.db.query<Record<string, string>>('select status, approved_at from posts where id = $1', ['old-1']);
    expect(row).toMatchObject({ status: 'ready', approved_at: post.approved_at });
    expect(row!.approved_at).not.toBe('');
  });

  it('refuses to edit published posts', async () => {
    await expect(store.editPost('old-2', { caption: 'x' })).rejects.toThrow(/לא ניתן לעריכה/);
  });

  it('creates posts and rejects duplicate ids', async () => {
    const created = await store.createPost({ id: 'new-1', media_urls: IMG, caption: 'c' });
    expect(created.status).toBe('draft');
    await expect(store.createPost({ id: 'new-1' })).rejects.toThrow(/כבר קיים/);
    const snap = await store.snapshot();
    expect(snap.posts.find((p) => p.id === 'new-1')?.caption).toBe('c');
  });

  it('bulk-approves and reports invalid posts', async () => {
    await store.createPost({ id: 'bad-1' });
    const res = await store.bulkAct(['old-1', 'bad-1', 'missing'], 'approve');
    expect(res.updated.map((p) => p.id)).toEqual(['old-1']);
    expect(res.failed.map((f) => f.id)).toEqual(['bad-1', 'missing']);
  });

  it('deletes posts permanently, except one mid-publish; a missing one counts as deleted', async () => {
    await store.createPost({ id: 'del-1' });
    await ctx.db.query(`update posts set status = 'publishing' where id = 'old-2'`);
    const res = await store.deletePosts(['del-1', 'old-2', 'missing', 'del-1']);
    expect(res.deleted).toEqual(['del-1', 'missing']);
    expect(res.failed).toEqual([{ id: 'old-2', error: 'הפוסט באמצע פרסום' }]);
    const ids = (await store.snapshot()).posts.map((p) => p.id);
    expect(ids).not.toContain('del-1');
    expect(ids).toContain('old-2');
  });

  it('duplicates a post as a new draft', async () => {
    const copy = await store.duplicatePost('old-2');
    expect(copy).toMatchObject({ status: 'draft', caption: 'published one', ig_media_id: '' });
    expect(copy.id).not.toBe('old-2');
  });

  it('saves campaigns, products and brand', async () => {
    const c = await store.saveCampaign({ name: 'חורף 2026', hashtags: 'winter' });
    expect(c.id).toMatch(/^c-/);
    const updated = await store.saveCampaign({ ...c, goal: 'מכירות' }, c.id);
    expect(updated.goal).toBe('מכירות');
    await expect(store.saveCampaign({ name: 'x' }, 'nope')).rejects.toThrow(/לא נמצא/);
    await expect(store.saveProduct({ name: '' })).rejects.toThrow(/חסר שם מוצר/);
    await store.saveProduct({ id: 'kitchen', name: 'מטבח' });
    await expect(store.saveProduct({ id: 'kitchen', name: 'שוב' })).rejects.toThrow(/כבר קיים/);
    await store.saveBrand({ name: 'Reynovation', voice: 'חם ואישי', emoji: 'none' });
    await store.saveBrand({ name: 'Reynovation', voice: 'חם', emoji: 'none' });
    const snap = await store.snapshot();
    expect(snap.campaigns[0]?.goal).toBe('מכירות');
    expect(snap.products.map((p) => p.id)).toEqual(['kitchen']);
    expect(snap.brand).toMatchObject({ name: 'Reynovation', voice: 'חם', emoji: 'none', language: 'he' });
  });

  it('keeps the schema columns in sync with the domain model', async () => {
    const cols = async (table: string) =>
      (
        await ctx.db.query<{ column_name: string }>(
          'select column_name from information_schema.columns where table_name = $1 order by ordinal_position',
          [table],
        )
      ).map((r) => r.column_name);
    expect(await cols('posts')).toEqual([...POST_COLUMNS]);
    expect(await cols('campaigns')).toEqual(CAMPAIGN_COLUMNS);
    expect(await cols('products')).toEqual(PRODUCT_COLUMNS);
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

  it('bulk-deletes through the API and validates the ids', async () => {
    const headers = { authorization: 'Bearer automation-token', 'content-type': 'application/json' };
    await store.createPost({ id: 'del-api' });
    const del = (body: unknown) => api.handle(new Request(url('/api/posts-bulk/delete'), { method: 'POST', headers, body: JSON.stringify(body) }));
    expect((await del({ ids: [] })).status).toBe(400);
    const res = await del({ ids: ['del-api'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: ['del-api'], failed: [] });
    const unauth = await api.handle(new Request(url('/api/posts-bulk/delete'), { method: 'POST', body: '{"ids":["old-1"]}' }));
    expect(unauth.status).toBe(401);
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
