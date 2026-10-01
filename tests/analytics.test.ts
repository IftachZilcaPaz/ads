import type Anthropic from '@anthropic-ai/sdk';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyzeRequestSchema, buildAnalyzeUserText, engagementRate, summarizePosts, type IgPost } from '../src/shared/analytics.ts';
import { AnalyticsService, generateAnalysis } from '../src/server/analytics.ts';
import type { Meta } from '../src/server/meta.ts';
import { insertRows, testDb } from './helpers/db.ts';

const IMG = 'https://res.cloudinary.com/demo/image/upload/v1/a.jpg';
// 2026-10-01 10:00 Israel.
const NOW = new Date('2026-10-01T07:00:00Z');

const post = (over: Partial<IgPost> & { reach?: number; ti?: number }): IgPost => ({
  id: over.id ?? 'm',
  caption: '',
  format: over.format ?? 'POST',
  permalink: '',
  published_at: over.published_at ?? '2026-09-27 19:30',
  thumbnail: '',
  metrics: over.metrics ?? { reach: over.reach ?? 100, total_interactions: over.ti ?? 5 },
  local_id: '',
  campaign_id: '',
  ...(over.error ? { error: over.error } : {}),
});

describe('summaries', () => {
  it('computes engagement rate from interactions (or their parts) over reach', () => {
    expect(engagementRate(post({ reach: 200, ti: 10 }))).toBe(0.05);
    expect(engagementRate(post({ metrics: { reach: 100, likes: 3, comments: 1, saved: 1, shares: 1 } }))).toBe(0.06);
    expect(engagementRate(post({ metrics: { reach: 0 } }))).toBeNull();
  });

  it('groups by format, weekday and time of day, and only names a best slot with 2+ posts', () => {
    const posts = [
      post({ id: 'r1', format: 'REEL', reach: 100, ti: 10, published_at: '2026-09-27 19:30' }), // Sunday evening
      post({ id: 'r2', format: 'REEL', reach: 100, ti: 6, published_at: '2026-09-27 20:00' }),
      post({ id: 'p1', format: 'POST', reach: 100, ti: 2, published_at: '2026-09-29 08:30' }), // Tuesday morning
      post({ id: 'p2', format: 'POST', reach: 100, ti: 2, published_at: '2026-09-29 09:00' }),
      post({ id: 'c1', format: 'CAROUSEL', reach: 100, ti: 50, published_at: '2026-09-30 23:30' }), // one huge post: anecdote
      post({ id: 'x', error: 'no data', reach: 0 }),
    ];
    const s = summarizePosts(posts);
    expect(s.by_format.find((g) => g.key === 'REEL')).toMatchObject({ count: 2, avg_er: 0.08, avg_reach: 100 });
    expect(s.best_format).toBe('REEL'); // carousel has only one post
    expect(s.by_weekday[0]!.count).toBe(2);
    expect(s.best_weekday).toBe(0);
    expect(s.by_hour.find((h) => h.key === 'night')!.count).toBe(1);
    expect(s.best_hour).toBe('evening');
    expect(s.avg_er).toBeCloseTo((0.1 + 0.06 + 0.02 + 0.02 + 0.5) / 5);
  });
});

function fakeMeta(handlers: Record<string, (params: Record<string, string>) => unknown>) {
  const calls: { path: string; params: Record<string, string> }[] = [];
  const meta: Meta = {
    get: async (path, params = {}) => {
      calls.push({ path, params: params as Record<string, string> });
      const h = handlers[path];
      if (!h) throw new Error(`unexpected ${path}`);
      const out = h(params as Record<string, string>);
      if (out instanceof Error) throw out;
      return out as never;
    },
    post: async () => {
      throw new Error('no');
    },
  };
  return { meta, calls };
}

let ctx: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => {
  ctx = await testDb();
});
beforeEach(async () => {
  await ctx.reset();
  await insertRows(ctx.db, 'settings', [
    { key: 'access_token', value: 'T' },
    { key: 'ig_user_id', value: '1789' },
  ]);
  await insertRows(ctx.db, 'posts', [
    { id: 'ours', publish_at: '2026-09-28 19:00', media_urls: IMG, caption: 'x', status: 'published', ig_media_id: 'M1', campaign_id: 'winter' },
  ]);
});

