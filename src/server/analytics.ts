import type Anthropic from '@anthropic-ai/sdk';
import {
  ANALYZE_SYSTEM_PROMPT,
  AnalysisSchema,
  AnalyzeRequestSchema,
  buildAnalyzeUserText,
  type AccountOverview,
  type AnalyticsPeriod,
  type Analysis,
  type IgFormat,
  type IgPost,
  type ParsedAnalyzeRequest,
} from '../shared/analytics.ts';
import { DomainError } from '../shared/post.ts';
import { localDate, toLocal } from '../shared/time.ts';
import { structuredCall, toAiError, type AiEvent, type AiOptions } from './ai.ts';
import { defaultAiDeps, handleAiRequest, type AiHandlerDeps } from './ai-handler.ts';
import type { Db } from './db/db.ts';
import type { Meta } from './meta.ts';

/** Account metrics that support metric_type=total_value. */
const ACCOUNT_METRICS = ['reach', 'views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'saves', 'shares', 'profile_links_taps'];
const MEDIA_METRICS = 'reach,views,likes,comments,saved,shares,total_interactions';
const MAX_POSTS = 50;
const CONCURRENCY = 6;
const TTL_MINUTES = 60;

type MediaRow = {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  timestamp?: string;
  thumbnail_url?: string;
  media_url?: string;
};

function formatOf(m: MediaRow): IgFormat {
  if (m.media_product_type === 'REELS') return 'REEL';
  if (m.media_type === 'CAROUSEL_ALBUM') return 'CAROUSEL';
  return 'POST';
}

/** Runs `fn` over items with at most `limit` in flight (Graph API is rate limited per user). */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export interface AnalyticsServiceDeps {
  db: Db;
  meta: (token: string) => Meta;
  now?: () => Date;
}

/** Instagram account analytics: account totals, daily reach, and every recent post with its insights. */
export class AnalyticsService {
  constructor(private readonly deps: AnalyticsServiceDeps) {}

  async overview(days: AnalyticsPeriod, refresh = false): Promise<AccountOverview> {
    const key = `ig:overview:${days}`;
    if (!refresh) {
      const [hit] = await this.deps.db.query<{ data: AccountOverview }>(
        `select data from insights_cache where key = $1 and fetched_at > now() - make_interval(mins => $2)`,
        [key, TTL_MINUTES],
      );
      if (hit) return hit.data;
    }
    const data = await this.load(days);
    await this.deps.db.query(
      `insert into insights_cache (key, data, fetched_at) values ($1, $2::text::jsonb, now())
       on conflict (key) do update set data = excluded.data, fetched_at = now()`,
      [key, JSON.stringify(data)],
    );
    return data;
  }

  private async load(days: AnalyticsPeriod): Promise<AccountOverview> {
    const rows = await this.deps.db.query<{ key: string; value: string }>(
      `select key, value from settings where key in ('access_token', 'ig_user_id')`,
    );
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value.trim()]));
    if (!s.access_token) throw new DomainError('אין חיבור ל-Meta. מתחברים ב"הגדרות"');
    if (!s.ig_user_id) throw new DomainError('לא נבחר חשבון אינסטגרם. בוחרים ב"הגדרות"');
    const meta = this.deps.meta(s.access_token);
    const ig = s.ig_user_id;

    const now = this.deps.now?.() ?? new Date();
    const until = Math.floor(now.getTime() / 1000);
    const since = until - days * 86_400;
    const sinceLocal = toLocal(new Date(since * 1000));
    const warnings: string[] = [];

    const [account, totals, daily, media] = await Promise.all([
      meta.get<{ id: string; username?: string; name?: string; followers_count?: number; follows_count?: number; media_count?: number; profile_picture_url?: string }>(
        ig,
        { fields: 'username,name,followers_count,follows_count,media_count,profile_picture_url' },
      ),
      this.accountTotals(meta, ig, since, until, warnings),
      meta
        .get<{ data: { values?: { value: unknown; end_time: string }[] }[] }>(`${ig}/insights`, {
          metric: 'reach',
          period: 'day',
          since: String(since),
          until: String(until),
        })
        .then((r) => (r.data[0]?.values ?? []).map((v) => ({ date: localDate(new Date(Date.parse(v.end_time) - 1000)), value: num(v.value) })))
        .catch((err: Error) => (warnings.push(`חשיפה יומית: ${err.message}`), [])),
      this.recentMedia(meta, ig, sinceLocal),
    ]);

    const local = new Map(
      (
        await this.deps.db.query<{ id: string; ig_media_id: string; campaign_id: string }>(
          `select id, ig_media_id, campaign_id from posts where ig_media_id <> ''`,
        )
      ).map((r) => [r.ig_media_id, r]),
    );

    const posts = await mapLimited(media, CONCURRENCY, async (m): Promise<IgPost> => {
      const base: IgPost = {
        id: m.id,
        caption: (m.caption ?? '').slice(0, 2200),
        format: formatOf(m),
        permalink: m.permalink ?? '',
        published_at: m.timestamp ? toLocal(new Date(m.timestamp)) : '',
        thumbnail: m.thumbnail_url ?? m.media_url ?? '',
        metrics: {},
        local_id: local.get(m.id)?.id ?? '',
        campaign_id: local.get(m.id)?.campaign_id ?? '',
      };
      try {
        const res = await meta.get<{ data: { name: string; values?: { value: unknown }[]; total_value?: { value: unknown } }[] }>(`${m.id}/insights`, {
          metric: MEDIA_METRICS,
        });
        return { ...base, metrics: Object.fromEntries(res.data.map((d) => [d.name, num(d.values?.[0]?.value ?? d.total_value?.value)])) };
      } catch (err) {
        return { ...base, error: (err as Error).message };
      }
    });

    return {
      account: {
        id: account.id,
        username: account.username ?? '',
        name: account.name ?? '',
        followers: account.followers_count ?? 0,
        follows: account.follows_count ?? 0,
        media_count: account.media_count ?? 0,
        picture: account.profile_picture_url ?? '',
      },
      period: { days, since: sinceLocal.slice(0, 10), until: localDate(now) },
      totals,
      daily_reach: daily,
      posts,
      warnings,
      fetched_at: now.toISOString(),
    };
  }

  /** One request for all totals; if Meta rejects one metric, fall back to one request per metric. */
  private async accountTotals(meta: Meta, ig: string, since: number, until: number, warnings: string[]): Promise<Record<string, number>> {
    type Res = { data: { name: string; total_value?: { value: unknown } }[] };
    const params = (metric: string) => ({ metric, period: 'day', metric_type: 'total_value', since: String(since), until: String(until) });
    const toTotals = (res: Res) => Object.fromEntries(res.data.map((d) => [d.name, num(d.total_value?.value)]));
    try {
      return toTotals(await meta.get<Res>(`${ig}/insights`, params(ACCOUNT_METRICS.join(','))));
    } catch {
      const results = await Promise.allSettled(ACCOUNT_METRICS.map((m) => meta.get<Res>(`${ig}/insights`, params(m))));
      const totals: Record<string, number> = {};
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') Object.assign(totals, toTotals(r.value));
        else warnings.push(`${ACCOUNT_METRICS[i]}: ${(r.reason as Error).message}`);
      });
      return totals;
    }
  }

  /** Feed posts published since `sinceLocal` (newest first), following pagination. */
  private async recentMedia(meta: Meta, ig: string, sinceLocal: string): Promise<MediaRow[]> {
    const out: MediaRow[] = [];
    let after: string | undefined;
    for (let page = 0; page < 4 && out.length < MAX_POSTS; page++) {
      const res = await meta.get<{ data: MediaRow[]; paging?: { cursors?: { after?: string }; next?: string } }>(`${ig}/media`, {
        fields: 'id,caption,media_type,media_product_type,permalink,timestamp,thumbnail_url,media_url',
        limit: '25',
        ...(after ? { after } : {}),
      });
      for (const m of res.data) {
        if (m.timestamp && toLocal(new Date(m.timestamp)) < sinceLocal) return out; // newest first: done
        out.push(m);
      }
      after = res.paging?.next ? res.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return out.slice(0, MAX_POSTS);
  }
}

// ---------- AI analysis (edge function /api/analyze) ----------

export async function generateAnalysis(client: Anthropic, input: ParsedAnalyzeRequest, opts: AiOptions, onEvent?: (e: AiEvent) => void): Promise<Analysis> {
  const result = await structuredCall(
    client,
    { system: ANALYZE_SYSTEM_PROMPT, content: [{ type: 'text', text: buildAnalyzeUserText(input) }], schema: AnalysisSchema },
    opts,
    onEvent,
  );
  const clean = (s: string) => s.replace(/[—–]/g, '-').trim();
  return {
    headline: clean(result.headline),
    insights: result.insights.map((i) => ({ title: clean(i.title), detail: clean(i.detail) })),
    recommendations: result.recommendations.map((r) => ({ title: clean(r.title), detail: clean(r.detail) })),
    caveats: clean(result.caveats),
  };
}

export function handleAnalyzeRequest(req: Request, deps: AiHandlerDeps = defaultAiDeps): Promise<Response> {
  return handleAiRequest(
    req,
    { schema: AnalyzeRequestSchema, generate: generateAnalysis, toError: (err) => toAiError(err, { unexpected: 'שגיאה לא צפויה בניתוח' }) },
    deps,
  );
}
