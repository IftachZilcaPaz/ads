import { useRef, useState } from 'preact/hooks';
import { CTA_LABEL, OBJECTIVE_LABEL, type AdsPlan, type PlanResult } from '../../shared/campaign-plan.ts';
import type { Campaign } from '../../shared/catalog.ts';
import type { Post } from '../../shared/post.ts';
import { addDays, localDate } from '../../shared/time.ts';
import { api, type MetaCreateResult, type SavedPlan } from '../api.ts';
import { useApp, useHoldRefresh } from '../state.tsx';
import { TYPE_LABEL, cx, formatWhen, pluralPosts } from '../ui.ts';

const ils = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
const GENDER: Record<string, string> = { all: 'כולם', male: 'גברים', female: 'נשים' };

interface Props {
  campaign: Campaign;
  posts: Post[];
  savedPlan: SavedPlan | null;
  onLinked: () => void;
}

/** "Build the campaign with AI": an organic post plan to drop into drafts, and a Meta ads plan. */
export function CampaignPlanner({ campaign, posts, savedPlan, onLinked }: Props) {
  const { data, run, toast, upsertPost } = useApp();
  const today = localDate();
  const [form, setForm] = useState(() => ({
    posts_count: 6,
    start_date: campaign.start_date && campaign.start_date > today ? campaign.start_date : today,
    end_date: campaign.end_date && campaign.end_date > today ? campaign.end_date : addDays(today, 21),
    include_ads: true,
    budget_hint: '',
    notes: '',
  }));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [created, setCreated] = useState(false);
  const [metaResult, setMetaResult] = useState<MetaCreateResult | null>(null);
  /** The freshly generated ads plan has been saved (jsonb reorders keys, so no deep compare). */
  const [adsSavedNow, setAdsSavedNow] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useHoldRefresh(busy);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const products = data?.products.filter((p) => p.status === 'active') ?? [];

  async function build() {
    abort.current?.abort();
    abort.current = new AbortController();
    setBusy(true);
    setProgress(0);
    setCreated(false);
    setMetaResult(null);
    setAdsSavedNow(false);
    const result = await run(() =>
      api.plan(
        {
          ...form,
          campaign,
          products,
          brand: data?.brand,
          existing: posts.slice(0, 30).map((p) => ({ publish_at: p.publish_at, type: p.type, caption: p.caption.slice(0, 400) })),
        },
        setProgress,
        abort.current!.signal,
      ),
    );
    setBusy(false);
    if (!result) return;
    setPlan(result);
    setPicked(new Set(result.posts.map((_, i) => i)));
  }

  async function createDrafts() {
    if (!plan) return;
    const chosen = plan.posts.filter((_, i) => picked.has(i));
    const posts = await run(() => api.applyPlanPosts(campaign.id, chosen));
    if (!posts) return;
    posts.forEach(upsertPost);
    setCreated(true);
    toast(`נוצרו ${pluralPosts(posts.length)} בטיוטות. מוסיפים תמונה וקובעים מועד בלוח.`);
  }

  async function saveAds(ads: AdsPlan | null) {
    const saved = await run(() => api.saveAdsPlan(campaign.id, plan?.summary ?? savedPlan?.summary ?? '', ads), 'תוכנית המודעות נשמרה');
    if (!saved) return;
    setAdsSavedNow(true);
    onLinked();
  }

  async function createInMeta() {
    if (!confirm('ליצור את הקמפיין ב-Meta? הוא ייווצר במצב מושהה, בלי הוצאה, עד שתפעיל אותו ב-Ads Manager.')) return;
    const result = await run(() => api.createInMeta(campaign.id), 'הקמפיין נוצר ב-Meta (מושהה)');
    if (!result) return;
    setMetaResult(result);
    onLinked();
  }

  const shownAds = plan?.ads ?? savedPlan?.ads ?? null;
  const adsSaved = plan?.ads ? adsSavedNow : !!savedPlan?.ads;

  return (
    <section class="panel planner">
      <h2 class="panel-title">✨ בניית קמפיין עם AI</h2>
      <p class="muted small">
        Claude מקבל את פרטי הקמפיין, המוצרים, קול המותג והפוסטים שכבר קיימים, ובונה תוכנית תוכן ותוכנית מודעות. שום דבר לא עולה ושום כסף לא יוצא בלי אישור שלך.
      </p>

      <div class="grid2">
        <label class="field">
          <span>כמה פוסטים</span>
          <input type="number" min={1} max={20} value={form.posts_count} onInput={(e) => set('posts_count', Math.max(1, Math.min(20, Number(e.currentTarget.value) || 1)))} />
        </label>
        <label class="field">
          <span>מתאריך</span>
          <input type="date" value={form.start_date} onInput={(e) => set('start_date', e.currentTarget.value)} />
        </label>
        <label class="field">
          <span>עד תאריך</span>
          <input type="date" value={form.end_date} onInput={(e) => set('end_date', e.currentTarget.value)} />
        </label>
        <label class="field">
          <span>רמז תקציב למודעות (לא חובה)</span>
          <input placeholder="למשל: עד ₪50 ליום" value={form.budget_hint} disabled={!form.include_ads} onInput={(e) => set('budget_hint', e.currentTarget.value)} />
        </label>
      </div>
      <label class="field">
        <span>דגשים (לא חובה)</span>
        <textarea rows={2} placeholder="למשל: להתמקד במטבחים, פחות סטוריז, להזכיר שעובדים גם בצפון" value={form.notes} onInput={(e) => set('notes', e.currentTarget.value)} />
      </label>
      <label class="check">
        <input type="checkbox" checked={form.include_ads} onChange={(e) => set('include_ads', e.currentTarget.checked)} />
        <span>גם תוכנית מודעות ממומנות ב-Meta</span>
      </label>

      <div class="row wrap">
        <button type="button" class="primary" disabled={busy || !form.start_date || !form.end_date} onClick={() => void build()}>
          {busy ? 'בונה...' : plan ? '🔄 בנה שוב' : '✨ בנה תוכנית'}
        </button>
        {busy && (
          <span class="progress-note">
            <i class="spinner" /> Claude חושב{progress ? ` · ${progress} תווים` : ''}
          </span>
        )}
      </div>

      {plan && (
        <div class="plan">
          <p class="plan-summary">{plan.summary}</p>
          <div class="plan-head">
            <h3>📅 תוכנית תוכן · {pluralPosts(plan.posts.length)}</h3>
            <button type="button" class="link" onClick={() => setPicked(picked.size === plan.posts.length ? new Set() : new Set(plan.posts.map((_, i) => i)))}>
              {picked.size === plan.posts.length ? 'נקה בחירה' : 'בחר הכל'}
            </button>
          </div>
          <ul class="plan-posts">
            {plan.posts.map((p, i) => {
              const product = products.find((x) => x.id === p.product_id);
              return (
                <li key={i} class={cx('plan-post', picked.has(i) && 'on')}>
                  <label class="check">
                    <input
                      type="checkbox"
                      checked={picked.has(i)}
                      disabled={created}
                      onChange={() => {
                        const next = new Set(picked);
                        if (next.has(i)) next.delete(i);
                        else next.add(i);
                        setPicked(next);
                      }}
                    />
                    <span class="meta">
                      <strong>{formatWhen(`${p.date} ${p.time}`)}</strong>
                      <span class="badge">{TYPE_LABEL[p.type]}</span>
                      {product && <span class="tag">🏷 {product.name}</span>}
                      {p.why && <span class="tag">· {p.why}</span>}
                    </span>
                  </label>
                  <p class="plan-idea">💡 {p.idea}</p>
                  <p class="plan-caption">{p.caption}</p>
                  {p.hashtags.length > 0 && <p class="variant-tags">{p.hashtags.map((h) => `#${h}`).join(' ')}</p>}
                </li>
              );
            })}
          </ul>
          <div class="row wrap">
            <button type="button" class="primary" disabled={!picked.size || created} onClick={() => void createDrafts()}>
              {created ? '✅ נוצרו בטיוטות' : `צור ${pluralPosts(picked.size)} בטיוטות`}
            </button>
            {created && <a href="#/board">ללוח ←</a>}
          </div>
        </div>
      )}

      {shownAds && (
        <div class="plan ads-plan">
          <div class="plan-head">
            <h3>💰 תוכנית מודעות {!plan?.ads && savedPlan?.ads && <span class="muted small">(שמורה · {savedPlan.updated_at})</span>}</h3>
          </div>
          <div class="metric-grid">
            <div class="metric">
              <strong>{OBJECTIVE_LABEL[shownAds.objective]}</strong>
              <span>מטרה</span>
            </div>
            <div class="metric">
              <strong>{ils.format(shownAds.daily_budget_ils)}</strong>
              <span>ליום</span>
            </div>
            <div class="metric">
              <strong>{shownAds.duration_days} ימים</strong>
              <span>≈ {ils.format(shownAds.daily_budget_ils * shownAds.duration_days)} סה"כ</span>
            </div>
            <div class="metric">
              <strong>
                {shownAds.audience.age_min}-{shownAds.audience.age_max}
              </strong>
              <span>{GENDER[shownAds.audience.genders]}</span>
            </div>
          </div>
          <p class="small">{shownAds.objective_why}</p>
          <p class="small">
            <strong>קהל:</strong> {shownAds.audience.description}
            {shownAds.audience.locations.length > 0 && ` · 📍 ${shownAds.audience.locations.join(', ')}`}
            {shownAds.audience.interests.length > 0 && ` · תחומי עניין: ${shownAds.audience.interests.join(', ')}`}
          </p>
          <div class="variants">
            {shownAds.ad_copies.map((c, i) => (
              <article key={i} class="variant">
                <header>
                  <strong>{c.headline}</strong>
                  <span class="badge accent">{CTA_LABEL[c.cta]}</span>
                </header>
                <p class="variant-text">{c.primary_text}</p>
                {c.description && <p class="muted small">{c.description}</p>}
              </article>
            ))}
          </div>
          {shownAds.creative_tips.length > 0 && (
            <p class="small">
              <strong>לקריאייטיב:</strong> {shownAds.creative_tips.join(' · ')}
            </p>
          )}
          {shownAds.kpis.length > 0 && (
            <p class="small">
              <strong>מה למדוד:</strong> {shownAds.kpis.join(' · ')}
            </p>
          )}

          <div class="row wrap">
            {plan?.ads && !adsSaved && (
              <button type="button" onClick={() => void saveAds(plan.ads)}>
                💾 שמור תוכנית מודעות
              </button>
            )}
            {adsSaved && !campaign.meta_campaign_id && (
              <button type="button" class="primary" onClick={() => void createInMeta()}>
                🚀 צור ב-Meta (מושהה)
              </button>
            )}
            {campaign.meta_campaign_id && <span class="badge ok">מקושר ל-Meta · {campaign.meta_campaign_id}</span>}
          </div>
          {metaResult && (
            <div class="notice success">
              <p>
                ✅ נוצר קמפיין מושהה ב-Meta.{' '}
                <a href={metaResult.ads_manager_url} target="_blank" rel="noopener noreferrer">
                  פתיחה ב-Ads Manager ↗
                </a>
              </p>
              <ul class="small">
                {metaResult.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
