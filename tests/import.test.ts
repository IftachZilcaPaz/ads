import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { importSheet, sanitizePost, type SheetGrids } from '../src/server/sheet-import.ts';
import { Store } from '../src/server/store.ts';
import { testDb } from './helpers/db.ts';

const IMG = 'https://res.cloudinary.com/demo/image/upload/v1/a.jpg';
const GRIDS: SheetGrids = {
  calendar: [
    ['id', 'publish_at', 'type', 'media_urls', 'caption', 'approval_mode', 'status', 'ig_media_id', 'error'],
    ['2026-09-01-123', "'2026-10-01 19:00", 'post', IMG, 'שלום — עולם', 'approve', 'ready', '', ''],
    ['', '', '', '', '', '', '', '', ''],
    ['legacy-2', '1/10/2026 9:00', 'REEL', IMG, 'x', 'weird', 'mystery', '', ''],
    ['bad id', '', '', '', '', '', '', '', ''],
  ],
  campaigns: [['id', 'name'], ['winter', 'חורף'], ['', 'בלי מזהה'], ['BAD!', 'x']],
  products: [],
  brand: [['key', 'value'], ['voice', 'חם'], ['unknown', 'x']],
  config: [['key', 'value'], ['access_token', 'T'], ['cloudinary_cloud', 'demo']],
};

let ctx: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => {
  ctx = await testDb();
});
beforeEach(() => ctx.reset());

describe('sheet import', () => {
  it('normalizes legacy rows', () => {
    expect(sanitizePost({ id: 'a', status: 'mystery', approval_mode: 'weird', publish_at: 'soon', type: 'x' })).toMatchObject({
      status: 'draft',
      approval_mode: 'approve',
      publish_at: '',
      type: 'POST',
    });
    expect(sanitizePost({ id: 'has space' })).toBeNull();
  });

  it('imports everything, reports what it skipped, and is idempotent', async () => {
    const report = await importSheet(ctx.db, GRIDS, { apiToken: 'tok' });
    expect(report).toMatchObject({ posts: 2, campaigns: 2, brand: 1, settings: 3 });
    expect(report.skipped).toEqual(['calendar: invalid id "bad id"', 'campaigns: invalid row "x"']);

    const snap = await new Store(ctx.db).snapshot();
    expect(snap.posts.find((p) => p.id === '2026-09-01-123')).toMatchObject({ type: 'POST', publish_at: '2026-10-01 19:00', caption: 'שלום - עולם' });
    expect(snap.posts.find((p) => p.id === 'legacy-2')).toMatchObject({ publish_at: '2026-10-01 09:00', status: 'draft' });
    expect(snap.campaigns.map((c) => c.name).sort()).toEqual(['בלי מזהה', 'חורף']);
    const [token] = await ctx.db.query<{ value: string }>("select value from settings where key = 'app_api_token'");
    expect(token!.value).toBe('tok');

    const again = await importSheet(ctx.db, GRIDS);
    expect(again).toMatchObject({ posts: 0, campaigns: 1 }); // only the id-less campaign gets a new generated id
  });
});
