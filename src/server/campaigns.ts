import { z } from 'zod';
import { AdsPlanSchema, OBJECTIVE_LABEL, PlannedPostSchema, type AdObjective, type AdsPlan } from '../shared/campaign-plan.ts';
import { CampaignSchema, parseEntity, type Campaign } from '../shared/catalog.ts';
import { composeCaption } from '../shared/captions.ts';
import { DomainError, toPost, type Post } from '../shared/post.ts';
import { addDays, localDate } from '../shared/time.ts';
import type { Db } from './db/db.ts';
import { NotFoundError } from './errors.ts';
import type { Meta } from './meta.ts';
import type { Store } from './store.ts';

export const ApplyPostsSchema = z.object({ posts: z.array(PlannedPostSchema).min(1).max(30) });
export const ImportMetaSchema = z.object({ ids: z.array(z.string().regex(/^\d{1,30}$/)).min(1).max(50) });
export const SavePlanSchema = z.object({ summary: z.string().max(4000).default(''), ads: AdsPlanSchema.nullable() });

export interface SavedPlan {
  summary: string;
  ads: AdsPlan | null;
  updated_at: string;
}

type Metrics = Record<string, number>;

export interface OrganicPost {
  id: string;
  publish_at: string;
  type: string;
  permalink: string;
  caption: string;
  metrics: Metrics;
  error?: string;
}

export interface OrganicStats {
  totals: Metrics;
  posts: OrganicPost[];
  fetched_at: string;
}

export interface PaidStats {
  campaign: { id: string; name: string; status: string; objective: string; daily_budget: number | null };
  totals: Metrics;
  actions: Metrics;
  fetched_at: string;
}

export interface CampaignInsights {
  plan: SavedPlan | null;
  organic: OrganicStats | { error: string } | null;
  paid: PaidStats | { error: string } | null;
}

export interface MetaCampaignSummary {
  id: string;
  name: string;
  status: Campaign['status'];
  meta_status: string;
  objective: string;
  start_date: string;
  end_date: string;
  daily_budget: number | null;
  /** Our campaign already linked to this Meta campaign, if any. */
  linked_to: string;
}

export interface MetaCreateResult {
  meta_campaign_id: string;
  adset_id: string;
  ads_manager_url: string;
  notes: string[];
}

/** Instagram media insights by post type (other metrics make the whole call fail). */
const ORGANIC_METRICS: Record<string, string> = {
  POST: 'reach,views,likes,comments,saved,shares,total_interactions',
  CAROUSEL: 'reach,views,likes,comments,saved,shares,total_interactions',
  REEL: 'reach,views,likes,comments,saved,shares,total_interactions',
  STORY: 'reach,views,shares,replies,total_interactions',
};

/** Ad set optimization per objective; leads/sales need a page or pixel, so they stop at the campaign. */
const OPTIMIZATION: Partial<Record<AdObjective, string>> = {
  OUTCOME_AWARENESS: 'REACH',
  OUTCOME_TRAFFIC: 'LINK_CLICKS',
  OUTCOME_ENGAGEMENT: 'POST_ENGAGEMENT',
};

const ORGANIC_TTL_MIN = 180;
const PAID_TTL_MIN = 60;
const MAX_ORGANIC_POSTS = 25;

/** Meta reports "no date" as the Unix epoch (1970); anything before 2000 means unset. */
function metaDate(value: string | undefined): string {
  if (!value) return '';
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= Date.UTC(2000, 0, 1) ? localDate(new Date(time)) : '';
}

