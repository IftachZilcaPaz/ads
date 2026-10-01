import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { PlanRequestSchema, buildPlanUserText, normalizePlan, type PlanResult } from '../src/shared/campaign-plan.ts';
import { AiError } from '../src/server/ai.ts';
import { generatePlan, handlePlanRequest } from '../src/server/plan-service.ts';

function fakeClient(text: string, stop_reason = 'end_turn') {
  const create = vi.fn();
  const client = {
    beta: {
      messages: {
        stream: (params: unknown) => {
          create(params);
          return { on: () => {}, finalMessage: async () => ({ stop_reason, content: [{ type: 'text', text, citations: null }] }) };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, create };
}

const REQUEST = PlanRequestSchema.parse({
  campaign: { id: 'winter', name: 'חורף', goal: 'לידים', hashtags: '#חורף' },
  products: [{ id: 'kitchen', name: 'מטבח' }],
  posts_count: 3,
  start_date: '2026-10-05',
  end_date: '2026-10-20',
  budget_hint: '₪40 ליום',
  existing: [{ publish_at: '2026-10-06 19:00', type: 'REEL', caption: 'כבר מתוכנן' }],
});

const RESULT: PlanResult = {
  summary: ' אסטרטגיה ',
  posts: [
    { date: '2026-10-12', time: '19:30', type: 'REEL', idea: 'סרטון', caption: 'שני — פוסט', hashtags: ['#חורף', 'חורף', 'בית'], product_id: 'kitchen', why: 'אמון' },
    { date: '2026-10-07', time: '25:00', type: 'POST', idea: 'תמונה', caption: 'ראשון', hashtags: [], product_id: 'invented', why: 'חשיפה' },
    { date: '2026-11-30', time: '10:00', type: 'POST', idea: 'x', caption: 'מחוץ לטווח', hashtags: [], product_id: '', why: '' },
  ],
  ads: {
    objective: 'OUTCOME_LEADS',
    objective_why: 'לידים',
    daily_budget_ils: 39.6,
    duration_days: 400,
    audience: { age_min: 12, age_max: 70, genders: 'all', locations: ['תל אביב'], interests: ['עיצוב'], description: 'בעלי דירות' },
    ad_copies: [{ primary_text: 'טקסט — ארוך', headline: 'כותרת', description: 'תיאור', cta: 'SEND_MESSAGE' }],
    creative_tips: [],
    kpis: [],
  },
};

describe('campaign plan', () => {
  it('validates the date range', () => {
    const base = { campaign: { name: 'x' }, start_date: '2026-10-10', end_date: '2026-10-01' };
    expect(PlanRequestSchema.safeParse(base).success).toBe(false);
    expect(PlanRequestSchema.safeParse({ ...base, end_date: '2027-06-01' }).success).toBe(false);
  });

  it('gives the model the catalog, existing posts and the task as data', () => {
    const text = buildPlanUserText(REQUEST);
    expect(text).toContain('<product id="kitchen">');
    expect(text).toContain('<existing>');
    expect(text).toContain('כבר מתוכנן');
    expect(text).toContain('3 פוסטים אורגניים בין 2026-10-05 ל-2026-10-20');
    expect(text).toContain('רמז תקציב: ₪40 ליום');
    expect(buildPlanUserText({ ...REQUEST, include_ads: false })).toContain('ads כ-null');
  });

  it('cleans the model output', () => {
    const plan = normalizePlan(RESULT, REQUEST);
    expect(plan.summary).toBe('אסטרטגיה');
    expect(plan.posts.map((p) => p.date)).toEqual(['2026-10-07', '2026-10-12']); // sorted, out-of-range dropped
    expect(plan.posts[0]).toMatchObject({ time: '19:00', product_id: '' });
    expect(plan.posts[1]).toMatchObject({ caption: 'שני - פוסט', hashtags: ['חורף', 'בית'] });
    expect(plan.ads).toMatchObject({ daily_budget_ils: 40, duration_days: 120, audience: { age_min: 18, age_max: 65 } });
    expect(plan.ads!.ad_copies[0]!.primary_text).toBe('טקסט - ארוך');
    expect(normalizePlan(RESULT, { ...REQUEST, include_ads: false }).ads).toBeNull();
  });

  it('calls Claude with structured output at the requested effort', async () => {
    const { client, create } = fakeClient(JSON.stringify(RESULT));
    const plan = await generatePlan(client, REQUEST, { model: 'claude-opus-5-5', effort: 'high' });
    expect(plan.posts).toHaveLength(2);
    const params = create.mock.calls[0]![0];
    expect(params).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', max_tokens: 32000 });
    expect(params.output_config).toMatchObject({ effort: 'high', format: { type: 'json_schema' } });

    const empty = fakeClient(JSON.stringify({ ...RESULT, posts: [RESULT.posts[2]] }));
    await expect(generatePlan(empty.client, REQUEST, { model: 'm', effort: 'high' })).rejects.toBeInstanceOf(AiError);
    await expect(generatePlan(fakeClient('', 'refusal').client, REQUEST, { model: 'm', effort: 'high' })).rejects.toThrow(/סירב/);
  });

  it('serves /api/plan at high effort and requires auth', async () => {
    process.env.SESSION_SECRET = 'x'.repeat(40);
    process.env.API_TOKEN = 'tok';
    const { client, create } = fakeClient(JSON.stringify(RESULT));
    const deps = { client: () => client, model: () => 'claude-opus-5-5', effort: () => 'low' as const };
    const req = (headers: Record<string, string>) =>
      new Request('https://app.example/api/plan', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(REQUEST) });
    expect((await handlePlanRequest(req({}), deps)).status).toBe(401);
    const res = await handlePlanRequest(req({ authorization: 'Bearer tok' }), deps);
    expect(res.status).toBe(200);
    expect(((await res.json()) as PlanResult).posts).toHaveLength(2);
    expect(create.mock.calls[0]![0].output_config.effort).toBe('high');
  });
});
