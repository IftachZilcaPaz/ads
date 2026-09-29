import { useMemo, useState } from 'preact/hooks';
import {
  EDITABLE_FIELDS,
  IG_LIMITS,
  POST_TYPES,
  bucketOf,
  canEdit,
  countHashtags,
  isVideoUrl,
  mediaList,
  scheduleIssues,
  type Post,
  type PostAction,
  type PostChanges,
  type PostType,
} from '../../shared/post.ts';
import { addDays, addMinutesLocal, localDate, toLocal } from '../../shared/time.ts';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { BUCKET_META, TYPE_LABEL, cx } from '../ui.ts';
import { CaptionAssistant } from './CaptionAssistant.tsx';
import { MediaField } from './MediaField.tsx';

interface Props {
  post: Post | null;
  /** Prefill for new posts (e.g. the calendar day that was clicked). */
  initial?: Partial<Post>;
  onDone: (post: Post) => void;
  layout?: 'modal' | 'page';
}

interface FormState {
  date: string;
  time: string;
  type: PostType;
  media: string[];
  caption: string;
  auto: boolean;
  campaign_id: string;
  product_id: string;
  notes: string;
}

function fromPost(p: Partial<Post> | null | undefined): FormState {
  const [date = '', time = ''] = (p?.publish_at ?? '').split(' ');
  return {
    date,
    time: time || '19:00',
    type: ((p?.type as PostType) || 'POST') as PostType,
    media: p?.media_urls ? mediaList({ media_urls: p.media_urls }) : [],
    caption: p?.caption ?? '',
    auto: p?.approval_mode === 'auto',
    campaign_id: p?.campaign_id ?? '',
    product_id: p?.product_id ?? '',
    notes: p?.notes ?? '',
  };
}

function toFields(f: FormState): Required<PostChanges> {
  return {
    publish_at: f.date ? `${f.date} ${f.time}` : '',
    type: f.type,
    media_urls: f.media.join(','),
    caption: f.caption,
    approval_mode: f.auto ? 'auto' : 'approve',
    campaign_id: f.campaign_id,
    product_id: f.product_id,
    notes: f.notes,
  };
}

function suggestType(media: string[]): PostType {
  if (media.length > 1) return 'CAROUSEL';
  if (media.length === 1 && isVideoUrl(media[0]!)) return 'REEL';
  return 'POST';
}

