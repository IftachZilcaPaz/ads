import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  FORMAT_LABEL,
  HOUR_BUCKETS,
  WEEKDAY_LABEL,
  engagementRate,
  summarizePosts,
  type AccountOverview,
  type Analysis,
  type AnalyticsPeriod,
  type IgPost,
} from '../../shared/analytics.ts';
import { api } from '../api.ts';
import { BarList, ColumnChart, TrendChart } from '../components/charts.tsx';
import { Icon } from '../icons.tsx';
import { useApp } from '../state.tsx';
import { cx, formatWhen } from '../ui.ts';

const compact = new Intl.NumberFormat('he-IL', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('he-IL');
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '-' : `${(v * 100).toFixed(1)}%`);

type SortKey = 'published_at' | 'reach' | 'views' | 'likes' | 'comments' | 'saved' | 'shares' | 'er';
const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'published_at', label: 'פורסם' },
  { key: 'reach', label: 'חשיפה' },
  { key: 'views', label: 'צפיות' },
  { key: 'likes', label: 'לייקים' },
  { key: 'comments', label: 'תגובות' },
  { key: 'saved', label: 'שמירות' },
  { key: 'shares', label: 'שיתופים' },
  { key: 'er', label: 'מעורבות' },
];

function sortValue(p: IgPost, key: SortKey): number | string {
  if (key === 'published_at') return p.published_at;
  if (key === 'er') return engagementRate(p) ?? -1;
  return p.metrics[key] ?? -1;
}

