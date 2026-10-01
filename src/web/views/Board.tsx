import { useEffect, useMemo, useState } from 'preact/hooks';
import { BUCKETS, bucketOf, type Bucket, type Post, type PostAction } from '../../shared/post.ts';
import { addDays, localDate, toLocal } from '../../shared/time.ts';
import { api } from '../api.ts';
import { FilterBar } from '../components/FilterBar.tsx';
import { PostCard } from '../components/PostCard.tsx';
import { PostEditor } from '../components/PostEditor.tsx';
import { usePostActions, usePostFilter } from '../hooks.ts';
import { Icon } from '../icons.tsx';
import { useApp } from '../state.tsx';
import { BUCKET_META, cx, formatWhen, greeting, pluralPosts } from '../ui.ts';

const DROP_TARGETS: Bucket[] = ['draft', 'awaiting', 'approved'];
/** Published history can be long; the board shows the most recent ones. */
const PUBLISHED_LIMIT = 30;

function sortFor(bucket: Bucket) {
  const asc = (a: Post, b: Post) => (a.publish_at || '9999').localeCompare(b.publish_at || '9999');
  return bucket === 'published' || bucket === 'problem' ? (a: Post, b: Post) => asc(b, a) : asc;
}

type BulkKind = PostAction | 'delete';

/** Bulk actions offered for a selection, in toolbar order. */
const BULK_ACTIONS: { kind: BulkKind; label: string; done: string; tone?: 'approve' | 'danger' }[] = [
  { kind: 'approve', label: '✅ אשר', done: 'אושרו', tone: 'approve' },
  { kind: 'draft', label: '↩ לטיוטות', done: 'הוחזרו לטיוטות' },
  { kind: 'archive', label: '🗄 ארכיון', done: 'הועברו לארכיון' },
  { kind: 'delete', label: '🗑 מחיקה', done: 'נמחקו', tone: 'danger' },
];

function confirmText(kind: BulkKind, count: number): string | null {
  const n = pluralPosts(count);
  if (kind === 'delete') return `למחוק לצמיתות ${n}? אי אפשר לשחזר.\nפוסט שכבר פורסם יימחק רק מהלוח, לא מאינסטגרם.`;
  if (kind === 'archive') return `להעביר ${n} לארכיון? הם יוסתרו מהלוח ולא יעלו.`;
  if (kind === 'approve') return `לאשר ${n}? הם יעלו אוטומטית במועד שנקבע.`;
  return null;
}

