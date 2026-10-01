import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { OBJECTIVE_LABEL, type AdObjective } from '../../shared/campaign-plan.ts';
import { isCampaignLive, type Campaign } from '../../shared/catalog.ts';
import { BUCKETS, bucketOf, type Bucket } from '../../shared/post.ts';
import { localDate } from '../../shared/time.ts';
import { api, type CampaignInsights } from '../api.ts';
import { CAMPAIGN_COLUMNS, CAMPAIGN_FIELDS, blank } from '../catalog-fields.ts';
import { CampaignPlanner } from '../components/CampaignPlanner.tsx';
import { EntityForm } from '../components/EntityForm.tsx';
import { Modal } from '../components/Modal.tsx';
import { Icon } from '../icons.tsx';
import { useApp } from '../state.tsx';
import { BUCKET_META, TYPE_LABEL, cx, formatWhen } from '../ui.ts';

const nf = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 1 });
const ils = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 2 });

const ORGANIC_LABEL: Record<string, string> = {
  reach: 'חשיפה ייחודית',
  views: 'צפיות',
  likes: 'לייקים',
  comments: 'תגובות',
  saved: 'שמירות',
  shares: 'שיתופים',
  total_interactions: 'אינטראקציות',
};
const ACTION_LABEL: Record<string, string> = {
  lead: 'לידים',
  'onsite_conversion.lead_grouped': 'לידים',
  purchase: 'רכישות',
  link_click: 'קליקים לקישור',
  landing_page_view: 'צפיות בדף נחיתה',
  'onsite_conversion.messaging_conversation_started_7d': 'שיחות שנפתחו',
  post_engagement: 'מעורבות',
};
const STATUS_LABEL: Record<string, string> = { ACTIVE: 'פעיל', PAUSED: 'מושהה', ARCHIVED: 'בארכיון', DELETED: 'נמחק', IN_PROCESS: 'בעיבוד', WITH_ISSUES: 'עם בעיות' };

const isError = (v: unknown): v is { error: string } => !!v && typeof v === 'object' && 'error' in v;