export function PostForm({ post, initial, onDone, layout = 'modal' }: Props) {
  const { data, run, upsertPost } = useApp();
  const [form, setForm] = useState<FormState>(() => fromPost(post ?? initial));
  const [typeTouched, setTypeTouched] = useState(!!post);
  const [showAssistant, setShowAssistant] = useState(layout === 'page' || !post?.caption);
  const [saving, setSaving] = useState(false);

  const editable = !post || canEdit(post);
  const bucket = post ? bucketOf(post) : null;
  const fields = toFields(form);
  const issues = useMemo(() => scheduleIssues(fields), [fields.publish_at, fields.type, fields.media_urls, fields.caption]);
  const campaigns = (data?.campaigns ?? []).filter((c) => c.status !== 'ended' || c.id === form.campaign_id);
  const products = (data?.products ?? []).filter((p) => p.status === 'active' || p.id === form.product_id);
  const campaign = data?.campaigns.find((c) => c.id === form.campaign_id) ?? null;
  const product = data?.products.find((p) => p.id === form.product_id) ?? null;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  function setMedia(media: string[]) {
    setForm((f) => ({ ...f, media, type: typeTouched ? f.type : suggestType(media) }));
  }

  function setWhen(local: string) {
    const [date, time] = local.split(' ') as [string, string];
    setForm((f) => ({ ...f, date, time }));
  }

  async function submit(action: PostAction | null) {
    setSaving(true);
    const saved = await run(async () => {
      if (!post) {
        const intent = action === 'approve' || action === 'submit' ? action : 'draft';
        return api.createPost({ ...fields, intent });
      }
      const changes: PostChanges = {};
      for (const key of EDITABLE_FIELDS) if (fields[key] !== post[key]) changes[key] = fields[key];
      let result = Object.keys(changes).length ? await api.editPost(post.id, changes) : post;
      if (action) result = await api.act(post.id, action);
      return result;
    }, successMessage(action, !post));
    setSaving(false);
    if (saved) {
      upsertPost(saved);
      onDone(saved);
    }
  }

  const needsSchedule = issues.length > 0;
  const contentChanged = !!post && bucket === 'approved' && (['caption', 'media_urls', 'type'] as const).some((k) => fields[k] !== post[k]);

  return (
    <div class={cx('post-form', `layout-${layout}`)}>
      <div class="form-media">
        <MediaField value={form.media} onChange={setMedia} disabled={!editable} large={layout === 'page'} />
      </div>

      <div class="form-main">
        {post && (
          <div class="status-line">
            {bucket && (
              <span class="badge" style={{ background: BUCKET_META[bucket].color, color: '#fff' }}>
                {BUCKET_META[bucket].title}
              </span>
            )}
            {post.status === 'pending_approval' && <span class="badge">נשלחה בקשת אישור בטלגרם</span>}
            {post.error && <span class="err">{post.error}</span>}
            {post.permalink && (
              <a href={post.permalink} target="_blank" rel="noopener noreferrer">
                לפוסט באינסטגרם ↗
              </a>
            )}
          </div>
        )}

        <div class="grid2">
          <label class="field">
            <span>סוג</span>
            <select
              value={form.type}
              disabled={!editable}
              onChange={(e) => {
                setTypeTouched(true);
                set('type', e.currentTarget.value as PostType);
              }}
            >
              {POST_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            <span>קמפיין</span>
            <select value={form.campaign_id} disabled={!editable} onChange={(e) => set('campaign_id', e.currentTarget.value)}>
              <option value="">ללא</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            <span>מוצר</span>
            <select value={form.product_id} disabled={!editable} onChange={(e) => set('product_id', e.currentTarget.value)}>
              <option value="">ללא</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {editable && (
          <div class="assistant-toggle">
            <button type="button" class={cx('link', showAssistant && 'on')} onClick={() => setShowAssistant((s) => !s)}>
              {showAssistant ? 'הסתר עוזר קפשנים' : '✨ עזרה בכתיבת הקפשן'}
            </button>
          </div>
        )}
        {editable && showAssistant && (
          <CaptionAssistant
            media={form.media}
            type={form.type}
            campaign={campaign}
            product={product}
            currentCaption={form.caption}
            onPick={(c) => set('caption', c)}
          />
        )}

        <label class="field">
          <span class="field-head">
            קפשן
            <span class={cx('counter', form.caption.length > IG_LIMITS.captionChars && 'over')}>
              {form.caption.length}/{IG_LIMITS.captionChars} · {countHashtags(form.caption)}/{IG_LIMITS.hashtags} #
            </span>
          </span>
          <textarea
            rows={layout === 'page' ? 10 : 7}
            value={form.caption}
            disabled={!editable}
            placeholder="הטקסט המלא כולל האשטגים"
            onInput={(e) => set('caption', e.currentTarget.value)}
          />
        </label>

        <div class="grid2">
          <label class="field">
            <span>תאריך (שעון ישראל)</span>
            <input type="date" dir="ltr" value={form.date} disabled={!editable} onInput={(e) => set('date', e.currentTarget.value)} />
          </label>
          <label class="field">
            <span>שעה</span>
            <input type="time" dir="ltr" step={300} value={form.time} disabled={!editable} onInput={(e) => set('time', e.currentTarget.value)} />
          </label>
        </div>
        {editable && (
          <div class="chips">
            <button type="button" class="chip" onClick={() => setWhen(addMinutesLocal(toLocal(), 20))}>
              בעוד 20 דק׳
            </button>
            <button type="button" class="chip" onClick={() => setWhen(`${localDate()} 19:00`)}>
              היום 19:00
            </button>
            <button type="button" class="chip" onClick={() => setWhen(`${addDays(localDate(), 1)} 09:00`)}>
              מחר 09:00
            </button>
            <button type="button" class="chip" onClick={() => setWhen(`${addDays(localDate(), 1)} 19:00`)}>
              מחר 19:00
            </button>
          </div>
        )}

        <label class="check">
          <input type="checkbox" checked={form.auto} disabled={!editable} onChange={(e) => set('auto', e.currentTarget.checked)} />
          <span>
            <strong>אישור קבוע</strong> - לפרסם בזמן גם בלי אישור נפרד (לתוכן שגרתי בלבד)
          </span>
        </label>

        <label class="field">
          <span>הערות פנימיות</span>
          <input value={form.notes} disabled={!editable} onInput={(e) => set('notes', e.currentTarget.value)} />
        </label>

        {editable && needsSchedule && (
          <ul class="issues">
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
        {contentChanged && <p class="warn-note">⚠️ שינוי בתוכן יבטל את האישור - תצטרך לאשר שוב.</p>}

        {editable && (
          <div class="actions">
            {actionsFor(post, bucket).map(({ action, label, primary }) => (
              <button
                key={label}
                type="button"
                class={cx(primary && 'primary', action === 'approve' && 'approve')}
                disabled={saving || ((action === 'approve' || action === 'submit') && needsSchedule)}
                onClick={() => void submit(action)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function actionsFor(post: Post | null, bucket: ReturnType<typeof bucketOf>) {
  type A = { action: PostAction | null; label: string; primary?: boolean };
  if (!post) {
    return [
      { action: null, label: 'שמירה כטיוטה' },
      { action: 'submit', label: 'לאישור שלי' },
      { action: 'approve', label: '✅ אשר ותזמן', primary: true },
    ] satisfies A[];
  }
  switch (bucket) {
    case 'draft':
      return [
        { action: null, label: 'שמירה' },
        { action: 'submit', label: 'שמירה ולאישור שלי' },
        { action: 'approve', label: '✅ שמירה ואישור', primary: true },
      ] satisfies A[];
    case 'awaiting':
      return [
        { action: null, label: 'שמירה' },
        { action: 'approve', label: '✅ שמירה ואישור', primary: true },
      ] satisfies A[];
    case 'approved':
      return [{ action: null, label: 'שמירה', primary: true }] satisfies A[];
    default:
      return [
        { action: 'draft', label: 'שמירה כטיוטה' },
        { action: 'approve', label: '✅ אישור מחדש', primary: true },
      ] satisfies A[];
  }
}

function successMessage(action: PostAction | null, isNew: boolean): string {
  if (action === 'approve') return 'אושר ותוזמן ✅';
  if (action === 'submit') return 'ממתין לאישור שלך';
  if (action === 'draft') return 'הוחזר לטיוטות';
  return isNew ? 'נשמר כטיוטה' : 'נשמר';
}
