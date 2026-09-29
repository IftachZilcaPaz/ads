import { useMemo, useState } from 'preact/hooks';
import { BUCKETS, bucketOf, type Bucket, type Post } from '../../shared/post.ts';
import { addDays, localDate, toLocal } from '../../shared/time.ts';
import { api } from '../api.ts';
import { FilterBar } from '../components/FilterBar.tsx';
import { PostCard } from '../components/PostCard.tsx';
import { PostEditor } from '../components/PostEditor.tsx';
import { usePostActions, usePostFilter } from '../hooks.ts';
import { useApp } from '../state.tsx';
import { BUCKET_META, formatWhen, pluralPosts } from '../ui.ts';

const DROP_TARGETS: Bucket[] = ['draft', 'awaiting', 'approved'];
/** Published history can be long; the board shows the most recent ones. */
const PUBLISHED_LIMIT = 30;

function sortFor(bucket: Bucket) {
  const asc = (a: Post, b: Post) => (a.publish_at || '9999').localeCompare(b.publish_at || '9999');
  return bucket === 'published' || bucket === 'problem' ? (a: Post, b: Post) => asc(b, a) : asc;
}

export function Board() {
  const { data, run, upsertPost } = useApp();
  const onAction = usePostActions();
  const { filter, setFilter, filtered } = usePostFilter(data?.posts ?? []);
  const [editing, setEditing] = useState<Post | null | undefined>(undefined);

  const columns = useMemo(() => {
    const groups = Object.fromEntries(BUCKETS.map((b) => [b, [] as Post[]])) as Record<Bucket, Post[]>;
    for (const post of filtered) {
      const b = bucketOf(post);
      if (b) groups[b].push(post);
    }
    for (const b of BUCKETS) groups[b].sort(sortFor(b));
    groups.published = groups.published.slice(0, PUBLISHED_LIMIT);
    return groups;
  }, [filtered]);

  const summary = useMemo(() => {
    const now = toLocal();
    const weekEnd = `${addDays(localDate(), 7)} 23:59`;
    const upcoming = columns.approved.filter((p) => p.publish_at >= now);
    return {
      awaiting: columns.awaiting.length,
      approvedWeek: upcoming.filter((p) => p.publish_at <= weekEnd).length,
      next: upcoming[0],
      problems: columns.problem.length,
    };
  }, [columns]);

  async function approveAll() {
    const ids = columns.awaiting.map((p) => p.id);
    if (!ids.length || !confirm(`לאשר ${pluralPosts(ids.length)}? הם יעלו אוטומטית במועד שנקבע.`)) return;
    const res = await run(() => api.bulk(ids, 'approve'));
    if (!res) return;
    res.updated.forEach(upsertPost);
    if (res.failed.length) {
      alert(`אושרו ${res.updated.length}. לא אושרו:\n${res.failed.map((f) => `• ${f.id}: ${f.error}`).join('\n')}`);
    }
  }

  if (!data) return null;

  return (
    <>
      <section class="summary">
        <div class="stat">
          <strong>{summary.awaiting}</strong>
          <span>ממתינים לאישור שלך</span>
        </div>
        <div class="stat">
          <strong>{summary.approvedWeek}</strong>
          <span>מאושרים ל-7 ימים</span>
        </div>
        <div class="stat wide">
          <strong>{summary.next ? formatWhen(summary.next.publish_at) : '—'}</strong>
          <span>{summary.next ? 'הפוסט המאושר הבא' : 'אין פוסט מאושר בתור'}</span>
        </div>
        {summary.problems > 0 && (
          <div class="stat bad">
            <strong>{summary.problems}</strong>
            <span>דורשים טיפול</span>
          </div>
        )}
      </section>

      <FilterBar filter={filter} onChange={setFilter} />

      <div class="board">
        {BUCKETS.map((bucket) => {
          const meta = BUCKET_META[bucket];
          const items = columns[bucket];
          return (
            <section key={bucket} class="col" data-drop={DROP_TARGETS.includes(bucket) ? bucket : undefined}>
              <header class="col-head">
                <span class="dot" style={{ background: meta.color }} />
                <h2>{meta.title}</h2>
                <span class="count">{items.length}</span>
                {bucket === 'awaiting' && items.length > 1 && (
                  <button type="button" class="small approve" onClick={() => void approveAll()}>
                    אשר הכל
                  </button>
                )}
                {bucket === 'draft' && (
                  <button type="button" class="small" onClick={() => setEditing(null)}>
                    + חדש
                  </button>
                )}
              </header>
              {meta.hint && <p class="col-hint">{meta.hint}</p>}
              <div class="col-body">
                {items.map((post) => (
                  <PostCard key={post.id} post={post} onOpen={setEditing} onAction={onAction} />
                ))}
                {!items.length && <p class="empty">אין כאן כלום</p>}
              </div>
            </section>
          );
        })}
      </div>

      {editing !== undefined && (
        <PostEditor
          post={editing && (data.posts.find((p) => p.id === editing.id) ?? editing)}
          onClose={() => setEditing(undefined)}
        />
      )}
    </>
  );
}
