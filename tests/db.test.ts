import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { overduePosts } from '../src/server/maintenance.ts';
import { Store } from '../src/server/store.ts';
import { insertRows, testDb } from './helpers/db.ts';

type Row = Record<string, string>;
const IMG = 'https://res.cloudinary.com/demo/image/upload/v1/a.jpg';

let ctx: Awaited<ReturnType<typeof testDb>>;
let now: (offsetMin?: number) => Promise<string>;

beforeAll(async () => {
  ctx = await testDb();
  now = async (offset = 0) => (await ctx.db.query<{ t: string }>('select il_now($1) as t', [offset]))[0]!.t;
});
beforeEach(() => ctx.reset());

async function post(id: string, over: Row) {
  await insertRows(ctx.db, 'posts', [{ id, media_urls: IMG, caption: 'c', status: 'ready', ...over }]);
}
const get = async (id: string) => (await ctx.db.query<Row>('select * from posts where id = $1', [id]))[0]!;
const ids = (rows: Row[]) => rows.map((r) => r.id).sort();

describe('il_now', () => {
  it('returns Israel wall-clock text', async () => {
    expect(await now()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect((await now(60)) > (await now())).toBe(true);
  });
});

describe('claim_due_posts', () => {
  it('claims only approved, due, ready posts, exactly once', async () => {
    await post('approved-due', { publish_at: await now(-5), approved_at: 'x' });
    await post('auto-due', { publish_at: await now(-5), approval_mode: 'auto' });
    await post('unapproved-due', { publish_at: await now(-5) });
    await post('approved-future', { publish_at: await now(30), approved_at: 'x' });
    await post('draft', { publish_at: await now(-5), approved_at: 'x', status: 'draft' });

    const claimed = await ctx.db.query<Row>('select * from claim_due_posts($1)', ['claim:1']);
    expect(ids(claimed)).toEqual(['approved-due', 'auto-due']);
    expect(claimed[0]).toMatchObject({ status: 'publishing', approval_ref: 'claim:1' });
    expect(await ctx.db.query('select * from claim_due_posts($1)', ['claim:2'])).toEqual([]);
    expect((await get('unapproved-due')).status).toBe('ready');
  });
});

describe('request_approvals', () => {
  it('asks once for unapproved posts inside the lead window', async () => {
    await post('soon', { publish_at: await now(60) });
    await post('overdue', { publish_at: await now(-60) });
    await post('far', { publish_at: await now(60 * 48) });
    await post('approved', { publish_at: await now(60), approved_at: 'x' });
    await post('auto', { publish_at: await now(60), approval_mode: 'auto' });

    const asked = await ctx.db.query<Row>('select * from request_approvals()');
    expect(ids(asked)).toEqual(['overdue', 'soon']);
    expect(asked[0]!.status).toBe('pending_approval');
    expect(asked[0]!.approval_ref).toMatch(/^[0-9a-f]{6}$/);
    expect(await ctx.db.query('select * from request_approvals()')).toEqual([]);
  });

  it('respects approval_lead_hours and ignores junk values', async () => {
    await post('in-3h', { publish_at: await now(180) });
    await insertRows(ctx.db, 'settings', [{ key: 'approval_lead_hours', value: '1' }]);
    expect(await ctx.db.query('select * from request_approvals()')).toEqual([]);
    await ctx.db.query("update settings set value = 'abc' where key = 'approval_lead_hours'");
    expect(ids(await ctx.db.query<Row>('select * from request_approvals()'))).toEqual(['in-3h']);
  });
});

describe('decide_approval', () => {
  const decide = async (id: string, ref: string, action: string) =>
    (await ctx.db.query<{ result: Row }>('select decide_approval($1, $2, $3) as result', [id, ref, action]))[0]!.result;

  it('approves future posts for later, publishes overdue ones now', async () => {
    await post('later', { status: 'pending_approval', approval_ref: 'r1', publish_at: await now(120) });
    await post('now', { status: 'pending_approval', approval_ref: 'r2', publish_at: await now(-1) });

    expect(await decide('later', 'r1', 'approve')).toMatchObject({ decision: 'approve_later', status: 'ready', approval_ref: '' });
    expect((await get('later')).approved_at).not.toBe('');
    expect(await decide('now', 'r2', 'approve')).toMatchObject({ decision: 'publish_now', status: 'publishing' });
  });

  it('rejects', async () => {
    await post('p', { status: 'pending_approval', approval_ref: 'r' });
    expect(await decide('p', 'r', 'reject')).toMatchObject({ decision: 'reject', status: 'rejected' });
  });

  it('ignores stale buttons: wrong ref, double tap, edited in the app, missing', async () => {
    await post('p', { status: 'pending_approval', approval_ref: 'r', publish_at: await now(120) });
    expect((await decide('p', 'old', 'approve')).decision).toBe('stale');
    expect((await decide('p', 'r', 'approve')).decision).toBe('approve_later');
    expect((await decide('p', 'r', 'approve')).decision).toBe('stale'); // double tap
    expect((await decide('missing', 'r', 'approve')).decision).toBe('stale');

    // Editing in the app invalidates the Telegram request.
    await post('edited', { status: 'pending_approval', approval_ref: 'r', publish_at: await now(120) });
    await new Store(ctx.db).editPost('edited', { caption: 'new text' });
    expect((await decide('edited', 'r', 'approve')).decision).toBe('stale');
  });

  it('accepts buttons from the old workflow (no ref) only for legacy rows', async () => {
    await post('legacy', { status: 'pending_approval', approval_ref: '', publish_at: await now(-1) });
    expect((await decide('legacy', '', 'approve')).decision).toBe('publish_now');
  });
});

describe('finish_publish and insert_draft', () => {
  it('records results only for rows being published', async () => {
    await post('p', { status: 'publishing', approval_ref: 'claim:1' });
    await post('q', { status: 'ready' });
    expect(await ctx.db.query('select * from finish_publish($1, $2, $3, $4, $5)', ['p', 'published', 'M1', 'https://ig/p', ''])).toHaveLength(1);
    expect(await get('p')).toMatchObject({ status: 'published', ig_media_id: 'M1', approval_ref: '', permalink: 'https://ig/p' });
    expect(await ctx.db.query('select * from finish_publish($1, $2, $3, $4, $5)', ['q', 'published', 'M2', '', ''])).toEqual([]);
  });

  it('inserts Telegram drafts', async () => {
    const [row] = await ctx.db.query<Row>('select * from insert_draft($1)', [
      JSON.stringify({ id: '2026-09-30-abcd', media_urls: IMG, caption: 'hi, "quoted", 100%', type: 'REEL', campaign_id: 'winter' }),
    ]);
    expect(row).toMatchObject({ status: 'draft', approval_mode: 'approve', type: 'REEL', caption: 'hi, "quoted", 100%', campaign_id: 'winter' });
  });
});

describe('app ↔ n8n interplay', () => {
  it('a post the app is editing is skipped by the publisher until the edit commits', async () => {
    await post('p', { publish_at: await now(-1), approved_at: 'x' });
    // A post in "publishing" cannot be touched from the app.
    await ctx.db.query('select * from claim_due_posts($1)', ['claim:9']);
    await expect(new Store(ctx.db).actOnPost('p', 'unapprove')).rejects.toThrow(/בתהליך פרסום/);
  });
});

describe('overdue maintenance', () => {
  it('lists unpublished posts whose time has passed and can move them to drafts', async () => {
    await post('old-approved', { publish_at: await now(-600), approved_at: 'x' });
    await post('old-waiting', { publish_at: await now(-60), status: 'pending_approval', approval_ref: 'r' });
    await post('future', { publish_at: await now(60) });
    await post('old-draft', { publish_at: await now(-60), status: 'draft' });

    const overdue = await overduePosts(ctx.db);
    expect(overdue.map((p) => [p.id, p.approved])).toEqual([
      ['old-approved', true],
      ['old-waiting', false],
    ]);
    const res = await new Store(ctx.db).bulkAct(overdue.map((p) => p.id), 'draft');
    expect(res.updated.every((p) => p.status === 'draft' && p.approved_at === '' && p.approval_ref === '')).toBe(true);
    expect(await overduePosts(ctx.db)).toEqual([]);
  });
});
