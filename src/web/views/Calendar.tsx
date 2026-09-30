import { useMemo, useState } from 'preact/hooks';
import { bucketOf, mediaList, type Post, type PostType } from '../../shared/post.ts';
import { addDays, localDate, weekStart } from '../../shared/time.ts';
import { FilterBar } from '../components/FilterBar.tsx';
import { PostEditor } from '../components/PostEditor.tsx';
import { usePostFilter } from '../hooks.ts';
import { useApp } from '../state.tsx';
import { BUCKET_META, TYPE_LABEL, WEEKDAY_HEADERS, cx, thumbUrl, weekday } from '../ui.ts';

const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

export function Calendar() {
  const { data } = useApp();
  const today = localDate();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [editing, setEditing] = useState<{ post: Post | null; initial?: Partial<Post> } | null>(null);
  const { filter, setFilter, filtered } = usePostFilter(data?.posts ?? []);

  const byDay = useMemo(() => {
    const map = new Map<string, Post[]>();
    for (const post of filtered) {
      if (!post.publish_at || !bucketOf(post)) continue;
      const day = post.publish_at.slice(0, 10);
      map.set(day, [...(map.get(day) ?? []), post]);
    }
    for (const list of map.values()) list.sort((a, b) => a.publish_at.localeCompare(b.publish_at));
    return map;
  }, [filtered]);

  const days = useMemo(() => {
    const first = weekStart(`${month}-01`);
    return Array.from({ length: 42 }, (_, i) => addDays(first, i));
  }, [month]);

  const unscheduled = filtered.filter((p) => !p.publish_at && bucketOf(p) === 'draft');
  const [y, m] = month.split('-').map(Number) as [number, number];

  if (!data) return null;

  return (
    <>
      <header class="page-head">
        <span class="eyebrow">יומן</span>
        <h1>
          החודש <em>במבט אחד</em>
        </h1>
      </header>
      <div class="cal-toolbar">
        <button type="button" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="החודש הקודם">
          →
        </button>
        <h2>
          {MONTHS[m - 1]} {y}
        </h2>
        <button type="button" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="החודש הבא">
          ←
        </button>
        <button type="button" onClick={() => setMonth(today.slice(0, 7))}>
          היום
        </button>
        <div class="legend">
          {(['awaiting', 'approved', 'published', 'draft'] as const).map((b) => (
            <span key={b}>
              <i class="dot" style={{ background: BUCKET_META[b].color }} /> {BUCKET_META[b].title}
            </span>
          ))}
        </div>
      </div>
      <FilterBar filter={filter} onChange={setFilter} />

      <div class="calendar">
        {WEEKDAY_HEADERS.map((d) => (
          <div key={d} class="cal-head">
            {d}
          </div>
        ))}
        {days.map((day) => {
          const posts = byDay.get(day) ?? [];
          const outside = !day.startsWith(month);
          return (
            <div key={day} class={cx('cal-day', outside && 'outside', day === today && 'today', !posts.length && 'empty-day')}>
              <div class="cal-date">
                <span class="cal-weekday">{weekday(day)}</span>
                {Number(day.slice(8))}
                {day >= today && (
                  <button
                    type="button"
                    class="icon add"
                    aria-label="פוסט חדש ביום הזה"
                    onClick={() => setEditing({ post: null, initial: { publish_at: `${day} 19:00` } })}
                  >
                    +
                  </button>
                )}
              </div>
              {posts.map((post) => {
                const bucket = bucketOf(post)!;
                const thumb = mediaList(post)[0];
                return (
                  <button
                    type="button"
                    key={post.id}
                    class="cal-post"
                    style={{ borderInlineStartColor: BUCKET_META[bucket].color }}
                    title={`${BUCKET_META[bucket].title} · ${post.caption.slice(0, 120)}`}
                    onClick={() => setEditing({ post })}
                  >
                    {thumb && <img src={thumbUrl(thumb, 96)} alt="" loading="lazy" />}
                    <span class="cal-time">{post.publish_at.slice(11)}</span>
                    <span class="cal-type">{TYPE_LABEL[post.type as PostType] ?? post.type}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {unscheduled.length > 0 && (
        <section class="unscheduled">
          <h3>טיוטות בלי מועד ({unscheduled.length})</h3>
          <div class="chips">
            {unscheduled.map((p) => (
              <button type="button" key={p.id} class="chip" onClick={() => setEditing({ post: p })}>
                {p.caption.slice(0, 40) || p.id}
              </button>
            ))}
          </div>
        </section>
      )}

      {editing && <PostEditor post={editing.post} initial={editing.initial} onClose={() => setEditing(null)} />}
    </>
  );
}