export function Board() {
  const { data, run, upsertPost, removePosts, toast } = useApp();
  const onAction = usePostActions();
  const { filter, setFilter, filtered } = usePostFilter(data?.posts ?? []);
  const [editing, setEditing] = useState<Post | null | undefined>(undefined);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

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

  // Only cards on the board can stay selected (a filter or a refresh may hide some).
  const visibleIds = useMemo(() => new Set(BUCKETS.flatMap((b) => columns[b].map((p) => p.id))), [columns]);
  const chosen = useMemo(() => [...selected].filter((id) => visibleIds.has(id)), [selected, visibleIds]);

  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && stopSelecting();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting]);

  const toggle = (post: Post) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(post.id)) next.add(post.id);
      return next;
    });
  const toggleColumn = (items: Post[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of items) {
        if (on) next.add(p.id);
        else next.delete(p.id);
      }
      return next;
    });

  /** Runs one action on many posts; the server applies what it can and reports the rest. */
  async function runBulk(kind: BulkKind, ids: string[]): Promise<boolean> {
    const ask = confirmText(kind, ids.length);
    if (!ids.length || (ask && !confirm(ask))) return false;
    setBusy(true);
    try {
      const done = BULK_ACTIONS.find((a) => a.kind === kind)!.done;
      if (kind === 'delete') {
        const res = await run(() => api.deletePosts(ids));
        if (!res) return false;
        removePosts(res.deleted);
        report(res.deleted.length, res.failed, done);
      } else {
        const res = await run(() => api.bulk(ids, kind));
        if (!res) return false;
        res.updated.forEach(upsertPost);
        report(res.updated.length, res.failed, done);
      }
      return true;
    } finally {
      setBusy(false);
    }
  }

  function report(ok: number, failed: { id: string; error: string }[], done: string) {
    if (!failed.length) return toast(`${done}: ${pluralPosts(ok)}`);
    alert(`${done}: ${ok}. לא בוצע ב-${failed.length}:\n${failed.map((f) => `• ${f.id}: ${f.error}`).join('\n')}`);
  }

  async function approveAll() {
    await runBulk('approve', columns.awaiting.map((p) => p.id));
  }

  if (!data) return null;

  return (
    <>
      <section class="hero">
        <div class="hero-text">
          <span class="eyebrow">{greeting()}</span>
          <h1>
            {summary.awaiting
              ? `${pluralPosts(summary.awaiting)} ${summary.awaiting === 1 ? 'מחכה' : 'מחכים'} לאישור שלך`
              : 'הכול מאושר ומתוזמן'}
          </h1>
          <p>{summary.next ? `הבא בתור: ${formatWhen(summary.next.publish_at)}` : 'אין כרגע פוסט מאושר בתור.'}</p>
          <a class="btn-3d" href="#/studio">
            <Icon name="plus" size={16} />
            פוסט חדש
          </a>
        </div>
        <div class="hero-art" aria-hidden="true">
          <span class="blob main">
            <Icon name="camera" size={56} />
          </span>
          <span class="blob spark">
            <Icon name="sparkles" size={26} />
          </span>
          <span class="blob send">
            <Icon name="send" size={22} />
          </span>
        </div>
      </section>

      <section class="summary">
        <div class="stat teal">
          <span class="tile">
            <Icon name="clock" size={22} />
          </span>
          <span class="stat-label">ממתינים לאישור</span>
          <strong>{summary.awaiting}</strong>
          <span class="stat-sub">בלוח או בטלגרם</span>
        </div>
        <div class="stat slate">
          <span class="tile">
            <Icon name="check" size={22} />
          </span>
          <span class="stat-label">מאושרים לשבוע</span>
          <strong>{summary.approvedWeek}</strong>
          <span class="stat-sub">יעלו אוטומטית</span>
        </div>
        <div class="stat ice">
          <span class="tile">
            <Icon name="send" size={22} />
          </span>
          <span class="stat-label">הבא בתור</span>
          <strong class="stat-when">{summary.next ? formatWhen(summary.next.publish_at) : '—'}</strong>
          <span class="stat-sub">{summary.next ? 'מאושר' : 'אין פוסט מאושר'}</span>
        </div>
        <div class={cx('stat', summary.problems ? 'violet bad' : 'violet')}>
          <span class="tile">
            <Icon name="alert" size={22} />
          </span>
          <span class="stat-label">דורשים טיפול</span>
          <strong>{summary.problems}</strong>
          <span class="stat-sub">{summary.problems ? 'נכשלו או נדחו' : 'הכול תקין'}</span>
        </div>
      </section>

      <FilterBar filter={filter} onChange={setFilter}>
        <button type="button" class={cx('select-toggle', selecting && 'on')} aria-pressed={selecting} onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
          {selecting ? 'סיום בחירה' : '☑ בחירה'}
        </button>
      </FilterBar>

      <div class={cx('board', selecting && 'selecting')}>
        {BUCKETS.map((bucket) => {
          const meta = BUCKET_META[bucket];
          const items = columns[bucket];
          const allOn = items.length > 0 && items.every((p) => selected.has(p.id));
          return (
            <section key={bucket} class="col" data-drop={DROP_TARGETS.includes(bucket) ? bucket : undefined}>
              <header class="col-head">
                <span class="dot" style={{ background: meta.color }} />
                <h2>{meta.title}</h2>
                <span class="count">{items.length}</span>
                {selecting && items.length > 0 && (
                  <button
                    type="button"
                    class="small nowrap"
                    aria-label={allOn ? `נקה את הבחירה ב${meta.title}` : `בחר את כל ${meta.title}`}
                    onClick={() => toggleColumn(items, !allOn)}
                  >
                    {allOn ? 'נקה' : 'הכל'}
                  </button>
                )}
                {!selecting && bucket === 'awaiting' && items.length > 1 && (
                  <button type="button" class="small approve" onClick={() => void approveAll()}>
                    אשר הכל
                  </button>
                )}
                {!selecting && bucket === 'draft' && (
                  <button type="button" class="small" onClick={() => setEditing(null)}>
                    + חדש
                  </button>
                )}
              </header>
              {meta.hint && <p class="col-hint">{meta.hint}</p>}
              <div class="col-body">
                {items.map((post) => (
                  <PostCard
                    key={post.id}
                    post={post}
                    onOpen={setEditing}
                    onAction={onAction}
                    selection={selecting ? { selected: selected.has(post.id), onToggle: toggle } : undefined}
                  />
                ))}
                {!items.length && <p class="empty">אין כאן כלום</p>}
              </div>
            </section>
          );
        })}
      </div>

      {selecting && (
        <div class="bulk-bar" role="toolbar" aria-label="פעולות על הנבחרים">
          <strong>{chosen.length ? `${chosen.length} נבחרו` : 'בחר פוסטים'}</strong>
          <div class="bulk-actions">
            {BULK_ACTIONS.map((a) => (
              <button
                key={a.kind}
                type="button"
                class={cx(a.tone === 'approve' && 'approve', a.tone === 'danger' && 'danger')}
                disabled={busy || !chosen.length}
                onClick={async () => (await runBulk(a.kind, chosen)) && stopSelecting()}
              >
                {a.label}
              </button>
            ))}
          </div>
          <button type="button" class="icon round" aria-label="ביטול בחירה" onClick={stopSelecting}>
            ✕
          </button>
        </div>
      )}

      {editing !== undefined && (
        <PostEditor
          post={editing && (data.posts.find((p) => p.id === editing.id) ?? editing)}
          onClose={() => setEditing(undefined)}
        />
      )}
    </>
  );
}
