import { useMemo, useState } from 'preact/hooks';
import {
  CAMPAIGN_COLUMNS,
  PRODUCT_COLUMNS,
  isCampaignLive,
  type Campaign,
  type Product,
} from '../../shared/catalog.ts';
import { bucketOf, type Bucket } from '../../shared/post.ts';
import { localDate } from '../../shared/time.ts';
import { api } from '../api.ts';
import { EntityForm, type FieldSpec } from '../components/EntityForm.tsx';
import { Modal } from '../components/Modal.tsx';
import { useApp } from '../state.tsx';
import { BUCKET_META, cx } from '../ui.ts';

type Tab = 'campaigns' | 'products';
type Row = Record<string, string>;

const ID_HINT = 'אותיות אנגליות קטנות/ספרות. אפשר לכתוב #המזהה בטלגרם כדי לשייך תמונה';

const CAMPAIGN_FIELDS: FieldSpec<Row>[] = [
  { key: 'name', label: 'שם הקמפיין', placeholder: 'למשל: מבצע חגים' },
  { key: 'id', label: 'מזהה קצר (לא חובה)', placeholder: 'holidays', hint: ID_HINT },
  { key: 'status', label: 'סטטוס', kind: 'select', options: [['active', 'פעיל'], ['paused', 'מושהה'], ['ended', 'הסתיים']] },
  { key: 'cta', label: 'קריאה לפעולה', placeholder: 'שלחו הודעה לתיאום' },
  { key: 'start_date', label: 'התחלה', kind: 'date' },
  { key: 'end_date', label: 'סיום', kind: 'date' },
  { key: 'goal', label: 'מטרה', kind: 'textarea', placeholder: 'לידים לשיפוץ מטבחים לפני החגים' },
  { key: 'audience', label: 'קהל יעד', kind: 'textarea' },
  { key: 'key_message', label: 'מסר מרכזי', kind: 'textarea' },
  { key: 'offer', label: 'הצעה / מבצע', kind: 'textarea', hint: 'ה-AI לא ימציא מבצעים שלא כתובים כאן' },
  { key: 'tone', label: 'טון מיוחד לקמפיין', wide: true },
  { key: 'hashtags', label: 'האשטגים קבועים', wide: true, placeholder: '#שיפוץ #מטבח' },
  { key: 'link', label: 'קישור', kind: 'url', wide: true },
  { key: 'notes', label: 'הערות', kind: 'textarea' },
];

const PRODUCT_FIELDS: FieldSpec<Row>[] = [
  { key: 'name', label: 'שם המוצר / השירות' },
  { key: 'id', label: 'מזהה קצר (לא חובה)', hint: ID_HINT },
  { key: 'category', label: 'קטגוריה' },
  { key: 'price', label: 'מחיר', placeholder: 'החל מ-₪...' },
  { key: 'status', label: 'סטטוס', kind: 'select', options: [['active', 'פעיל'], ['archived', 'בארכיון']] },
  { key: 'url', label: 'קישור', kind: 'url' },
  { key: 'description', label: 'תיאור', kind: 'textarea' },
  { key: 'benefits', label: 'יתרונות מרכזיים', kind: 'textarea' },
  { key: 'hashtags', label: 'האשטגים', wide: true },
  { key: 'notes', label: 'הערות', kind: 'textarea' },
];

const COUNTED: Bucket[] = ['awaiting', 'approved', 'published'];

function blank(columns: readonly string[]): Row {
  return Object.fromEntries(columns.map((c) => [c, ''])) as Row;
}

