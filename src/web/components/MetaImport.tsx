import { useEffect, useState } from 'preact/hooks';
import { OBJECTIVE_LABEL, type AdObjective } from '../../shared/campaign-plan.ts';
import { api, type MetaCampaignSummary } from '../api.ts';
import { useApp } from '../state.tsx';
import { cx } from '../ui.ts';
import { Modal } from './Modal.tsx';

const STATUS: Record<string, string> = { active: 'פעיל', paused: 'מושהה', ended: 'הסתיים' };
const ils = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

/** Picks campaigns from the Meta ad account and creates them here, already linked for insights. */
export function MetaImport({ onClose }: { onClose: () => void }) {
  const { run, upsertCampaign, toast } = useApp();
  const [list, setList] = useState<MetaCampaignSummary[] | null>(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .metaCampaigns()
      .then((items) => {
        setList(items);
        // Preselect what is still running and not imported yet.
        setPicked(new Set(items.filter((c) => !c.linked_to && c.status !== 'ended').map((c) => c.id)));
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  async function importPicked() {
    setBusy(true);
    const result = await run(() => api.importMetaCampaigns([...picked]));
    setBusy(false);
    if (!result) return;
    result.created.forEach((c) => upsertCampaign(c));
    toast(`יובאו ${result.created.length} קמפיינים${result.skipped.length ? ` (${result.skipped.length} כבר היו מקושרים)` : ''}`);
    onClose();
  }

  return (
    <Modal
      title="ייבוא קמפיינים מ-Meta"
      onClose={onClose}
      wide
      footer={
        <div class="actions">
          <button type="button" onClick={onClose}>
            ביטול
          </button>
          <button type="button" class="primary" disabled={busy || !picked.size} onClick={() => void importPicked()}>
            {busy ? 'מייבא...' : `ייבוא ${picked.size || ''}`}
          </button>
        </div>
      }
    >
      <p class="muted small">
        כל קמפיין שמיובא נוצר כאן עם התאריכים והסטטוס שלו, ומקושר ל-Meta: דף הקמפיין יציג את ההוצאה, החשיפות והתוצאות. אחר כך כדאי להשלים מסר, הצעה וקהל, כי ה-AI כותב לפיהם.
      </p>
      {!list && !error && (
        <p class="progress-note">
          <i class="spinner" /> טוען קמפיינים מחשבון המודעות...
        </p>
      )}
      {error && <p class="err">{error}</p>}
      {list && !list.length && <p class="empty">אין קמפיינים בחשבון המודעות.</p>}
      {list && list.length > 0 && (
        <ul class="import-list">
          {list.map((c) => (
            <li key={c.id} class={cx(c.linked_to && 'linked')}>
              <label class="check">
                <input type="checkbox" checked={!!c.linked_to || picked.has(c.id)} disabled={!!c.linked_to} onChange={() => toggle(c.id)} />
                <span class="import-main">
                  <strong>{c.name}</strong>
                  <span class="meta">
                    <span class={cx('badge', c.status === 'active' && 'ok')}>{STATUS[c.status]}</span>
                    {c.objective && <span class="tag">{OBJECTIVE_LABEL[c.objective as AdObjective] ?? c.objective}</span>}
                    {(c.start_date || c.end_date) && (
                      <span class="tag">
                        {c.start_date || '...'} ← {c.end_date || 'ללא סיום'}
                      </span>
                    )}
                    {c.daily_budget != null && <span class="tag">{ils.format(c.daily_budget)} ליום</span>}
                  </span>
                </span>
                {c.linked_to && <span class="badge accent">כבר מקושר</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
