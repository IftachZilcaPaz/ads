import { useState } from 'preact/hooks';
import { isCampaignLive } from '../../shared/catalog.ts';
import { bucketOf, type Post } from '../../shared/post.ts';
import { localDate } from '../../shared/time.ts';
import { PostForm } from '../components/PostForm.tsx';
import { useApp } from '../state.tsx';
import { BUCKET_META, formatWhen } from '../ui.ts';

/**
 * Upload → pick campaign/product → let Claude draft the caption → schedule,
 * all on one page. Each save resets the form for the next post.
 */
export function Studio({ query }: { query: URLSearchParams }) {
  const { data } = useApp();
  const [round, setRound] = useState(0);
  const [last, setLast] = useState<Post | null>(null);

  if (!data) return null;
  const liveCampaigns = data.campaigns.filter((c) => isCampaignLive(c, localDate()));
  const brandMissing = !data.brand.voice && !data.brand.description;

  return (
    <div class="studio">
      <header class="page-head">
        <span class="eyebrow">סטודיו</span>
        <h1>
          תמונה, קפשן, <em>ולאישור</em>
        </h1>
        <p class="muted">מעלים תמונה, בוחרים קמפיין או מוצר, והעוזר כותב קפשן בקול של המותג. אתה מאשר - והוא עולה בזמן.</p>
      </header>

      {brandMissing && (
        <p class="notice">
          💡 כדי שהקפשנים יישמעו כמוך, מלא את <a href="#/brand">קול המותג</a> (פעם אחת).
        </p>
      )}
      {liveCampaigns.length > 0 && <p class="muted small">קמפיינים פעילים: {liveCampaigns.map((c) => c.name).join(' · ')}</p>}

      {last && (
        <div class="notice success">
          נשמר: {last.caption.slice(0, 60) || last.id}
          {' · '}
          {BUCKET_META[bucketOf(last) ?? 'draft'].title}
          {last.publish_at && ` · ${formatWhen(last.publish_at)}`} · <a href="#/board">ללוח</a>
        </div>
      )}

      <PostForm
        key={round}
        post={null}
        initial={{ campaign_id: query.get('campaign') ?? '', product_id: query.get('product') ?? '' }}
        layout="page"
        onDone={(post) => {
          setLast(post);
          setRound((r) => r + 1);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
      />
    </div>
  );
}
