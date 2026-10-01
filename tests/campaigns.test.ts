import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AdsPlan, PlannedPost } from '../src/shared/campaign-plan.ts';
import { createApi } from '../src/server/api.ts';
import { CampaignService } from '../src/server/campaigns.ts';
import { createMeta, MetaError, type Meta } from '../src/server/meta.ts';
import { Store } from '../src/server/store.ts';
import { insertRows, testDb } from './helpers/db.ts';

const IMG = 'https://res.cloudinary.com/demo/image/upload/v1/a.jpg';
const NOW = new Date('2026-10-01T07:00:00Z');

const ADS: AdsPlan = {
  objective: 'OUTCOME_TRAFFIC',
  objective_why: 'תנועה',
  daily_budget_ils: 40,
  duration_days: 14,
  audience: { age_min: 30, age_max: 55, genders: 'female', locations: ['חיפה'], interests: ['עיצוב'], description: 'x' },
  ad_copies: [{ primary_text: 'טקסט', headline: 'כותרת', description: 'תיאור', cta: 'LEARN_MORE' }],
  creative_tips: [],
  kpis: [],
};

const POST: PlannedPost = {
  date: '2026-10-10',
  time: '19:30',
  type: 'REEL',
  idea: 'לפני/אחרי',
  caption: 'מטבח חדש',
  hashtags: ['חורף', 'מטבח'],
  product_id: 'kitchen',
  why: 'חשיפה',
};

/** Records calls; responds by path. */
function fakeMeta(responses: Record<string, unknown | ((params: Record<string, unknown>) => unknown)>) {
  const calls: { method: string; path: string; params: Record<string, unknown> }[] = [];
  const respond = (method: string, path: string, params: Record<string, unknown>) => {
    calls.push({ method, path, params });
    const r = responses[`${method} ${path}`];
    if (r === undefined) throw new Error(`unexpected ${method} ${path}`);
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? (r as (p: Record<string, unknown>) => unknown)(params) : r;
  };
  const meta: Meta = {
    get: async (path, params = {}) => respond('GET', path, params) as never,
    post: async (path, params) => respond('POST', path, params) as never,
  };
  return { meta, calls };
}

let ctx: Awaited<ReturnType<typeof testDb>>;
let store: Store;

beforeAll(async () => {
  ctx = await testDb();
  store = new Store(ctx.db);
});

beforeEach(async () => {
  await ctx.reset();
  await insertRows(ctx.db, 'campaigns', [{ id: 'winter', name: 'חורף', status: 'active', start_date: '2026-10-05', end_date: '2026-10-25' }]);
  await insertRows(ctx.db, 'products', [{ id: 'kitchen', name: 'מטבח', status: 'active' }]);
  await insertRows(ctx.db, 'settings', [
    { key: 'access_token', value: 'TOKEN' },
    { key: 'meta_ad_account_id', value: 'act_777' },
  ]);
});

const service = (meta: Meta) => new CampaignService({ db: ctx.db, store, meta: () => meta, now: () => NOW });