/** Meta's effective_status → our campaign status; a campaign past its stop date has ended. */
function statusFromMeta(metaStatus: string, endDate: string, today: string): Campaign['status'] {
  if (['ARCHIVED', 'DELETED'].includes(metaStatus) || (endDate && endDate < today)) return 'ended';
  return metaStatus === 'ACTIVE' ? 'active' : 'paused';
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export interface CampaignServiceDeps {
  db: Db;
  store: Store;
  meta: (token: string) => Meta;
  now?: () => Date;
}

/** AI plans, Meta campaign creation and insights for one campaign. */
export class CampaignService {
  constructor(private readonly deps: CampaignServiceDeps) {}

  private async campaign(id: string): Promise<Campaign> {
    const [row] = await this.deps.db.query<Record<string, string>>('select * from campaigns where id = $1', [id]);
    const campaign = row && parseEntity(CampaignSchema, row);
    if (!campaign) throw new NotFoundError(`קמפיין לא נמצא: ${id}`);
    return campaign;
  }

  private async settings(...keys: string[]): Promise<Record<string, string>> {
    const rows = await this.deps.db.query<{ key: string; value: string }>('select key, value from settings where key = any($1::text[])', [keys]);
    return Object.fromEntries(rows.map((r) => [r.key, r.value.trim()]));
  }

  /** Turns the picked plan posts into drafts (no media yet: the idea says what to shoot). */
  async applyPosts(campaignId: string, input: z.input<typeof ApplyPostsSchema>): Promise<Post[]> {
    const campaign = await this.campaign(campaignId);
    const { posts } = ApplyPostsSchema.parse(input);
    const products = new Set((await this.deps.db.query<{ id: string }>('select id from products')).map((r) => r.id));
    const created: Post[] = [];
    for (const p of posts) {
      created.push(
        await this.deps.store.createPost({
          type: p.type,
          publish_at: `${p.date} ${p.time}`,
          caption: composeCaption(p),
          campaign_id: campaign.id,
          product_id: products.has(p.product_id) ? p.product_id : '',
          notes: `💡 לצלם: ${p.idea}${p.why ? `\nתפקיד: ${p.why}` : ''}`.slice(0, 1000),
        }),
      );
    }
    return created;
  }

  async savePlan(campaignId: string, input: z.input<typeof SavePlanSchema>): Promise<SavedPlan> {
    await this.campaign(campaignId);
    const plan = SavePlanSchema.parse(input);
    const [row] = await this.deps.db.query<SavedPlan>(
      `insert into campaign_plans (campaign_id, summary, ads, updated_at) values ($1, $2, $3::text::jsonb, now())
       on conflict (campaign_id) do update set summary = excluded.summary, ads = excluded.ads, updated_at = now()
       returning summary, ads, to_char(updated_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') as updated_at`,
      [campaignId, plan.summary, plan.ads ? JSON.stringify(plan.ads) : null],
    );
    return row!;
  }

  private async savedPlan(campaignId: string): Promise<SavedPlan | null> {
    const [row] = await this.deps.db.query<SavedPlan>(
      `select summary, ads, to_char(updated_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') as updated_at
         from campaign_plans where campaign_id = $1`,
      [campaignId],
    );
    return row ?? null;
  }

  /**
   * Creates the saved ads plan in Meta as a PAUSED campaign (and, where Meta
   * allows without a page/pixel, a paused ad set). Nothing spends until it is
   * switched on in Ads Manager.
   */
  async createInMeta(campaignId: string): Promise<MetaCreateResult> {
    const campaign = await this.campaign(campaignId);
    if (campaign.meta_campaign_id) throw new DomainError('הקמפיין כבר מקושר לקמפיין ב-Meta');
    const plan = (await this.savedPlan(campaignId))?.ads;
    if (!plan) throw new DomainError('אין תוכנית מודעות שמורה. בנה תוכנית עם AI ושמור אותה קודם');
    const { meta, account } = await this.adAccount();
    const notes: string[] = [];
    const { currency = 'ILS' } = await meta.get<{ currency?: string }>(`act_${account}`, { fields: 'currency' });
    if (currency !== 'ILS') notes.push(`החשבון ב-${currency}: התקציב הוגדר כ-${plan.daily_budget_ils} ${currency} ליום. בדוק אותו לפני ההפעלה.`);

    const created = await meta.post<{ id: string }>(`act_${account}/campaigns`, {
      name: `${campaign.name} · BP`,
      objective: plan.objective,
      status: 'PAUSED',
      special_ad_categories: [],
      buying_type: 'AUCTION',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      daily_budget: String(Math.round(plan.daily_budget_ils * 100)),
    });
    await this.deps.db.query('update campaigns set meta_campaign_id = $2 where id = $1', [campaignId, created.id]);

    let adsetId = '';
    const goal = OPTIMIZATION[plan.objective];
    if (goal) {
      const start = campaign.start_date && campaign.start_date > localDate(this.now()) ? campaign.start_date : localDate(this.now());
      try {
        adsetId = (
          await meta.post<{ id: string }>(`act_${account}/adsets`, {
            name: `${campaign.name} · קהל`,
            campaign_id: created.id,
            status: 'PAUSED',
            billing_event: 'IMPRESSIONS',
            optimization_goal: goal,
            start_time: `${start}T08:00:00+0300`,
            end_time: `${addDays(start, plan.duration_days)}T23:00:00+0300`,
            targeting: {
              geo_locations: { countries: ['IL'] },
              age_min: plan.audience.age_min,
              age_max: plan.audience.age_max,
              ...(plan.audience.genders === 'all' ? {} : { genders: [plan.audience.genders === 'male' ? 1 : 2] }),
              targeting_automation: { advantage_audience: 0 },
            },
          })
        ).id;
      } catch (err) {
        notes.push(`הקמפיין נוצר, אבל קבוצת המודעות לא: ${(err as Error).message}`);
      }
    } else {
      notes.push('במטרת לידים/מכירות Meta דורשת דף או פיקסל: השלם את קבוצת המודעות ב-Ads Manager.');
    }
    if (plan.audience.locations.length || plan.audience.interests.length) {
      notes.push(`לדיוק הקהל ב-Ads Manager: ${[...plan.audience.locations, ...plan.audience.interests].join(', ')}`);
    }
    notes.push('המודעות עצמן (תמונה וטקסט) נוספות ב-Ads Manager. טקסטים מוכנים מופיעים בתוכנית.');

    return {
      meta_campaign_id: created.id,
      adset_id: adsetId,
      ads_manager_url: `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${account}&selected_campaign_ids=${created.id}`,
      notes,
    };
  }

  // ---------- import from Meta ----------

  private async adAccount(): Promise<{ meta: Meta; account: string }> {
    const s = await this.settings('access_token', 'meta_ad_account_id');
    if (!s.access_token) throw new DomainError('חסר access_token בהגדרות');
    const account = s.meta_ad_account_id?.replace(/^act_/, '');
    if (!account || !/^\d+$/.test(account)) {
      throw new DomainError('חסר מזהה חשבון מודעות: npm run db:set -- meta_ad_account_id act_123456789');
    }
    return { meta: this.deps.meta(s.access_token), account };
  }

  /** Campaigns in the ad account (newest first), marked with the local campaign they are linked to. */
  async listMetaCampaigns(): Promise<MetaCampaignSummary[]> {
    const { meta, account } = await this.adAccount();
    type Row = { id: string; name?: string; objective?: string; effective_status?: string; start_time?: string; stop_time?: string; daily_budget?: string };
    const rows: Row[] = [];
    let after: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await meta.get<{ data: Row[]; paging?: { cursors?: { after?: string }; next?: string } }>(`act_${account}/campaigns`, {
        fields: 'id,name,objective,effective_status,start_time,stop_time,daily_budget',
        limit: '100',
        ...(after ? { after } : {}),
      });
      rows.push(...res.data);
      after = res.paging?.next ? res.paging.cursors?.after : undefined;
      if (!after) break;
    }
    const linked = new Map(
      (await this.deps.db.query<{ id: string; meta_campaign_id: string }>(`select id, meta_campaign_id from campaigns where meta_campaign_id <> ''`)).map(
        (r) => [r.meta_campaign_id, r.id],
      ),
    );
    const today = localDate(this.now());
    return rows.map((r) => {
      const start_date = metaDate(r.start_time);
      const end_date = metaDate(r.stop_time);
      const metaStatus = r.effective_status ?? '';
      return {
        id: r.id,
        name: (r.name ?? r.id).trim().slice(0, 120) || r.id,
        status: statusFromMeta(metaStatus, end_date, today),
        meta_status: metaStatus,
        objective: r.objective ?? '',
        start_date,
        end_date,
        daily_budget: r.daily_budget ? num(r.daily_budget) / 100 : null,
        linked_to: linked.get(r.id) ?? '',
      };
    });
  }

  /** Creates local campaigns for the chosen Meta campaigns, already linked. Linked ones are skipped. */
  async importFromMeta(input: z.input<typeof ImportMetaSchema>): Promise<{ created: Campaign[]; skipped: string[] }> {
    const { ids } = ImportMetaSchema.parse(input);
    const available = new Map((await this.listMetaCampaigns()).map((c) => [c.id, c]));
    const created: Campaign[] = [];
    const skipped: string[] = [];
    for (const id of new Set(ids)) {
      const source = available.get(id);
      if (!source || source.linked_to) {
        skipped.push(id);
        continue;
      }
      const objective = OBJECTIVE_LABEL[source.objective as AdObjective];
      created.push(
        await this.deps.store.saveCampaign({
          name: source.name,
          status: source.status,
          start_date: source.start_date,
          end_date: source.end_date,
          goal: objective ? `מטרת הקמפיין ב-Meta: ${objective}` : '',
          notes: 'יובא מ-Meta Ads',
          meta_campaign_id: source.id,
        }),
      );
    }
    return { created, skipped };
  }

  // ---------- insights ----------

  async insights(campaignId: string, refresh = false): Promise<CampaignInsights> {
    const campaign = await this.campaign(campaignId);
    const s = await this.settings('access_token');
    const meta = s.access_token ? this.deps.meta(s.access_token) : null;
    const settle = async <T>(fn: () => Promise<T>) => {
      try {
        return await fn();
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    };
    const [plan, organic, paid] = await Promise.all([
      this.savedPlan(campaignId),
      meta ? settle(() => this.cached(`organic:${campaignId}`, ORGANIC_TTL_MIN, refresh, () => this.organic(meta, campaignId))) : null,
      meta && campaign.meta_campaign_id
        ? settle(() => this.cached(`paid:${campaign.meta_campaign_id}`, PAID_TTL_MIN, refresh, () => this.paid(meta, campaign.meta_campaign_id)))
        : null,
    ]);
    return { plan, organic, paid };
  }

  private async cached<T>(key: string, ttlMinutes: number, refresh: boolean, load: () => Promise<T>): Promise<T> {
    if (!refresh) {
      const [hit] = await this.deps.db.query<{ data: T }>(
        `select data from insights_cache where key = $1 and fetched_at > now() - make_interval(mins => $2)`,
        [key, ttlMinutes],
      );
      if (hit) return hit.data;
    }
    const data = await load();
    await this.deps.db.query(
      `insert into insights_cache (key, data, fetched_at) values ($1, $2::text::jsonb, now())
       on conflict (key) do update set data = excluded.data, fetched_at = now()`,
      [key, JSON.stringify(data)],
    );
    return data;
  }

  private async organic(meta: Meta, campaignId: string): Promise<OrganicStats> {
    const rows = await this.deps.db.query<Record<string, string>>(
      `select * from posts where campaign_id = $1 and status = 'published' and ig_media_id <> '' order by publish_at desc limit ${MAX_ORGANIC_POSTS}`,
      [campaignId],
    );
    const posts = await Promise.all(
      rows.map(toPost).map(async (p): Promise<OrganicPost> => {
        const base = { id: p.id, publish_at: p.publish_at, type: p.type, permalink: p.permalink, caption: p.caption.slice(0, 120), metrics: {} };
        try {
          const res = await meta.get<{ data: { name: string; values?: { value: unknown }[]; total_value?: { value: unknown } }[] }>(
            `${p.ig_media_id}/insights`,
            { metric: ORGANIC_METRICS[p.type] ?? ORGANIC_METRICS.POST! },
          );
          const metrics = Object.fromEntries(res.data.map((m) => [m.name, num(m.values?.[0]?.value ?? m.total_value?.value)]));
          return { ...base, metrics };
        } catch (err) {
          return { ...base, error: (err as Error).message };
        }
      }),
    );
    const totals: Metrics = {};
    for (const p of posts) for (const [k, v] of Object.entries(p.metrics)) totals[k] = (totals[k] ?? 0) + v;
    return { totals, posts, fetched_at: new Date().toISOString() };
  }

  private async paid(meta: Meta, metaCampaignId: string): Promise<PaidStats> {
    const [info, insights] = await Promise.all([
      meta.get<{ id: string; name?: string; effective_status?: string; objective?: string; daily_budget?: string }>(metaCampaignId, {
        fields: 'name,effective_status,objective,daily_budget',
      }),
      meta.get<{ data: Record<string, unknown>[] }>(`${metaCampaignId}/insights`, {
        fields: 'spend,impressions,reach,clicks,ctr,cpc,cpm,actions',
        date_preset: 'maximum',
      }),
    ]);
    const row = insights.data[0] ?? {};
    const actions = Object.fromEntries(
      ((row.actions as { action_type: string; value: string }[] | undefined) ?? []).map((a) => [a.action_type, num(a.value)]),
    );
    return {
      campaign: {
        id: info.id,
        name: info.name ?? '',
        status: info.effective_status ?? '',
        objective: info.objective ?? '',
        daily_budget: info.daily_budget ? num(info.daily_budget) / 100 : null,
      },
      totals: Object.fromEntries(['spend', 'impressions', 'reach', 'clicks', 'ctr', 'cpc', 'cpm'].map((k) => [k, num(row[k])])),
      actions,
      fetched_at: new Date().toISOString(),
    };
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