/** Instagram account analytics: totals, daily reach, what works (format / day / time) and every post. */
export function AnalyticsView() {
  const { data, run } = useApp();
  const [days, setDays] = useState<AnalyticsPeriod>(30);
  const [overview, setOverview] = useState<AccountOverview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'er', desc: true });
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const load = useCallback(
    async (period: AnalyticsPeriod, refresh = false) => {
      setLoading(true);
      setError('');
      try {
        setOverview(await api.analytics(period, refresh));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [],
  );
  useEffect(() => {
    setAnalysis(null);
    void load(days);
  }, [days, load]);

  const summary = useMemo(() => (overview ? summarizePosts(overview.posts) : null), [overview]);
  const campaignName = (id: string) => data?.campaigns.find((c) => c.id === id)?.name ?? '';
  const sorted = useMemo(() => {
    if (!overview) return [];
    const dir = sort.desc ? -1 : 1;
    return [...overview.posts].sort((a, b) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
  }, [overview, sort]);

  async function analyze() {
    if (!overview || !summary) return;
    abort.current?.abort();
    abort.current = new AbortController();
    setAnalyzing(true);
    const brand = data?.brand;
    const result = await run(() =>
      api.analyze(
        {
          account: { username: overview.account.username, followers: overview.account.followers },
          period_days: overview.period.days,
          totals: overview.totals,
          summary: {
            by_format: summary.by_format.map((g) => ({ format: FORMAT_LABEL[g.key], count: g.count, avg_reach: g.avg_reach, avg_er: g.avg_er })),
            by_weekday: summary.by_weekday.map((g) => ({ day: WEEKDAY_LABEL[g.key]!, count: g.count, avg_er: g.avg_er })),
            by_hour: summary.by_hour.map((g) => {
              const b = HOUR_BUCKETS.find((h) => h.key === g.key)!;
              return { slot: `${b.label} ${b.range}`, count: g.count, avg_er: g.avg_er };
            }),
          },
          posts: overview.posts
            .filter((p) => !p.error)
            .slice(0, 40)
            .map((p) => ({ published_at: p.published_at, format: FORMAT_LABEL[p.format], caption: p.caption.slice(0, 400), metrics: p.metrics, campaign: campaignName(p.campaign_id) })),
          brand: [brand?.name, brand?.description].filter(Boolean).join(' - ').slice(0, 1500),
        },
        () => {},
        abort.current!.signal,
      ),
    );
    setAnalyzing(false);
    if (result) setAnalysis(result);
  }

  const t = overview?.totals ?? {};
  const interactions = t.total_interactions ?? (t.likes ?? 0) + (t.comments ?? 0) + (t.saves ?? 0) + (t.shares ?? 0);

  return (
    <div class="analytics-page">
      <header class="page-head">
        <span class="eyebrow">ניתוחים</span>
        <h1>
          מה <em>עובד</em> באינסטגרם
        </h1>
      </header>

      <div class="toolbar">
        <div class="segmented">
          {([7, 30] as const).map((d) => (
            <button key={d} type="button" class={cx(days === d && 'on')} onClick={() => setDays(d)}>
              {d} ימים
            </button>
          ))}
        </div>
        <button type="button" class="icon round" title="רענון מ-Meta" aria-label="רענון מ-Meta" disabled={loading} onClick={() => void load(days, true)}>
          <Icon name="refresh" size={16} />
        </button>
      </div>

      {error && (
        <p class="notice error">
          {error} {/הגדרות/.test(error) && <a href="#/settings">להגדרות</a>}
        </p>
      )}
      {!overview && loading && (
        <p class="progress-note">
          <i class="spinner" /> מושך נתונים מאינסטגרם...
        </p>
      )}

      {overview && summary && (
        <div class={cx('analytics-body', loading && 'refetching')}>
          <section class="panel account-strip">
            {overview.account.picture && <img src={overview.account.picture} alt="" />}
            <div>
              <strong>@{overview.account.username}</strong>
              <span class="muted small">
                {whole.format(overview.account.followers)} עוקבים · {whole.format(overview.account.media_count)} פוסטים · {overview.period.since} ← {overview.period.until}
              </span>
            </div>
          </section>

          <section class="summary analytics-kpis">
            {[
              { label: 'חשיפה', value: t.reach, sub: 'חשבונות ייחודיים' },
              { label: 'צפיות', value: t.views, sub: 'כולל צפיות חוזרות' },
              { label: 'אינטראקציות', value: interactions, sub: `${whole.format(t.likes ?? 0)} לייקים · ${whole.format(t.comments ?? 0)} תגובות` },
              { label: 'שמירות ושיתופים', value: (t.saves ?? 0) + (t.shares ?? 0), sub: 'הסימן הכי חזק לתוכן טוב' },
              { label: 'מעורבות ממוצעת', text: pct(summary.avg_er), sub: 'אינטראקציות / חשיפה לפוסט' },
            ].map((k) => (
              <div key={k.label} class="stat slate">
                <span class="stat-label">{k.label}</span>
                <strong>{'text' in k ? k.text : k.value === undefined ? '-' : compact.format(k.value)}</strong>
                <span class="stat-sub">{k.sub}</span>
              </div>
            ))}
          </section>

          <section class="panel">
            <h2 class="panel-title">חשיפה יומית</h2>
            <TrendChart points={overview.daily_reach} fmt={(v) => compact.format(v)} label="חשיפה" />
          </section>

          <div class="panel-grid three">
            <section class="panel">
              <h2 class="panel-title">לפי פורמט</h2>
              <p class="muted small">מעורבות ממוצעת לפוסט</p>
              <BarList
                emphasize
                fmt={(v) => pct(v)}
                items={summary.by_format.map((g) => ({
                  key: g.key,
                  label: FORMAT_LABEL[g.key],
                  value: g.avg_er,
                  sub: `${g.count} פוסטים · חשיפה ממוצעת ${compact.format(g.avg_reach)}`,
                  emphasis: g.key === summary.best_format,
                }))}
              />
            </section>
            <section class="panel">
              <h2 class="panel-title">לפי יום</h2>
              <p class="muted small">{summary.best_weekday === null ? 'צריך לפחות 2 פוסטים ביום כדי לקבוע' : `הכי טוב: יום ${WEEKDAY_LABEL[summary.best_weekday]}`}</p>
              <ColumnChart
                fmt={(v) => pct(v)}
                items={summary.by_weekday.map((g) => ({
                  key: String(g.key),
                  label: WEEKDAY_LABEL[g.key]!,
                  value: g.avg_er,
                  sub: `${g.count} פוסטים`,
                  emphasis: g.key === summary.best_weekday,
                }))}
              />
            </section>
            <section class="panel">
              <h2 class="panel-title">לפי שעה</h2>
              <p class="muted small">שעון ישראל</p>
              <BarList
                emphasize
                fmt={(v) => pct(v)}
                items={summary.by_hour.map((g) => {
                  const b = HOUR_BUCKETS.find((h) => h.key === g.key)!;
                  return { key: g.key, label: `${b.label} ${b.range}`, value: g.avg_er, sub: `${g.count} פוסטים`, emphasis: g.key === summary.best_hour };
                })}
              />
            </section>
          </div>

          <section class="panel">
            <div class="plan-head">
              <h2 class="panel-title">✨ ניתוח עם AI</h2>
              <button type="button" class="primary" disabled={analyzing || !overview.posts.length} onClick={() => void analyze()}>
                {analyzing ? 'מנתח...' : analysis ? 'נתח שוב' : 'נתח את הנתונים'}
              </button>
            </div>
            {!analysis && !analyzing && <p class="muted small">Claude קורא את המספרים והפוסטים של התקופה, ומסביר מה עובד ומה לעשות הלאה.</p>}
            {analyzing && (
              <p class="progress-note">
                <i class="spinner" /> Claude מנתח...
              </p>
            )}
            {analysis && (
              <div class="analysis">
                <p class="plan-summary">{analysis.headline}</p>
                <div class="panel-grid">
                  <div>
                    <h3 class="sub-title">ממצאים</h3>
                    <ul class="analysis-list">
                      {analysis.insights.map((i) => (
                        <li key={i.title}>
                          <strong>{i.title}</strong>
                          <p>{i.detail}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h3 class="sub-title">המלצות</h3>
                    <ul class="analysis-list">
                      {analysis.recommendations.map((r) => (
                        <li key={r.title}>
                          <strong>{r.title}</strong>
                          <p>{r.detail}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
                {analysis.caveats && <p class="muted small">⚠️ {analysis.caveats}</p>}
              </div>
            )}
          </section>

          <section class="panel">
            <h2 class="panel-title">פוסטים · {overview.posts.length}</h2>
            {!overview.posts.length ? (
              <p class="muted small">לא פורסמו פוסטים בתקופה הזו.</p>
            ) : (
              <div class="table-wrap">
                <table class="posts-table">
                  <thead>
                    <tr>
                      <th>פוסט</th>
                      {COLUMNS.map((c) => (
                        <th key={c.key} aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                          <button type="button" class="link" onClick={() => setSort({ key: c.key, desc: sort.key === c.key ? !sort.desc : true })}>
                            {c.label}
                            {sort.key === c.key ? (sort.desc ? ' ↓' : ' ↑') : ''}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((p) => (
                      <tr key={p.id}>
                        <td class="post-cell">
                          {p.thumbnail ? <img src={p.thumbnail} alt="" loading="lazy" /> : <span class="thumb-ph" />}
                          <span>
                            <span class="meta">
                              <span class="badge">{FORMAT_LABEL[p.format]}</span>
                              {p.campaign_id && campaignName(p.campaign_id) && <span class="badge accent">📣 {campaignName(p.campaign_id)}</span>}
                            </span>
                            <span class="cell-cap">{p.caption.replace(/\s+/g, ' ').slice(0, 80) || '(בלי קפשן)'}</span>
                            {p.permalink && (
                              <a href={p.permalink} target="_blank" rel="noopener noreferrer">
                                באינסטגרם ↗
                              </a>
                            )}
                          </span>
                        </td>
                        <td class="num">{p.published_at ? formatWhen(p.published_at) : '-'}</td>
                        {p.error ? (
                          <td class="num muted" colSpan={7} title={p.error}>
                            אין נתונים לפוסט הזה
                          </td>
                        ) : (
                          <>
                            {(['reach', 'views', 'likes', 'comments', 'saved', 'shares'] as const).map((k) => (
                              <td key={k} class="num">
                                {p.metrics[k] === undefined ? '-' : whole.format(p.metrics[k]!)}
                              </td>
                            ))}
                            <td class="num strong">{pct(engagementRate(p))}</td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {overview.warnings.length > 0 && (
            <p class="muted small">
              נתונים ש-Meta לא החזירה: {overview.warnings.map((w) => w.split(':')[0]).join(', ')}
            </p>
          )}
          <p class="muted small">עודכן {new Date(overview.fetched_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })} · הנתונים נשמרים לשעה</p>
        </div>
      )}
    </div>
  );
}