describe('campaign plans', () => {
  it('turns picked plan posts into drafts linked to the campaign', async () => {
    const created = await service(fakeMeta({}).meta).applyPosts('winter', { posts: [POST, { ...POST, product_id: 'nope', type: 'STORY' }] });
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      status: 'draft',
      type: 'REEL',
      publish_at: '2026-10-10 19:30',
      caption: 'מטבח חדש\n\n#חורף #מטבח',
      campaign_id: 'winter',
      product_id: 'kitchen',
      media_urls: '',
    });
    expect(created[0]!.notes).toContain('💡 לצלם: לפני/אחרי');
    expect(created[1]!.product_id).toBe('');
    await expect(service(fakeMeta({}).meta).applyPosts('missing', { posts: [POST] })).rejects.toThrow(/לא נמצא/);
  });

  it('saves and returns the ads plan', async () => {
    const svc = service(fakeMeta({}).meta);
    const saved = await svc.savePlan('winter', { summary: 'אסטרטגיה', ads: ADS });
    expect(saved).toMatchObject({ summary: 'אסטרטגיה', ads: { objective: 'OUTCOME_TRAFFIC' } });
    expect(saved.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('creating the campaign in Meta', () => {
  it('creates a PAUSED campaign and ad set from the saved plan, and links it', async () => {
    const { meta, calls } = fakeMeta({
      'GET act_777': { currency: 'ILS' },
      'POST act_777/campaigns': { id: '120001' },
      'POST act_777/adsets': { id: '120002' },
    });
    const svc = service(meta);
    await svc.savePlan('winter', { summary: '', ads: ADS });
    const result = await svc.createInMeta('winter');

    expect(result).toMatchObject({ meta_campaign_id: '120001', adset_id: '120002' });
    expect(result.ads_manager_url).toContain('act=777&selected_campaign_ids=120001');
    const [, campaign, adset] = calls;
    expect(campaign!.params).toMatchObject({ status: 'PAUSED', objective: 'OUTCOME_TRAFFIC', daily_budget: '4000', special_ad_categories: [] });
    expect(adset!.params).toMatchObject({
      status: 'PAUSED',
      campaign_id: '120001',
      optimization_goal: 'LINK_CLICKS',
      start_time: '2026-10-05T08:00:00+0300',
      end_time: '2026-10-19T23:00:00+0300',
      targeting: { geo_locations: { countries: ['IL'] }, age_min: 30, age_max: 55, genders: [2] },
    });
    expect((await store.snapshot()).campaigns[0]!.meta_campaign_id).toBe('120001');
    await expect(svc.createInMeta('winter')).rejects.toThrow(/כבר מקושר/);
  });

  it('stops at the campaign for leads, and keeps it when the ad set fails', async () => {
    const leads = fakeMeta({ 'GET act_777': { currency: 'USD' }, 'POST act_777/campaigns': { id: '9' } });
    const svc = service(leads.meta);
    await svc.savePlan('winter', { summary: '', ads: { ...ADS, objective: 'OUTCOME_LEADS' } });
    const result = await svc.createInMeta('winter');
    expect(result.adset_id).toBe('');
    expect(result.notes.join(' ')).toMatch(/USD.*לידים/s);

    await ctx.db.query(`update campaigns set meta_campaign_id = '' where id = 'winter'`);
    const failing = fakeMeta({
      'GET act_777': { currency: 'ILS' },
      'POST act_777/campaigns': { id: '10' },
      'POST act_777/adsets': new MetaError('Meta 100: Invalid parameter', 100),
    });
    await svc.savePlan('winter', { summary: '', ads: ADS });
    const partial = await service(failing.meta).createInMeta('winter');
    expect(partial.meta_campaign_id).toBe('10');
    expect(partial.notes[0]).toContain('Invalid parameter');
  });

  it('explains what is missing', async () => {
    const svc = service(fakeMeta({}).meta);
    await expect(svc.createInMeta('winter')).rejects.toThrow(/אין תוכנית מודעות/);
    await svc.savePlan('winter', { summary: '', ads: ADS });
    await ctx.db.query(`delete from settings where key = 'meta_ad_account_id'`);
    await expect(svc.createInMeta('winter')).rejects.toThrow(/meta_ad_account_id/);
  });
});

describe('campaign insights', () => {
  beforeEach(async () => {
    await insertRows(ctx.db, 'posts', [
      { id: 'p1', publish_at: '2026-10-06 19:00', type: 'POST', media_urls: IMG, caption: 'א', status: 'published', ig_media_id: 'M1', campaign_id: 'winter' },
      { id: 'p2', publish_at: '2026-10-07 19:00', type: 'STORY', media_urls: IMG, caption: '', status: 'published', ig_media_id: 'M2', campaign_id: 'winter' },
      { id: 'p3', publish_at: '2026-10-08 19:00', type: 'POST', media_urls: IMG, caption: 'draft', status: 'draft', campaign_id: 'winter' },
    ]);
  });

  it('sums organic metrics per post, tolerates per-post errors, and caches', async () => {
    const { meta, calls } = fakeMeta({
      'GET M1/insights': { data: [{ name: 'reach', values: [{ value: 100 }] }, { name: 'likes', total_value: { value: 7 } }] },
      'GET M2/insights': new MetaError('Meta 10: story expired', 10),
    });
    const svc = service(meta);
    const first = await svc.insights('winter');
    expect(first.paid).toBeNull();
    const organic = first.organic as Exclude<typeof first.organic, { error: string } | null>;
    expect(organic.totals).toEqual({ reach: 100, likes: 7 });
    expect(organic.posts.find((p) => p.id === 'p2')!.error).toContain('story expired');
    expect(calls.find((c) => c.path === 'M2/insights')!.params.metric).toBe('reach,views,shares,replies,total_interactions');

    await svc.insights('winter');
    expect(calls).toHaveLength(2); // served from cache
    await svc.insights('winter', true);
    expect(calls).toHaveLength(4);
  });

  it('reads paid insights for a linked campaign and reports Meta errors without failing', async () => {
    await ctx.db.query(`update campaigns set meta_campaign_id = '555' where id = 'winter'`);
    const ok = fakeMeta({
      'GET M1/insights': { data: [] },
      'GET M2/insights': { data: [] },
      'GET 555': { id: '555', name: 'חורף · BP', effective_status: 'PAUSED', objective: 'OUTCOME_TRAFFIC', daily_budget: '4000' },
      'GET 555/insights': { data: [{ spend: '12.5', impressions: '900', clicks: '30', ctr: '3.3', actions: [{ action_type: 'link_click', value: '28' }] }] },
    });
    const paid = (await service(ok.meta).insights('winter')).paid as { totals: Record<string, number>; actions: Record<string, number>; campaign: { daily_budget: number } };
    expect(paid.totals).toMatchObject({ spend: 12.5, impressions: 900, clicks: 30, reach: 0 });
    expect(paid.actions).toEqual({ link_click: 28 });
    expect(paid.campaign.daily_budget).toBe(40);

    await ctx.reset();
    await insertRows(ctx.db, 'campaigns', [{ id: 'winter', name: 'חורף', meta_campaign_id: '555' }]);
    await insertRows(ctx.db, 'settings', [{ key: 'access_token', value: 'T' }]);
    const denied = fakeMeta({ 'GET 555': new MetaError('Meta 200: no ads_read', 200), 'GET 555/insights': { data: [] } });
    expect((await service(denied.meta).insights('winter')).paid).toEqual({ error: 'Meta 200: no ads_read' });
  });
});

describe('meta client and routes', () => {
  it('maps Graph errors to readable messages', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: 'Requires ads_read', code: 200 } }), { status: 403 })) as unknown as typeof fetch;
    await expect(createMeta('t', fetchImpl).get('1')).rejects.toThrow(/Meta 200: Requires ads_read.*ads_read/);
  });

  it('exposes the campaign endpoints behind auth', async () => {
    const SECRET = 'x'.repeat(40);
    const api = createApi({
      store: () => store,
      secrets: () => ({ sessionSecret: SECRET, apiToken: 'tok' }),
      password: () => 'pw',
      campaigns: () => service(fakeMeta({}).meta),
    });
    const call = (method: string, path: string, body?: unknown, auth = true) =>
      api.handle(
        new Request(`https://app.example${path}`, {
          method,
          headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer tok' } : {}) },
          body: body === undefined ? null : JSON.stringify(body),
        }),
      );
    expect((await call('GET', '/api/campaigns/winter/insights', undefined, false)).status).toBe(401);
    expect((await call('POST', '/api/campaigns/winter/plan/posts', { posts: [POST] })).status).toBe(201);
    expect((await call('PUT', '/api/campaigns/winter/plan', { summary: 's', ads: ADS })).status).toBe(200);
    expect((await call('PUT', '/api/campaigns/winter/plan', { ads: { objective: 'nope' } })).status).toBe(400);
    expect((await call('GET', '/api/campaigns/winter/insights')).status).toBe(200);
  });
});