const HANDLERS = {
  '1789': () => ({ id: '1789', username: 'reynovation', name: 'Reynovation', followers_count: 1200, follows_count: 80, media_count: 64, profile_picture_url: 'https://x/p.jpg' }),
  '1789/insights': (p: Record<string, string>) => {
    if (p.metric === 'reach' && !p.metric_type) {
      return { data: [{ values: [{ value: 40, end_time: '2026-09-30T07:00:00+0000' }, { value: 55, end_time: '2026-10-01T07:00:00+0000' }] }] };
    }
    if (p.metric!.includes(',')) return new Error('Meta 100: profile_links_taps is not available');
    if (p.metric === 'profile_links_taps') return new Error('Meta 100: not available');
    return { data: [{ name: p.metric, total_value: { value: p.metric === 'reach' ? 900 : 10 } }] };
  },
  '1789/media': (p: Record<string, string>) =>
    p.after
      ? { data: [{ id: 'OLD', media_type: 'IMAGE', media_product_type: 'FEED', timestamp: '2026-08-01T10:00:00+0000' }] }
      : {
          data: [
            { id: 'M1', caption: 'ריל', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://ig/1', timestamp: '2026-09-28T16:00:00+0000', thumbnail_url: 'https://t/1' },
            { id: 'M2', caption: 'קרוסלה', media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED', timestamp: '2026-09-25T06:00:00+0000', media_url: 'https://t/2' },
          ],
          paging: { cursors: { after: 'C' }, next: 'https://next' },
        },
  'M1/insights': () => ({ data: [{ name: 'reach', values: [{ value: 300 }] }, { name: 'total_interactions', values: [{ value: 24 }] }] }),
  'M2/insights': () => new Error('Meta 10: media too old'),
};

describe('AnalyticsService', () => {
  const service = (meta: Meta) => new AnalyticsService({ db: ctx.db, meta: () => meta, now: () => NOW });

  it('collects account, totals (tolerating a rejected metric), daily reach and period posts with insights', async () => {
    const { meta, calls } = fakeMeta(HANDLERS);
    const o = await service(meta).overview(30);
    expect(o.account).toMatchObject({ username: 'reynovation', followers: 1200 });
    expect(o.period).toEqual({ days: 30, since: '2026-09-01', until: '2026-10-01' });
    expect(o.totals).toMatchObject({ reach: 900, views: 10 });
    expect(o.totals.profile_links_taps).toBeUndefined();
    expect(o.warnings.join(' ')).toContain('profile_links_taps');
    expect(o.daily_reach).toEqual([
      { date: '2026-09-30', value: 40 },
      { date: '2026-10-01', value: 55 },
    ]);
    expect(o.posts.map((p) => [p.id, p.format])).toEqual([
      ['M1', 'REEL'],
      ['M2', 'CAROUSEL'],
    ]); // OLD is before the period: pagination stops
    expect(o.posts[0]).toMatchObject({ published_at: '2026-09-28 19:00', local_id: 'ours', campaign_id: 'winter', metrics: { reach: 300, total_interactions: 24 } });
    expect(o.posts[1]!.error).toContain('too old');
    expect(calls.filter((c) => c.path === '1789/media')).toHaveLength(2);
  });

  it('caches for an hour and refreshes on demand', async () => {
    const { meta, calls } = fakeMeta(HANDLERS);
    const svc = service(meta);
    await svc.overview(7);
    const n = calls.length;
    await svc.overview(7);
    expect(calls.length).toBe(n);
    await svc.overview(7, true);
    expect(calls.length).toBeGreaterThan(n);
  });

  it('explains what is missing', async () => {
    await ctx.db.query(`delete from settings where key = 'ig_user_id'`);
    await expect(service(fakeMeta(HANDLERS).meta).overview(30)).rejects.toThrow(/חשבון אינסטגרם/);
  });
});

describe('AI analysis', () => {
  const req = AnalyzeRequestSchema.parse({
    account: { username: 'reynovation', followers: 1200 },
    period_days: 30,
    totals: { reach: 900 },
    summary: { by_format: [{ format: 'ריל', count: 2, avg_reach: 300, avg_er: 0.08 }], by_weekday: [], by_hour: [] },
    posts: [{ published_at: '2026-09-28 19:00', format: 'ריל', caption: 'לפני ואחרי', metrics: { reach: 300 }, campaign: 'חורף' }],
  });

  it('frames the numbers as data, with rates as percentages', () => {
    const text = buildAnalyzeUserText(req);
    expect(text).toMatch(/^<data>/);
    expect(text).toContain('מעורבות 8.0%');
    expect(text).toContain('קמפיין: חורף');
  });

  it('returns cleaned structured findings', async () => {
    const create = vi.fn();
    const result = { headline: 'ריל — מנצח', insights: [{ title: 'א', detail: 'ב' }], recommendations: [], caveats: '' };
    const client = {
      beta: {
        messages: {
          stream: (p: unknown) => (create(p), { on: () => {}, finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(result) }] }) }),
        },
      },
    } as unknown as Anthropic;
    const out = await generateAnalysis(client, req, { model: 'claude-opus-5-5', effort: 'medium' });
    expect(out.headline).toBe('ריל - מנצח');
    expect(create.mock.calls[0]![0].output_config.format.type).toBe('json_schema');
  });
});
