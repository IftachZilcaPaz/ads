import { useEffect, useRef, useState } from 'preact/hooks';
import type { Campaign, Product } from '../../shared/catalog.ts';
import { composeCaption, type CaptionRequest, type CaptionResult } from '../../shared/captions.ts';
import type { PostType } from '../../shared/post.ts';
import { api } from '../api.ts';
import { useApp, useHoldRefresh } from '../state.tsx';
import { cx } from '../ui.ts';

interface Props {
  media: string[];
  type: PostType;
  campaign: Campaign | null;
  product: Product | null;
  currentCaption: string;
  onPick: (caption: string) => void;
}

const LENGTHS = [
  ['short', 'קצר'],
  ['medium', 'בינוני'],
  ['long', 'ארוך'],
] as const;

const QUICK_REFINES = ['קצר יותר', 'יותר מכירתי', 'יותר אישי וחם', 'תוסיף שאלה לקהל', 'hook חזק יותר', 'בלי אימוג׳ים'];

export function CaptionAssistant({ media, type, campaign, product, currentCaption, onPick }: Props) {
  const { data, toast } = useApp();
  const [brief, setBrief] = useState('');
  const [length, setLength] = useState<'short' | 'medium' | 'long'>('medium');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [chars, setChars] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<CaptionResult | null>(null);
  const abort = useRef<AbortController | null>(null);
  useHoldRefresh(busy);

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [busy]);

  useEffect(() => () => abort.current?.abort(), []);

  /** Recent published captions teach the model the account's voice; same campaign first. */
  function styleExamples(): string[] {
    const published = (data?.posts ?? []).filter((p) => p.status === 'published' && p.caption.trim().length > 40);
    const ranked = [
      ...published.filter((p) => campaign && p.campaign_id === campaign.id),
      ...published.filter((p) => !campaign || p.campaign_id !== campaign.id),
    ];
    return ranked
      .sort((a, b) => (b.publish_at > a.publish_at ? 1 : -1))
      .slice(0, 4)
      .map((p) => p.caption.slice(0, 1200));
  }

  async function generate(refineWith?: string) {
    if (!data) return;
    if (!media.length) return toast('קודם מעלים תמונה או וידאו', 'warn');
    const req: CaptionRequest = {
      media,
      post_type: type,
      brief,
      campaign,
      product,
      brand: data.brand,
      examples: styleExamples(),
      variants: refineWith ? 2 : 3,
      length,
      refine: refineWith ? { caption: currentCaption, instruction: refineWith } : null,
    };
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setChars(0);
    setElapsed(0);
    try {
      setResult(await api.captions(req, setChars, controller.signal));
    } catch (err) {
      if (!controller.signal.aborted) toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      if (abort.current === controller) setBusy(false);
    }
  }

  return (
    <section class="assistant">
      <div class="assistant-head">
        <strong>✨ עוזר הקפשנים</strong>
        <span class="muted">
          {[campaign && `קמפיין: ${campaign.name}`, product && `מוצר: ${product.name}`].filter(Boolean).join(' · ') ||
            'בחר קמפיין/מוצר כדי לדייק'}
        </span>
      </div>

      <label class="field">
        <span>מה חשוב להגיד? (בריף קצר, לא חובה)</span>
        <textarea
          rows={2}
          value={brief}
          placeholder="למשל: לפני/אחרי שיפוץ מטבח בגבעתיים, להדגיש שעמדנו בלו״ז"
          onInput={(e) => setBrief(e.currentTarget.value)}
        />
      </label>

      <div class="row wrap">
        <div class="segmented" role="radiogroup" aria-label="אורך">
          {LENGTHS.map(([key, label]) => (
            <button type="button" key={key} class={cx(length === key && 'on')} onClick={() => setLength(key)}>
              {label}
            </button>
          ))}
        </div>
        <button type="button" class="primary" disabled={busy || !media.length} onClick={() => void generate()}>
          {busy ? 'כותב...' : result ? '✨ עוד גרסאות' : '✨ כתוב לי קפשן'}
        </button>
        {busy && (
          <button type="button" onClick={() => abort.current?.abort()}>
            ביטול
          </button>
        )}
      </div>

      {busy && (
        <div class="progress-note">
          <span class="spinner" /> מסתכל על התמונה וכותב... {elapsed}ש׳{chars > 0 && ` · ${chars} תווים`}
        </div>
      )}

      {currentCaption.trim() && (
        <div class="refine">
          <span class="muted">שיפור הקפשן הנוכחי:</span>
          <div class="chips">
            {QUICK_REFINES.map((q) => (
              <button type="button" key={q} class="chip" disabled={busy} onClick={() => void generate(q)}>
                {q}
              </button>
            ))}
          </div>
          <div class="inline-form">
            <input
              value={instruction}
              placeholder="הנחיה חופשית, למשל: להזכיר שהמבצע עד סוף החודש"
              onInput={(e) => setInstruction(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && instruction.trim() && (e.preventDefault(), void generate(instruction.trim()))}
            />
            <button type="button" disabled={busy || !instruction.trim()} onClick={() => void generate(instruction.trim())}>
              שכתב
            </button>
          </div>
        </div>
      )}

      {result && (
        <div class="variants">
          {result.image_notes && <p class="muted small">👁 {result.image_notes}</p>}
          {result.variants.map((v, i) => {
            const full = composeCaption(v);
            return (
              <article key={i} class="variant">
                <header>
                  <span class="badge">{v.angle}</span>
                  <span class="muted small">{full.length} תווים</span>
                </header>
                <p class="variant-text">{v.caption}</p>
                {v.hashtags.length > 0 && <p class="variant-tags">{v.hashtags.map((h) => `#${h}`).join(' ')}</p>}
                {v.why && <p class="muted small">💡 {v.why}</p>}
                <button type="button" class="primary" onClick={() => onPick(full)}>
                  השתמש בגרסה הזו
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
