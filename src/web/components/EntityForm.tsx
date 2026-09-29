import { useState } from 'preact/hooks';

export interface FieldSpec<T> {
  key: keyof T & string;
  label: string;
  kind?: 'text' | 'textarea' | 'date' | 'select' | 'url';
  options?: readonly (readonly [string, string])[];
  placeholder?: string;
  hint?: string;
  /** Spans the full row in the two-column grid. */
  wide?: boolean;
}

interface Props<T> {
  fields: FieldSpec<T>[];
  value: T;
  onSubmit: (value: T) => Promise<void>;
  submitLabel?: string;
}

/** Declarative form used for campaigns, products and the brand voice. */
export function EntityForm<T extends Record<string, string>>({ fields, value, onSubmit, submitLabel = 'שמירה' }: Props<T>) {
  const [draft, setDraft] = useState<T>(value);
  const [saving, setSaving] = useState(false);
  const set = (key: string, v: string) => setDraft((d) => ({ ...d, [key]: v }));

  return (
    <form
      class="entity-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await onSubmit(draft);
        } finally {
          setSaving(false);
        }
      }}
    >
      <div class="grid2">
        {fields.map((f) => (
          <label key={f.key} class={f.wide || f.kind === 'textarea' ? 'field wide' : 'field'}>
            <span>{f.label}</span>
            {f.kind === 'textarea' ? (
              <textarea rows={3} value={draft[f.key] ?? ''} placeholder={f.placeholder} onInput={(e) => set(f.key, e.currentTarget.value)} />
            ) : f.kind === 'select' ? (
              <select value={draft[f.key] ?? ''} onChange={(e) => set(f.key, e.currentTarget.value)}>
                {f.options!.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={f.kind === 'date' ? 'date' : f.kind === 'url' ? 'url' : 'text'}
                dir={f.kind === 'url' || f.kind === 'date' ? 'ltr' : undefined}
                value={draft[f.key] ?? ''}
                placeholder={f.placeholder}
                onInput={(e) => set(f.key, e.currentTarget.value)}
              />
            )}
            {f.hint && <small class="muted">{f.hint}</small>}
          </label>
        ))}
      </div>
      <div class="actions">
        <button type="submit" class="primary" disabled={saving}>
          {saving ? 'שומר...' : submitLabel}
        </button>
      </div>
    </form>
  );
}