export function Library() {
  const { data, run, upsertCampaign, upsertProduct } = useApp();
  const [tab, setTab] = useState<Tab>('campaigns');
  const [editing, setEditing] = useState<Row | null>(null);

  const counts = useMemo(() => {
    const map = new Map<string, Partial<Record<Bucket, number>>>();
    for (const post of data?.posts ?? []) {
      const b = bucketOf(post);
      if (!b) continue;
      for (const key of [post.campaign_id && `c:${post.campaign_id}`, post.product_id && `p:${post.product_id}`]) {
        if (!key) continue;
        const entry = map.get(key) ?? {};
        entry[b] = (entry[b] ?? 0) + 1;
        map.set(key, entry);
      }
    }
    return map;
  }, [data?.posts]);

  if (!data) return null;
  const today = localDate();
  const isCampaigns = tab === 'campaigns';
  const items: Row[] = isCampaigns ? data.campaigns : data.products;

  async function save(value: Row) {
    const original = editing?.id || undefined;
    if (isCampaigns) {
      const saved = await run(() => api.saveCampaign(value as Partial<Campaign>, original), 'נשמר');
      if (saved) upsertCampaign(saved, original);
      if (saved) setEditing(null);
    } else {
      const saved = await run(() => api.saveProduct(value as Partial<Product>, original), 'נשמר');
      if (saved) upsertProduct(saved, original);
      if (saved) setEditing(null);
    }
  }

  return (
    <div class="library">
      <header class="page-head">
        <span class="eyebrow">ספרייה</span>
        <h1>
          קמפיינים <em>ומוצרים</em>
        </h1>
      </header>
      <div class="toolbar">
        <div class="segmented">
          <button type="button" class={cx(isCampaigns && 'on')} onClick={() => setTab('campaigns')}>
            📣 קמפיינים ({data.campaigns.length})
          </button>
          <button type="button" class={cx(!isCampaigns && 'on')} onClick={() => setTab('products')}>
            🏷 מוצרים ({data.products.length})
          </button>
        </div>
        <button type="button" class="primary" onClick={() => setEditing(blank(isCampaigns ? CAMPAIGN_COLUMNS : PRODUCT_COLUMNS))}>
          + {isCampaigns ? 'קמפיין' : 'מוצר'} חדש
        </button>
      </div>

      {!items.length && (
        <p class="empty big">
          {isCampaigns
            ? 'עוד אין קמפיינים. קמפיין נותן ל-AI הקשר: מטרה, מסר, הצעה והאשטגים.'
            : 'עוד אין מוצרים. מוצר עם תיאור ויתרונות עוזר ל-AI לכתוב בדיוק על מה שבתמונה.'}
        </p>
      )}

      <div class="entity-grid">
        {items.map((item) => {
          const c = counts.get(`${isCampaigns ? 'c' : 'p'}:${item.id}`) ?? {};
          const live = isCampaigns && isCampaignLive(item as Campaign, today);
          return (
            <article key={item.id} class="entity-card" onClick={() => setEditing({ ...item })}>
              <header>
                <h3>{item.name}</h3>
                {isCampaigns ? (
                  <span class={cx('badge', live && 'ok')}>{live ? 'פעיל עכשיו' : item.status === 'active' ? 'מתוכנן' : item.status === 'paused' ? 'מושהה' : 'הסתיים'}</span>
                ) : (
                  item.price && <span class="badge">{item.price}</span>
                )}
              </header>
              <p class="muted small ltr-id">#{item.id}</p>
              {isCampaigns && (item.start_date || item.end_date) && (
                <p class="small">
                  {item.start_date || '...'} ← {item.end_date || '...'}
                </p>
              )}
              <p class="entity-desc">{isCampaigns ? item.key_message || item.goal : item.description}</p>
              <footer class="counts">
                {COUNTED.map((b) => (
                  <span key={b} title={BUCKET_META[b].title}>
                    <i class="dot" style={{ background: BUCKET_META[b].color }} /> {c[b] ?? 0}
                  </span>
                ))}
                <a
                  href={`#/studio?${isCampaigns ? 'campaign' : 'product'}=${encodeURIComponent(item.id!)}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  ✨ פוסט חדש
                </a>
              </footer>
            </article>
          );
        })}
      </div>

      {editing && (
        <Modal
          title={editing.id ? `עריכה · ${editing.name}` : isCampaigns ? 'קמפיין חדש' : 'מוצר חדש'}
          onClose={() => setEditing(null)}
          wide
        >
          <EntityForm
            key={editing.id || 'new'}
            fields={isCampaigns ? CAMPAIGN_FIELDS : PRODUCT_FIELDS}
            value={{ ...blank(isCampaigns ? CAMPAIGN_COLUMNS : PRODUCT_COLUMNS), ...editing, status: editing.status || 'active' }}
            onSubmit={save}
          />
        </Modal>
      )}
    </div>
  );
}