export function CampaignView({ id }: { id: string }) {
  const { data, run, upsertCampaign, reload } = useApp();
  const campaign = data?.campaigns.find((c) => c.id === id);
  const [insights, setInsights] = useState<CampaignInsights | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      const result = await run(() => api.campaignInsights(id, refresh));
      if (result) setInsights(result);
      setLoading(false);
    },
    [id, run],
  );
  useEffect(() => {
    if (campaign) void load();
  }, [campaign?.id, campaign?.meta_campaign_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const posts = useMemo(() => (data?.posts ?? []).filter((p) => p.campaign_id === id), [data?.posts, id]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
    for (const p of posts) {
      const b = bucketOf(p);
      if (b) c[b]++;
    }
    return c;
  }, [posts]);

  if (!data) return null;
  if (!campaign) {
    return (
      <div class="empty big">
        הקמפיין לא נמצא. <a href="#/library">חזרה לקמפיינים</a>
      </div>
    );
  }

  const live = isCampaignLive(campaign, localDate());
  const next = posts.filter((p) => bucketOf(p) === 'approved').sort((a, b) => a.publish_at.localeCompare(b.publish_at))[0];

  return (
    <div class="campaign-page">
      <a class="back-link" href="#/library">
        → כל הקמפיינים
      </a>
      <header class="page-head campaign-head">
        <span class="eyebrow">קמפיין</span>
        <div class="campaign-title">
          <h1>{campaign.name}</h1>
          <span class={cx('badge', live && 'ok')}>{live ? 'פעיל עכשיו' : campaign.status === 'active' ? 'מתוכנן' : campaign.status === 'paused' ? 'מושהה' : 'הסתיים'}</span>
        </div>
        <p class="muted">
          {[campaign.start_date && campaign.end_date ? `${campaign.start_date} ← ${campaign.end_date}` : '', campaign.goal].filter(Boolean).join(' · ') ||
            'כדאי למלא מטרה, מסר ותאריכים: ה-AI בונה לפיהם.'}
        </p>
        <div class="row wrap">
          <button type="button" onClick={() => setEditing(true)}>
            ✏️ עריכה
          </button>
          <a class="btn-3d small-btn" href={`#/studio?campaign=${encodeURIComponent(campaign.id)}`}>
            <Icon name="plus" size={14} /> פוסט חדש
          </a>
          <button type="button" class="icon round" title="רענון נתונים" aria-label="רענון נתונים" disabled={loading} onClick={() => void load(true)}>
            <Icon name="refresh" size={16} />
          </button>
        </div>
      </header>

      <section class="panel">
        <h2 class="panel-title">📋 בלוח</h2>
        <div class="mini-stats">
          {BUCKETS.map((b) => (
            <a key={b} class="mini-stat" href="#/board">
              <i class="dot" style={{ background: BUCKET_META[b].color }} />
              <strong>{counts[b]}</strong>
              <span>{BUCKET_META[b].title}</span>
            </a>
          ))}
        </div>
        {next && <p class="muted small">הבא בתור: {formatWhen(next.publish_at)}</p>}
      </section>

      <div class="panel-grid">
        <OrganicPanel insights={insights} loading={loading} />
        <PaidPanel campaign={campaign} insights={insights} loading={loading} />
      </div>

      <CampaignPlanner campaign={campaign} posts={posts} savedPlan={insights?.plan ?? null} onLinked={() => void reload().then(() => load(true))} />

      {editing && (
        <Modal title={`עריכה · ${campaign.name}`} onClose={() => setEditing(false)} wide>
          <EntityForm
            fields={CAMPAIGN_FIELDS}
            value={{ ...blank(CAMPAIGN_COLUMNS), ...(campaign as unknown as Record<string, string>) }}
            onSubmit={async (value) => {
              const saved = await run(() => api.saveCampaign(value as Partial<Campaign>, campaign.id), 'נשמר');
              if (saved) {
                upsertCampaign(saved, campaign.id);
                setEditing(false);
              }
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function OrganicPanel({ insights, loading }: { insights: CampaignInsights | null; loading: boolean }) {
  const organic = insights?.organic;
  return (
    <section class="panel">
      <h2 class="panel-title">📈 אורגני באינסטגרם</h2>
      {!insights && loading && <p class="muted small">טוען נתונים...</p>}
      {insights && !organic && <p class="muted small">חסר access_token בהגדרות, אין גישה לנתוני אינסטגרם.</p>}
      {isError(organic) && <p class="err">{organic.error}</p>}
      {organic && !isError(organic) && (
        <>
          {!organic.posts.length ? (
            <p class="muted small">עוד אין פוסטים שפורסמו בקמפיין. הנתונים יופיעו כאן אחרי הפרסום הראשון.</p>
          ) : (
            <>
              <div class="metric-grid">
                {Object.keys(ORGANIC_LABEL)
                  .filter((k) => k in organic.totals)
                  .map((k) => (
                    <div key={k} class="metric">
                      <strong>{nf.format(organic.totals[k]!)}</strong>
                      <span>{ORGANIC_LABEL[k]}</span>
                    </div>
                  ))}
              </div>
              <ul class="insight-list">
                {organic.posts.map((p) => (
                  <li key={p.id}>
                    <span class="badge">{TYPE_LABEL[p.type as keyof typeof TYPE_LABEL] ?? p.type}</span>
                    <span class="insight-cap">{p.caption || formatWhen(p.publish_at)}</span>
                    {p.error ? (
                      <span class="muted small" title={p.error}>
                        אין נתונים
                      </span>
                    ) : (
                      <span class="small">
                        👁 {nf.format(p.metrics.reach ?? 0)} · ❤️ {nf.format(p.metrics.likes ?? 0)} · 💬 {nf.format(p.metrics.comments ?? p.metrics.replies ?? 0)}
                      </span>
                    )}
                    {p.permalink && (
                      <a href={p.permalink} target="_blank" rel="noopener noreferrer">
                        ↗
                      </a>
                    )}
                  </li>
                ))}
              </ul>
              <p class="muted small">עודכן {new Date(organic.fetched_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}</p>
            </>
          )}
        </>
      )}
    </section>
  );
}

function PaidPanel({ campaign, insights, loading }: { campaign: Campaign; insights: CampaignInsights | null; loading: boolean }) {
  const paid = insights?.paid;
  return (
    <section class="panel">
      <h2 class="panel-title">💰 ממומן ב-Meta</h2>
      {!campaign.meta_campaign_id && (
        <p class="muted small">
          לא מקושר לקמפיין ב-Meta. אפשר ליצור אחד מתוכנית ה-AI למטה (במצב מושהה), או להדביק מזהה של קמפיין קיים ב"עריכה".
        </p>
      )}
      {campaign.meta_campaign_id && !insights && loading && <p class="muted small">טוען נתונים...</p>}
      {isError(paid) && <p class="err">{paid.error}</p>}
      {paid && !isError(paid) && (
        <>
          <p class="small">
            <strong>{paid.campaign.name}</strong> · {STATUS_LABEL[paid.campaign.status] ?? paid.campaign.status}
            {paid.campaign.objective && ` · ${OBJECTIVE_LABEL[paid.campaign.objective as AdObjective] ?? paid.campaign.objective}`}
            {paid.campaign.daily_budget != null && ` · ${ils.format(paid.campaign.daily_budget)} ליום`}
          </p>
          <div class="metric-grid">
            <div class="metric">
              <strong>{ils.format(paid.totals.spend ?? 0)}</strong>
              <span>הוצאה</span>
            </div>
            <div class="metric">
              <strong>{nf.format(paid.totals.impressions ?? 0)}</strong>
              <span>חשיפות</span>
            </div>
            <div class="metric">
              <strong>{nf.format(paid.totals.reach ?? 0)}</strong>
              <span>טווח הגעה</span>
            </div>
            <div class="metric">
              <strong>{nf.format(paid.totals.clicks ?? 0)}</strong>
              <span>קליקים</span>
            </div>
            <div class="metric">
              <strong>{nf.format(paid.totals.ctr ?? 0)}%</strong>
              <span>CTR</span>
            </div>
            <div class="metric">
              <strong>{ils.format(paid.totals.cpc ?? 0)}</strong>
              <span>עלות לקליק</span>
            </div>
            {Object.entries(paid.actions)
              .filter(([k]) => k in ACTION_LABEL)
              .slice(0, 3)
              .map(([k, v]) => (
                <div key={k} class="metric">
                  <strong>{nf.format(v)}</strong>
                  <span>{ACTION_LABEL[k]}</span>
                </div>
              ))}
          </div>
          <a
            class="small"
            href={`https://adsmanager.facebook.com/adsmanager/manage/campaigns?selected_campaign_ids=${paid.campaign.id}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            פתיחה ב-Ads Manager ↗
          </a>
        </>
      )}
    </section>
  );
}
